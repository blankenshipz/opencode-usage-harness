import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createResultDelivery, deliveryDecision, resultDeliveryID, resultSyntheticInput, RESULT_DELIVERY_GRACE_MS } from '../plugins/v2/result-delivery.mjs';
import { installTaskDispatch } from '../plugins/v2/task-dispatch.mjs';
import { createRegistry } from '../plugins/v2/dispatch-registry.mjs';
import { setIntent } from '../plugins/v2/task-intent.mjs';

const memory = initial => {
  let value = structuredClone(initial);
  const registry = async (_, fn) => { const copy = structuredClone(value); return fn(copy, async () => { value = structuredClone(copy); }); };
  return { registry, get: () => value };
};
const delivery = (patch = {}) => ({ generation:2, status:'pending', mode:'foreground', parentID:'router', messageID:'msg_parent', callID:'toolu_1', since:1000,
  marker:'m', promptHash:'a,b', agent:'verifier', description:'Run final tests', taskId:'task', workKey:'verify', toolReturned:true, returnedAt:5000, ...patch });
const succeeded = { outcome:'succeeded', promptID:'msg_p', assistantID:'msg_a', assistantSeq:4, idleID:'msg_i', idleSeq:5, completedAt:5000 };

test('decision waits for a terminal outcome, confirms visible results and delivers lost ones after grace', () => {
  const now = 5000 + RESULT_DELIVERY_GRACE_MS;
  assert.equal(deliveryDecision({ delivery:delivery(), evidence:{ terminal:null }, now }).action, 'wait');
  assert.deepEqual(deliveryDecision({ delivery:delivery(), evidence:{ terminal:succeeded, tool:{ status:'completed' }, notices:[] }, now }),
    { action:'final', status:'confirmed', via:'tool_result' });
  assert.equal(deliveryDecision({ delivery:delivery({ mode:'background' }), evidence:{ terminal:succeeded, tool:{ status:'completed' }, notices:[{ harness:false }] }, now }).via, 'native_notice');
  assert.equal(deliveryDecision({ delivery:delivery(), evidence:{ terminal:succeeded, tool:null, notices:[] }, now }).via, 'tool_result_unverified');
  assert.equal(deliveryDecision({ delivery:delivery(), evidence:{ terminal:succeeded, notices:[{ harness:true, generation:2 }] }, now }).status, 'delivered');
  // The live failure: the returned result never settled the parent part.
  assert.equal(deliveryDecision({ delivery:delivery(), evidence:{ terminal:succeeded, tool:{ status:'streaming' }, notices:[] }, now:now - 1 }).action, 'wait');
  const lost = deliveryDecision({ delivery:delivery(), evidence:{ terminal:succeeded, tool:{ status:'streaming' }, notices:[] }, now });
  assert.equal(lost.action, 'deliver'); assert.equal(lost.outcome, 'succeeded'); assert.match(lost.reason, /not recorded/); assert.equal(lost.resume, true);
  // An aborted wait is delivered even when the part shows the abort.
  const aborted = deliveryDecision({ delivery:delivery({ toolReturned:false }), evidence:{ terminal:succeeded, tool:{ status:'error', errorType:'aborted' }, notices:[] }, now });
  assert.equal(aborted.action, 'deliver'); assert.match(aborted.reason, /aborted or interrupted/);
  const background = deliveryDecision({ delivery:delivery({ mode:'background' }), evidence:{ terminal:{ ...succeeded, outcome:'failed' }, tool:{ status:'completed' }, notices:[] }, now });
  assert.equal(background.outcome, 'failed'); assert.match(background.reason, /no native completion notice/);
  // A user-interrupted parent is not restarted by the notice.
  assert.equal(deliveryDecision({ delivery:delivery({ toolReturned:false }), evidence:{ terminal:succeeded, notices:[], parentActive:false, parentIdleOutcome:'interrupted' }, now }).resume, false);
});

test('synthetic notice mirrors the native subagent format and states the real outcome', () => {
  const input = resultSyntheticInput({ delivery:delivery(), childID:'ses_child', outcome:'succeeded', report:'Full pytest: 564 passed.', reason:'lost' });
  assert.equal(input.id, resultDeliveryID('ses_child', 2)); assert.equal(input.id, resultDeliveryID('ses_child', 2));
  assert.notEqual(input.id, resultDeliveryID('ses_child', 3));
  assert.equal(input.sessionID, 'router'); assert.equal(input.resume, undefined);
  assert.match(input.text, /^<subagent sessionID="ses_child" state="completed" outcome="succeeded" generation="2"/);
  assert.match(input.text, /Full pytest: 564 passed\.\n<\/subagent>/); assert.match(input.text, /SUCCEEDED/);
  assert.deepEqual(input.metadata, { source:'subagent', harness:'result_delivery', childID:'ses_child', agent:'verifier', state:'completed', outcome:'succeeded', generation:2, taskId:'task', workKey:'verify' });
  const interrupted = resultSyntheticInput({ delivery:delivery(), childID:'ses_child', outcome:'interrupted', report:'', reason:'lost', resume:false });
  assert.match(interrupted.text, /state="cancelled" outcome="interrupted"/); assert.equal(interrupted.resume, false);
});

function harness({ record = {}, evidence, synthetic } = {}) {
  const local = memory({ records:[{ key:'k', rootID:'root', taskId:'task', workKey:'verify', parentID:'router', childID:'ses_child', state:'paused', admissionGeneration:2, resultDelivery:delivery(), ...record }] });
  const sent = [], scheduled = [];
  let clock = 5000 + RESULT_DELIVERY_GRACE_MS;
  const ctx = { session:{ synthetic: synthetic ?? (async input => { sent.push(input); }) } };
  const queries = [];
  const delivery_ = createResultDelivery({ registry:local.registry, workspace:'/project', ctx, now:() => clock,
    loadEvidence:async query => { queries.push(query); return typeof evidence === 'function' ? evidence(query) : evidence; },
    loadFinalText:async ({ sessionID, assistantID }) => sessionID === 'ses_child' && assistantID === 'msg_a' ? { text:'Full pytest: 564 passed.', truncated:false, length:24 } : null,
    schedule:(fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length; }, cancel:() => {} });
  return { local, sent, scheduled, queries, delivery:delivery_, advance:ms => { clock += ms; } };
}

test('an aborted foreground wait whose child succeeded is delivered once and recorded as succeeded', async () => {
  const h = harness({ record:{ resultDelivery:delivery({ toolReturned:false }) }, evidence:{ terminal:succeeded, tool:{ status:'error', errorType:'aborted' }, notices:[] } });
  assert.equal(await h.delivery.check('k', 2), 'delivered');
  assert.equal(h.sent.length, 1); assert.match(h.sent[0].text, /state="completed" outcome="succeeded"/); assert.match(h.sent[0].text, /564 passed/);
  assert.deepEqual(h.queries[0], { childID:'ses_child', parentID:'router', marker:'m', promptHash:'a,b', messageID:'msg_parent', callID:'toolu_1', since:1000 });
  const record = h.local.get().records[0];
  assert.equal(record.state, 'completed'); assert.equal(record.outcomeCorrection.previousState, 'paused');
  assert.equal(record.foregroundResult.output, 'Full pytest: 564 passed.'); assert.equal(record.foregroundResult.receipt.assistantID, 'msg_a');
  assert.equal(record.resultDelivery.status, 'delivered'); assert.equal(record.resultDelivery.outcome, 'succeeded'); assert.equal(record.resultDelivery.noticeID, h.sent[0].id);
  // Idempotent: concurrent and later checks never send again.
  assert.deepEqual(await Promise.all([h.delivery.check('k', 2), h.delivery.check('k', 2)]), ['delivered', 'delivered']);
  assert.equal(h.sent.length, 1);
});

test('a returned foreground result left running is delivered; a recorded one is only confirmed', async () => {
  const lost = harness({ record:{ state:'completed' }, evidence:{ terminal:succeeded, tool:{ status:'streaming' }, notices:[] } });
  assert.equal(await lost.delivery.check('k', 2), 'delivered'); assert.equal(lost.sent.length, 1);
  assert.equal(lost.local.get().records[0].outcomeCorrection, undefined);
  const ok = harness({ record:{ state:'completed' }, evidence:{ terminal:succeeded, tool:{ status:'completed' }, notices:[] } });
  assert.equal(await ok.delivery.check('k', 2), 'confirmed'); assert.equal(ok.sent.length, 0);
  assert.equal(ok.local.get().records[0].resultDelivery.via, 'tool_result');
});

test('background results rely on the native notice and fall back only when it is missing', async () => {
  const native = harness({ record:{ state:'running', resultDelivery:delivery({ mode:'background' }) }, evidence:{ terminal:succeeded, tool:{ status:'error' }, notices:[{ harness:false, state:'completed' }] } });
  assert.equal(await native.delivery.check('k', 2), 'confirmed'); assert.equal(native.sent.length, 0);
  const missing = harness({ record:{ state:'running', resultDelivery:delivery({ mode:'background' }) }, evidence:{ terminal:{ ...succeeded, completedAt:5000 + RESULT_DELIVERY_GRACE_MS }, notices:[] } });
  assert.equal(await missing.delivery.check('k', 2), 'pending'); assert.equal(missing.sent.length, 0);
  missing.advance(RESULT_DELIVERY_GRACE_MS);
  assert.equal(await missing.delivery.check('k', 2), 'delivered'); assert.equal(missing.sent.length, 1);
  // A background record keeps its collection path; only foreground results are rewritten.
  assert.equal(missing.local.get().records[0].state, 'running');
});

test('running children, cancellations, superseded generations and conflicts never duplicate', async () => {
  const running = harness({ evidence:{ terminal:null, notices:[] } });
  assert.equal(await running.delivery.check('k', 2), 'pending'); assert.equal(running.sent.length, 0);
  const cancelled = harness({ record:{ state:'cancelled' }, evidence:() => assert.fail('cancelled children need no evidence') });
  assert.equal(await cancelled.delivery.check('k', 2), 'cancelled'); assert.equal(cancelled.sent.length, 0);
  const superseded = harness({ record:{ admissionGeneration:3 }, evidence:{ terminal:succeeded, notices:[] } });
  assert.equal(await superseded.delivery.check('k', 2), 'superseded');
  const conflict = harness({ record:{ resultDelivery:delivery({ toolReturned:false }) }, evidence:{ terminal:succeeded, notices:[] },
    synthetic:async () => { throw new Error('Session.SyntheticConflictError'); } });
  assert.equal(await conflict.delivery.check('k', 2), 'delivered');
  const broken = harness({ record:{ resultDelivery:delivery({ toolReturned:false }) }, evidence:{ terminal:succeeded, notices:[] },
    synthetic:async () => { throw new Error('session store unavailable'); } });
  await assert.rejects(broken.delivery.check('k', 2), /unavailable/);
  assert.equal(broken.local.get().records[0].resultDelivery.status, 'pending');
});

test('tracking polls until a final status and resume re-arms pending deliveries', async () => {
  let terminal = null;
  const h = harness({ record:{ resultDelivery:delivery({ toolReturned:false }) }, evidence:() => ({ terminal, notices:[] }) });
  h.delivery.track('k', 2); h.delivery.track('k', 2);
  assert.equal(h.scheduled.length, 1);
  await h.scheduled.shift().fn();
  assert.equal(h.scheduled.length, 1, 'a pending delivery is re-scheduled');
  terminal = succeeded;
  await h.scheduled.shift().fn();
  assert.equal(h.sent.length, 1); assert.equal(h.scheduled.length, 0);
  const fresh = harness();
  assert.equal(await fresh.delivery.resume(), 1); assert.equal(fresh.scheduled.length, 1);
});

const agents = JSON.parse(fs.readFileSync(new URL('./fixtures/agents.json', import.meta.url)));
const intent = { outcome:'Working release', target:'Local backend', nonGoals:[], authorizedEffects:['Local changes'], assumptions:[], checks:[{ id:'backend', description:'Actual backend check', mode:'local' }], sourceMessageIDs:['msg_user'] };
const base = { intentRevision:1, checkIds:['backend'], taskId:'release', workKey:'verify', operation:'verify', agent:'builder', description:'Verify', prompt:'Run checks', requiredCapabilities:['shell'] };

test('installed dispatch delivers a foreground verifier result after its wait was interrupted', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'result-delivery-')); t.after(() => fsp.rm(dir, { recursive:true, force:true }));
  const sessions = [{ id:'root', agent:'router', directory:'/project', active:true }], tools = new Map(), sent = [], scheduled = [];
  tools.set('subagent', { name:'subagent', description:'Native', input:{ type:'object', properties:{ agent:{type:'string'}, description:{type:'string'}, prompt:{type:'string'}, sessionID:{type:'string'}, background:{type:'boolean'} }, required:['agent','description','prompt'] },
    execute:async (input, context) => {
      sessions.push({ id:'ses_verifier', parentID:context.sessionID, agent:input.agent, directory:'/project', active:false });
      await context.progress({ sessionID:'ses_verifier', status:'running' });
      throw new Error('Tool execution interrupted: subagent');
    } });
  const ctx = { location:{ directory:'/project' }, agent:{ list:async () => ({ data:Object.entries(agents).map(([id, a]) => ({ id, ...a })) }) },
    tool:{ transform:async fn => fn({ get:name => tools.get(name), update:(name, fn) => fn(tools.get(name)), add:tool => tools.set(tool.name, tool) }) },
    session:{ hook:async () => {}, synthetic:async input => { sent.push(input); } } };
  const registry = createRegistry(dir), globalRegistry = createRegistry(path.join(dir, 'global'));
  await registry('/project', async (state, save) => { setIntent(state, { rootID:'root', taskId:'release', intent, expectedRevision:0, actorSessionID:'root' }); await save(); });
  const evidence = [];
  const runtime = await installTaskDispatch(ctx, { registry, globalRegistry, loadSessions:async () => sessions, loadSources:async () => ['msg_user'], loadRoutingPolicy:() => undefined,
    now:() => 10_000 + evidence.length * RESULT_DELIVERY_GRACE_MS,
    loadDeliveryEvidence:async query => { evidence.push(query); return { terminal:{ ...succeeded, completedAt:10_000 }, tool:{ status:'error', errorType:'aborted' }, notices:[] }; },
    loadFinalText:async () => ({ text:'All 564 tests passed.', truncated:false, length:21 }),
    deliverySchedule:(fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length; } });
  t.after(() => runtime.dispose());
  await assert.rejects(tools.get('task_dispatch').execute(base, { sessionID:'root', agent:'router', messageID:'msg_router', id:'toolu_verify', progress:async () => {} }), /interrupted/);
  assert.equal(scheduled.length, 1);
  await scheduled.shift().fn();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sessionID, 'root'); assert.match(sent[0].text, /state="completed" outcome="succeeded"/); assert.match(sent[0].text, /All 564 tests passed\./);
  assert.equal(evidence[0].messageID, 'msg_router'); assert.equal(evidence[0].callID, 'toolu_verify'); assert.equal(evidence[0].childID, 'ses_verifier');
  const collected = JSON.parse((await tools.get('task_dispatch_collect').execute({ taskId:'release', workKey:'verify', sessionID:'ses_verifier', generation:1 }, { sessionID:'root' })).content);
  assert.equal(collected.status, 'completed'); assert.equal(collected.output, 'All 564 tests passed.');
  const status = JSON.parse((await tools.get('task_dispatch_status').execute({ taskId:'release' }, { sessionID:'root' })).content);
  assert.deepEqual(Object.keys(status.owners[0].resultDelivery).sort(), ['deliveredAt','generation','mode','outcome','reason','status','via']);
  assert.equal(status.owners[0].recordedState, 'completed');
  // A restarted plugin does not re-deliver.
  const again = await installTaskDispatch(ctx, { registry, globalRegistry, loadSessions:async () => sessions, loadRoutingPolicy:() => undefined,
    loadDeliveryEvidence:async () => assert.fail('delivered results are not re-armed'), deliverySchedule:(fn, ms) => { scheduled.push({ fn, ms }); return 0; } });
  t.after(() => again.dispose());
  assert.equal(scheduled.length, 0); assert.equal(sent.length, 1);
});
