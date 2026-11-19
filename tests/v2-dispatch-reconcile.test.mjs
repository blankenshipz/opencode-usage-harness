import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStaleReconciler } from '../plugins/v2/dispatch-reconcile.mjs';
import { createDispatchCanceller } from '../plugins/v2/task-dispatch-cancel.mjs';
import { createResultDelivery } from '../plugins/v2/result-delivery.mjs';
import { installTaskDispatch } from '../plugins/v2/task-dispatch.mjs';
import { createRegistry } from '../plugins/v2/dispatch-registry.mjs';
import { setIntent } from '../plugins/v2/task-intent.mjs';

const memory = initial => {
  let value = structuredClone(initial);
  const registry = async (_, fn) => { const copy = structuredClone(value); return fn(copy, async () => { value = structuredClone(copy); }); };
  return { registry, get: () => value };
};
const DEAD = 101, LIVE = 202;
const binding = { generation:1, marker:'m', promptHash:'h', prefixedPromptHash:'p', background:true };
const row = (workKey, patch = {}) => ({ key:`root\0task\0${workKey}`, rootID:'root', taskId:'task', workKey, parentID:'router', childID:`ses_${workKey}`, agent:'builder',
  state:'running', admissionGeneration:1, inFlight:null, writePaths:['src'], startedAt:10, completionBinding:binding, ...patch });
const lease = (workKey, patch = {}) => ({ workspace:'/project', key:`root\0task\0${workKey}`, parentID:'router', childID:`ses_${workKey}`, paths:[`/project/${workKey}`], inFlight:false, ...patch });

function fixture({ records, leases, sessions, receipts = {} }) {
  const local = memory({ records }), global = memory({ leases });
  const receiptCalls = [];
  const reconciler = createStaleReconciler({ registry:local.registry, globalRegistry:global.registry, workspace:'/project', canonicalWorkspace:async () => '/project',
    loadSessions:async () => sessions, now:() => 5000, isPidLive:pid => pid !== DEAD,
    loadTerminalReceipt:async query => { receiptCalls.push(query); const value = receipts[query.sessionID]; if (value instanceof Error) throw value; return value ?? null; } });
  const record = workKey => local.get().records.find(r => r.workKey === workKey);
  return { local, global, reconciler, record, receiptCalls };
}

test('startup reconciliation settles only rows whose children are provably stopped and releases their leases', async () => {
  const h = fixture({
    records:[
      row('aborted'), row('failed'), row('missing'), row('active'), row('busy-descendant'), row('awaiting-collection'), row('unknown'),
      row('dead-owner', { inFlight:'tok_dead', ownerPid:DEAD, completionBinding:{ ...binding, background:false } }),
      row('dead-owner-succeeded', { inFlight:'tok_ok', ownerPid:DEAD, completionBinding:{ ...binding, background:false } }),
      row('dead-owner-active', { inFlight:'tok_active', ownerPid:DEAD }),
      row('live-owner', { inFlight:'tok_live', ownerPid:LIVE }),
      row('no-child', { childID:undefined, inFlight:'tok_nochild', ownerPid:DEAD, agent:'scout' }),
      row('no-child-accepted', { childID:undefined, inFlight:'tok_accepted', ownerPid:DEAD, parentID:'coordinator', agent:'verifier' }),
      row('done', { state:'completed' }), row('stopped', { state:'cancelled' }),
    ],
    leases:[lease('aborted'), lease('failed', { inFlight:true, ownerPid:DEAD }), lease('missing'), lease('active'), lease('live-owner', { inFlight:true, ownerPid:LIVE }),
      lease('no-child', { childID:undefined, inFlight:true, ownerPid:DEAD }), lease('dead-owner'), { workspace:'/other', key:'foreign', childID:'ses_other', paths:['/other'] }],
    sessions:[{ id:'root' }, { id:'router', parentID:'root', active:true }, { id:'coordinator', parentID:'router', active:true },
      ...['aborted','failed','awaiting-collection','unknown','dead-owner','dead-owner-succeeded','live-owner','done','stopped'].map(k => ({ id:`ses_${k}`, parentID:'router', agent:'builder', active:false })),
      { id:'ses_active', parentID:'router', agent:'builder', active:true }, { id:'ses_dead-owner-active', parentID:'router', agent:'builder', active:true },
      { id:'ses_busy-descendant', parentID:'router', agent:'builder', active:false }, { id:'ses_helper', parentID:'ses_busy-descendant', active:true },
      { id:'ses_unreported', parentID:'coordinator', agent:'verifier', active:true, created:20 }],
    receipts:{ 'ses_aborted':{ outcome:'interrupted' }, 'ses_failed':{ outcome:'failed' }, 'ses_awaiting-collection':{ outcome:'succeeded' },
      'ses_unknown':new Error('runtime unavailable'), 'ses_dead-owner-succeeded':{ outcome:'succeeded' } },
  });
  const settled = await h.reconciler.reconcile();
  assert.deepEqual(settled.map(s => [s.key.split('\0')[2], s.state, s.reason]), [
    ['aborted', 'interrupted', 'native_terminal_outcome'], ['failed', 'failed', 'native_terminal_outcome'], ['missing', 'interrupted', 'child_missing'],
    ['dead-owner', 'interrupted', 'admission_owner_exited'], ['dead-owner-succeeded', 'paused', 'admission_owner_exited'], ['no-child', 'interrupted', 'admission_owner_exited'],
  ]);
  for (const key of ['active','busy-descendant','awaiting-collection','unknown','dead-owner-active','live-owner','no-child-accepted','done','stopped'])
    assert.equal(h.record(key).reconciliation, undefined, `${key} must stay untouched`);
  assert.equal(h.record('awaiting-collection').state, 'running');
  assert.equal(h.record('live-owner').inFlight, 'tok_live'); assert.equal(h.record('dead-owner-active').inFlight, 'tok_active');
  const aborted = h.record('aborted');
  assert.deepEqual(aborted.reconciliation, { generation:1, reason:'native_terminal_outcome', previousState:'running', observedAt:5000, nativeOutcome:'interrupted',
    releasedLeases:[{ sessionID:'ses_aborted', paths:['/project/aborted'] }] });
  assert.deepEqual(aborted.writePaths, ['src'], 'the admitted scope is kept for an explicit same-child continuation');
  assert.equal(h.record('dead-owner').inFlight, null); assert.equal(h.record('dead-owner').reconciliation.ownerPid, DEAD);
  assert.equal(h.record('dead-owner-succeeded').reconciliation.nativeOutcome, 'succeeded');
  assert.deepEqual(h.global.get().leases.map(l => l.key.split('\0').at(-1)).sort(), ['active', 'foreign', 'live-owner']);
  // Idempotent: a second pass settles nothing more and never re-reads settled rows.
  const reads = h.receiptCalls.length;
  assert.deepEqual(await h.reconciler.reconcile(), []);
  assert.ok(h.receiptCalls.slice(reads).every(q => !['ses_aborted','ses_failed','ses_dead-owner'].includes(q.sessionID)));
});

test('runtime settlement of one generation requires its exact failed or interrupted native outcome', async () => {
  const h = fixture({ records:[row('bg'), row('ok'), row('old', { admissionGeneration:2 }), row('busy')], leases:[lease('bg'), lease('ok')],
    sessions:[{ id:'root' }, { id:'router', parentID:'root' }, { id:'ses_bg', parentID:'router', active:false }, { id:'ses_ok', parentID:'router', active:false },
      { id:'ses_old', parentID:'router', active:false }, { id:'ses_busy', parentID:'router', active:true }],
    receipts:{ ses_bg:{ outcome:'interrupted' }, ses_ok:{ outcome:'succeeded' }, ses_old:{ outcome:'failed' }, ses_busy:{ outcome:'failed' } } });
  assert.equal(await h.reconciler.settleGeneration('root\0task\0bg', 1), 'interrupted');
  assert.equal(await h.reconciler.settleGeneration('root\0task\0bg', 1), undefined);
  assert.equal(await h.reconciler.settleGeneration('root\0task\0ok', 1), undefined);
  assert.equal(await h.reconciler.settleGeneration('root\0task\0old', 1), undefined);
  assert.equal(await h.reconciler.settleGeneration('root\0task\0busy', 1), undefined);
  assert.equal(h.record('ok').state, 'running'); assert.equal(h.record('busy').state, 'running');
  assert.deepEqual(h.global.get().leases.map(l => l.key.split('\0').at(-1)), ['ok']);
});

test('the result watcher settles an interrupted background child and releases its lease', async () => {
  const h = fixture({ records:[row('bg', { resultDelivery:{ generation:1, status:'pending', mode:'background', parentID:'router', since:1, marker:'m', promptHash:'h,p',
    toolReturned:true, returnedAt:1, taskId:'task', workKey:'bg', agent:'builder', description:'Build' } })], leases:[lease('bg')],
    sessions:[{ id:'root' }, { id:'router', parentID:'root' }, { id:'ses_bg', parentID:'router', active:false }], receipts:{ ses_bg:{ outcome:'interrupted' } } });
  const sent = [];
  const delivery = createResultDelivery({ registry:h.local.registry, workspace:'/project', ctx:{ session:{ synthetic:async input => sent.push(input) } }, now:() => 100000,
    loadEvidence:async () => ({ terminal:{ outcome:'interrupted', promptID:'p', idleID:'i', idleSeq:3, completedAt:2 }, notices:[{ harness:false, state:'cancelled' }] }),
    onTerminalFailure:key => h.reconciler.settleGeneration(key, 1), schedule:() => 0 });
  assert.equal(await delivery.check('root\0task\0bg', 1), 'confirmed');
  assert.equal(sent.length, 0, 'the native notice already reported the interruption');
  assert.equal(h.record('bg').state, 'interrupted'); assert.equal(h.record('bg').resultDelivery.outcome, 'interrupted');
  assert.deepEqual(h.global.get().leases, []);
});

test('cancelling a coordinator also cancels its in-flight admissions that have no child yet and their leases', async () => {
  const local = memory({ records:[
    { key:'root\0task\0coord', rootID:'root', taskId:'task', workKey:'coord', parentID:'router', childID:'coordinator', agent:'coordinator', state:'running', admissionGeneration:1, writePaths:[] },
    { key:'root\0task\0pending', rootID:'root', taskId:'task', workKey:'pending', parentID:'coordinator', agent:'builder', state:'starting', admissionGeneration:1, inFlight:'tok', writePaths:['src'] },
    { key:'root\0task\0sibling', rootID:'root', taskId:'task', workKey:'sibling', parentID:'router', agent:'builder', state:'starting', admissionGeneration:1, inFlight:'tok2', writePaths:['docs'] },
  ] });
  const global = memory({ leases:[
    { workspace:'/project', key:'root\0task\0pending', parentID:'coordinator', paths:['/project/src'], inFlight:true, token:'tok' },
    { workspace:'/project', key:'root\0task\0sibling', parentID:'router', paths:['/project/docs'], inFlight:true, token:'tok2' },
  ] });
  const tree = [{ id:'root' }, { id:'router', parentID:'root', active:true }, { id:'coordinator', parentID:'router', agent:'coordinator', active:true }];
  const cancel = createDispatchCanceller({ registry:local.registry, globalRegistry:global.registry, workspace:'/project', canonicalWorkspace:async () => '/project',
    loadSessions:async () => tree, ctx:{ session:{ interrupt:async ({ sessionID }) => { tree.find(s => s.id === sessionID).active = false; } } }, now:() => 7 });
  const result = JSON.parse((await cancel({ taskId:'task', workKey:'coord', reason:'replan' }, { sessionID:'router' })).content);
  assert.equal(result.status, 'cancelled');
  const [, pending, sibling] = local.get().records;
  assert.equal(pending.state, 'cancelled'); assert.equal(pending.inFlight, null); assert.equal(pending.cancellation.cascadeFrom, 'coordinator');
  assert.equal(sibling.state, 'starting'); assert.equal(sibling.inFlight, 'tok2');
  assert.deepEqual(global.get().leases.map(l => l.key), ['root\0task\0sibling']);
});

const agents = JSON.parse(fs.readFileSync(new URL('./fixtures/agents.json', import.meta.url)));
const intent = { outcome:'Working release', target:'Local backend', nonGoals:[], authorizedEffects:['Local changes'], assumptions:[], checks:[{ id:'backend', description:'Actual backend check', mode:'local' }], sourceMessageIDs:['msg_user'] };

test('after a restart, a stale running row and lease from the previous server no longer reject a new lane', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dispatch-reconcile-')); t.after(() => fsp.rm(dir, { recursive:true, force:true }));
  const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), 'dispatch-reconcile-ws-')); t.after(() => fsp.rm(workspace, { recursive:true, force:true }));
  const canonical = await fsp.realpath(workspace);
  const deadPid = 2 ** 22 + 4242; // above Linux pid_max: never a live process
  const sessions = [{ id:'root', agent:'router', directory:workspace, active:true }, { id:'ses_old', parentID:'root', agent:'builder', directory:workspace, active:false }];
  const tools = new Map();
  tools.set('subagent', { name:'subagent', description:'Native', input:{ type:'object', properties:{ agent:{type:'string'}, description:{type:'string'}, prompt:{type:'string'}, sessionID:{type:'string'}, background:{type:'boolean'} }, required:['agent','description','prompt'] },
    execute:async (input, context) => {
      sessions.push({ id:'ses_new', parentID:context.sessionID, agent:input.agent, directory:workspace, active:true });
      await context.progress({ sessionID:'ses_new', status:'running' });
      return { output:{ sessionID:'ses_new', status:'running', output:'started' }, content:'started', metadata:{ sessionID:'ses_new', status:'running' } };
    } });
  const ctx = { location:{ directory:workspace }, agent:{ list:async () => ({ data:Object.entries(agents).map(([id, a]) => ({ id, ...a })) }) },
    tool:{ transform:async fn => fn({ get:name => tools.get(name), update:(name, fn) => fn(tools.get(name)), add:tool => tools.set(tool.name, tool) }) },
    session:{ hook:async () => {} } };
  const registry = createRegistry(dir), globalRegistry = createRegistry(path.join(dir, 'global'));
  await registry(workspace, async (state, save) => {
    setIntent(state, { rootID:'root', taskId:'release', intent, expectedRevision:0, actorSessionID:'root' });
    state.records.push({ key:'root\0release\0old', rootID:'root', taskId:'release', workKey:'old', parentID:'root', childID:'ses_old', agent:'builder', operation:'implement',
      state:'running', admissionGeneration:1, inFlight:'tok_old', ownerPid:deadPid, writePaths:['.'], intentRevision:1, checkIds:['backend'], startedAt:1 });
    await save();
  });
  await globalRegistry('all-writers', async (state, save) => { state.leases = [{ token:'tok_old', workspace:canonical, key:'root\0release\0old', parentID:'root', paths:[canonical], inFlight:true, ownerPid:deadPid }]; await save(); });
  const runtime = await installTaskDispatch(ctx, { registry, globalRegistry, loadSessions:async () => sessions, loadSources:async () => ['msg_user'], loadRoutingPolicy:() => undefined,
    loadTerminalReceipt:async () => ({ outcome:'interrupted', promptID:'p', idleID:'i', idleSeq:2 }), loadDeliveryEvidence:async () => ({ terminal:null }), deliverySchedule:() => 0 });
  t.after(() => runtime.dispose());
  await registry(workspace, async state => {
    const old = state.records.find(r => r.workKey === 'old');
    assert.equal(old.state, 'interrupted'); assert.equal(old.inFlight, null); assert.equal(old.reconciliation.reason, 'admission_owner_exited'); assert.equal(old.reconciliation.ownerPid, deadPid);
  });
  await globalRegistry('all-writers', async state => assert.deepEqual(state.leases, []));
  const admitted = await tools.get('task_dispatch').execute({ background:true, intentRevision:1, checkIds:['backend'], taskId:'release', workKey:'new', operation:'implement', agent:'builder',
    description:'Build', prompt:'Build it', requiredCapabilities:['edit'], writePaths:['src'] }, { sessionID:'root', agent:'router', progress:async () => {} });
  assert.equal(admitted.metadata.sessionID, 'ses_new');
});
