import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDispatchCanceller } from '../plugins/v2/task-dispatch-cancel.mjs';
import { installTaskDispatch } from '../plugins/v2/task-dispatch.mjs';
import { createRegistry } from '../plugins/v2/dispatch-registry.mjs';
import { setIntent } from '../plugins/v2/task-intent.mjs';
import { summarizeTaskDispatchStatus } from '../plugins/v2/task-dispatch-status-summary.mjs';

const memory = initial => {
  let value = structuredClone(initial);
  const registry = async (_, fn) => { const copy = structuredClone(value); return fn(copy, async () => { value = structuredClone(copy); }); };
  return { registry, get: () => value };
};

function fixture({ records, leases, sessions, pending = {}, interruptError } = {}) {
  const local = memory({ records: records ?? [
    { key:'root\0task\0verify', rootID:'root', taskId:'task', workKey:'verify', parentID:'router', childID:'verifier', agent:'verifier', state:'running', admissionGeneration:2, writePaths:['.'] },
    { key:'root\0task\0build', rootID:'root', taskId:'task', workKey:'build', parentID:'coordinator', childID:'grandchild', agent:'builder', state:'running', admissionGeneration:1, writePaths:['src'] },
  ] });
  const global = memory({ leases: leases ?? [
    { workspace:'/project', key:'root\0task\0verify', parentID:'router', childID:'verifier', paths:['/project'] },
    { workspace:'/project', key:'root\0task\0build', parentID:'coordinator', childID:'grandchild', paths:['/project/src'] },
    { workspace:'/other', key:'foreign', childID:'other', paths:['/other'] },
  ] });
  const tree = sessions ?? [
    { id:'root' }, { id:'router', parentID:'root', active:true }, { id:'verifier', parentID:'router', agent:'verifier', active:true },
    { id:'verifier-helper', parentID:'verifier', active:true }, { id:'coordinator', parentID:'router', active:true },
    { id:'grandchild', parentID:'coordinator', agent:'builder', active:true }, { id:'foreign-root' }, { id:'foreign-child', parentID:'foreign-root', active:true },
  ];
  const interrupts = [], replies = [];
  const ctx = {
    session: { interrupt: async ({ sessionID, resume }) => {
      if (interruptError) throw interruptError;
      interrupts.push({ sessionID, resume }); const s = tree.find(item => item.id === sessionID); if (s) s.active = false;
    } },
    permission: {
      list: async ({ sessionID }) => ({ data: (pending[sessionID] ?? []).map(id => ({ id, sessionID })) }),
      reply: async ({ sessionID, requestID, decision }) => {
        if (!(pending[sessionID] ?? []).includes(requestID)) throw new Error('unknown request');
        replies.push({ sessionID, requestID, decision }); pending[sessionID] = pending[sessionID].filter(id => id !== requestID);
      },
    },
  };
  const cancel = createDispatchCanceller({ registry:local.registry, globalRegistry:global.registry, workspace:'/project',
    canonicalWorkspace:async () => '/project', loadSessions:async () => tree, ctx, now:() => 1234 });
  return { cancel, local, global, tree, ctx, interrupts, replies, pending };
}

test('cancelling an own child interrupts it, rejects pending asks, records state and releases its locks', async () => {
  const h = fixture({ pending:{ verifier:['per_1','per_2'], 'verifier-helper':['per_3'], grandchild:['per_other'] } });
  const result = JSON.parse((await h.cancel({ taskId:'task', workKey:'verify', reason:'operator changed the rules' }, { sessionID:'router' })).content);
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(h.interrupts, [{ sessionID:'verifier', resume:false }, { sessionID:'verifier-helper', resume:false }]);
  assert.equal(result.pendingPermissionsRejected, 3);
  assert.ok(h.replies.every(r => r.decision === 'reject' && r.sessionID !== 'grandchild'));
  assert.deepEqual(h.pending.grandchild, ['per_other']);
  const record = h.local.get().records.find(r => r.workKey === 'verify');
  assert.equal(record.state, 'cancelled'); assert.deepEqual(record.writePaths, []); assert.equal(record.inFlight, null);
  assert.deepEqual({ ...record.cancellation, interrupted:undefined, interruptFailures:undefined }, { generation:2, reason:'operator changed the rules', cancelledAt:1234,
    cancelledBy:'router', previousState:'running', interrupted:undefined, interruptFailures:undefined, pendingPermissionsRejected:3, permissionCleanup:'rejected', releasedWritePaths:['.'] });
  assert.deepEqual(result.releasedLocks, [{ kind:'workspace-ownership', sessionID:'verifier', workKey:'verify', paths:['.'] },
    { kind:'global-writer-lease', sessionID:'verifier', paths:['/project'] }]);
  assert.deepEqual(h.global.get().leases.map(l => l.key), ['root\0task\0build', 'foreign']);
  assert.equal(h.local.get().records.find(r => r.workKey === 'build').state, 'running');
});

test('cancel is idempotent for already-cancelled and already-finished children', async () => {
  const h = fixture();
  await h.cancel({ taskId:'task', sessionID:'verifier', reason:'stop' }, { sessionID:'router' });
  const again = JSON.parse((await h.cancel({ taskId:'task', sessionID:'verifier', reason:'stop again' }, { sessionID:'router' })).content);
  assert.equal(again.status, 'already_cancelled'); assert.equal(again.cancellation.reason, 'stop'); assert.deepEqual(again.releasedLocks, []);
  assert.equal(h.interrupts.length, 2);
  const idle = fixture(); idle.tree.find(s => s.id === 'verifier').active = false; idle.tree.find(s => s.id === 'verifier-helper').active = false;
  const finished = JSON.parse((await idle.cancel({ taskId:'task', workKey:'verify', reason:'stop' }, { sessionID:'router' })).content);
  assert.equal(finished.status, 'already_finished'); assert.equal(finished.recordedState, 'running');
  assert.equal(idle.interrupts.length, 0); assert.equal(idle.local.get().records[0].state, 'running');
});

test('cancel refuses grandchildren, foreign trees, ambiguous and malformed requests', async () => {
  const h = fixture();
  await assert.rejects(h.cancel({ taskId:'task', workKey:'build', reason:'x' }, { sessionID:'router' }), /not the recorded dispatcher/);
  await assert.rejects(h.cancel({ taskId:'task', sessionID:'foreign-child', reason:'x' }, { sessionID:'router' }), /no dispatch record/);
  await assert.rejects(h.cancel({ taskId:'task', workKey:'verify', reason:'x' }, { sessionID:'foreign-child' }), /no dispatch record/);
  await assert.rejects(h.cancel({ taskId:'task', workKey:'verify', reason:'x' }, { sessionID:'verifier' }), /not the recorded dispatcher/);
  await assert.rejects(h.cancel({ taskId:'task', reason:'x' }, { sessionID:'router' }), /workKey and\/or sessionID/);
  await assert.rejects(h.cancel({ taskId:'task', workKey:'verify', reason:' ' }, { sessionID:'router' }), /reason/);
  await assert.rejects(h.cancel({ taskId:'task', workKey:'verify', reason:'x'.repeat(501) }, { sessionID:'router' }), /reason/);
  assert.equal(h.interrupts.length, 0); assert.equal(h.global.get().leases.length, 3);
  // The grandchild's own recorded dispatcher may cancel it.
  const own = JSON.parse((await h.cancel({ taskId:'task', workKey:'build', reason:'coordinator stop' }, { sessionID:'coordinator' })).content);
  assert.equal(own.status, 'cancelled'); assert.deepEqual(h.global.get().leases.map(l => l.key), ['root\0task\0verify', 'foreign']);
});

test('a failed native interrupt retains ownership; missing permission API is reported', async () => {
  const h = fixture({ interruptError:new Error('busy') });
  await assert.rejects(h.cancel({ taskId:'task', workKey:'verify', reason:'x' }, { sessionID:'router' }), /ownership is retained/);
  assert.equal(h.local.get().records[0].state, 'running'); assert.equal(h.global.get().leases.length, 3);
  const bare = fixture(); delete bare.ctx.permission;
  const result = JSON.parse((await bare.cancel({ taskId:'task', workKey:'verify', reason:'x' }, { sessionID:'router' })).content);
  assert.equal(result.permissionCleanup, 'unavailable'); assert.equal(result.pendingPermissionsRejected, 0);
});

test('cancelling a coordinator cascades to the records and leases it dispatched', async () => {
  const h = fixture({ records:[
    { key:'root\0task\0coord', rootID:'root', taskId:'task', workKey:'coord', parentID:'router', childID:'coordinator', agent:'coordinator', state:'running', admissionGeneration:1, writePaths:[] },
    { key:'root\0task\0build', rootID:'root', taskId:'task', workKey:'build', parentID:'coordinator', childID:'grandchild', agent:'builder', state:'running', admissionGeneration:1, writePaths:['src'] },
  ] });
  const result = JSON.parse((await h.cancel({ taskId:'task', workKey:'coord', reason:'replan' }, { sessionID:'router' })).content);
  assert.deepEqual(result.cascadedCancellations, ['grandchild']);
  assert.deepEqual(h.interrupts.map(i => i.sessionID), ['coordinator', 'grandchild']);
  const grandchild = h.local.get().records[1];
  assert.equal(grandchild.state, 'cancelled'); assert.equal(grandchild.cancellation.cascadeFrom, 'coordinator'); assert.deepEqual(grandchild.writePaths, []);
  assert.deepEqual(h.global.get().leases.map(l => l.key), ['root\0task\0verify', 'foreign']);
});

const agents = JSON.parse(fs.readFileSync(new URL('./fixtures/agents.json', import.meta.url)));
const intent = { outcome:'Working release', target:'Local backend', nonGoals:[], authorizedEffects:['Local changes'], assumptions:[], checks:[{ id:'backend', description:'Actual backend check', mode:'local' }], sourceMessageIDs:['msg_user'] };
const base = { background:true, intentRevision:1, checkIds:['backend'], taskId:'release', workKey:'verify', operation:'verify', agent:'builder', description:'Verify', prompt:'Run checks', requiredCapabilities:['shell'] };

test('router cancels its background verifier through the installed tool and admits a new overlapping lane', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dispatch-cancel-')); t.after(() => fsp.rm(dir, { recursive:true, force:true }));
  const sessions = [{ id:'root', agent:'router', directory:'/project', active:true }], tools = new Map(), hooks = new Map(), interrupts = [];
  let n = 0;
  tools.set('subagent', { name:'subagent', description:'Native', input:{ type:'object', properties:{ agent:{type:'string'}, description:{type:'string'}, prompt:{type:'string'}, sessionID:{type:'string'}, background:{type:'boolean'} }, required:['agent','description','prompt'] },
    execute:async (input, context) => {
      const id = input.sessionID ?? `ses_${++n}`; let child = sessions.find(s => s.id === id);
      if (!child) { child = { id, parentID:context.sessionID, agent:input.agent, directory:'/project', active:true }; sessions.push(child); }
      await context.progress({ sessionID:id, status:'running' });
      if (input.prompt.includes('cancel-mid-flight')) await tools.get('task_dispatch_cancel').execute({ taskId:'release', sessionID:id, reason:'mid flight' }, { sessionID:context.sessionID });
      child.active = !!input.background;
      return { output:{ sessionID:id, status:child.active ? 'running' : 'completed', output:'OK' }, content:'OK', metadata:{ sessionID:id, status:child.active ? 'running' : 'completed' } };
    } });
  const ctx = { location:{ directory:'/project' }, agent:{ list:async () => ({ data:Object.entries(agents).map(([id, a]) => ({ id, ...a })) }) },
    tool:{ transform:async fn => fn({ get:name => tools.get(name), update:(name, fn) => fn(tools.get(name)), add:tool => tools.set(tool.name, tool) }) },
    session:{ hook:async (name, fn) => hooks.set(name, fn), interrupt:async ({ sessionID }) => { interrupts.push(sessionID); sessions.find(s => s.id === sessionID).active = false; } },
    permission:{ list:async () => ({ data:[{ id:'per_shell' }] }), reply:async () => {} } };
  const registry = createRegistry(dir), globalRegistry = createRegistry(path.join(dir, 'global'));
  await registry('/project', async (state, save) => { setIntent(state, { rootID:'root', taskId:'release', intent, expectedRevision:0, actorSessionID:'root' }); await save(); });
  await installTaskDispatch(ctx, { registry, globalRegistry, loadSessions:async () => sessions, loadSources:async () => ['msg_user'], loadRoutingPolicy:() => undefined });
  const call = (input, tool = 'task_dispatch', sessionID = 'root') => tools.get(tool).execute(input, { sessionID, agent:'router', progress:async () => {} });
  await call(base);
  await assert.rejects(call({ ...base, workKey:'implement', operation:'implement', agent:'builder', requiredCapabilities:['edit'], writePaths:['backend'] }), /overlapping/);
  const result = JSON.parse((await call({ taskId:'release', workKey:'verify', reason:'rules changed' }, 'task_dispatch_cancel')).content);
  assert.equal(result.status, 'cancelled'); assert.deepEqual(interrupts, ['ses_1']); assert.equal(result.pendingPermissionsRejected, 1);
  assert.ok(result.releasedLocks.some(l => l.kind === 'global-writer-lease'));
  // The cancelled child can no longer infer until re-admitted.
  await assert.rejects(hooks.get('model.request')({ sessionID:'ses_1', agent:'builder' }), /cancelled by its parent/);
  const status = JSON.parse((await call({ taskId:'release', summary:true }, 'task_dispatch_status')).content);
  assert.equal(status.owners[0].recordedState, 'cancelled'); assert.equal(status.owners[0].cancellation.reason, 'rules changed');
  assert.deepEqual(status.cancelledChildren, [{ taskId:'release', workKey:'verify', sessionID:'ses_1', generation:1, reason:'rules changed', cancelledAt:status.cancelledChildren[0].cancelledAt, cancelledBy:'root' }]);
  assert.equal(summarizeTaskDispatchStatus({ cancelledChildren:[1] }).cancelledChildren.length, 1);
  const replacement = await call({ ...base, workKey:'implement', operation:'implement', agent:'builder', requiredCapabilities:['edit'], writePaths:['backend'] });
  assert.equal(replacement.metadata.sessionID, 'ses_2');
  assert.equal(JSON.parse((await call({ taskId:'release', workKey:'verify', reason:'again' }, 'task_dispatch_cancel')).content).status, 'already_cancelled');
  // A cancel landing while a foreground handoff is in flight is honoured, not overwritten.
  await call({ ...base, background:false, workKey:'foreground', writePaths:['docs'], prompt:'cancel-mid-flight' });
  await registry('/project', async state => {
    const record = state.records.find(r => r.workKey === 'foreground');
    assert.equal(record.state, 'cancelled'); assert.equal(record.inFlight, null); assert.equal(record.cancellation.reason, 'mid flight');
  });
  await globalRegistry('all-writers', async state => assert.equal(state.leases.some(l => l.key.endsWith('foreground')), false));
});
