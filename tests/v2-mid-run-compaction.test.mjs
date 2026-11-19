import { test } from 'node:test';
// Hermetic default: a persisted operator choice must not change these fixtures.
process.env.HARNESS_COMPACTION_TOKENS = '120000';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installTaskDispatch } from '../plugins/v2/task-dispatch.mjs';
import { setIntent } from '../plugins/v2/task-intent.mjs';
import { createRegistry } from '../plugins/v2/dispatch-registry.mjs';
import { midRunCompactionDecision, midRunCompactionID, settleMidRunCompaction, admitMidRunCompaction, recordAdmitted, recordBaseline,
  buildContinuation, activeContinuation, midRunCompactionStatus, growthRequired, MAX_MID_RUN_COMPACTIONS, MAX_MID_RUN_SEQUENCE, CONTINUATION_PREFIX } from '../plugins/v2/mid-run-compaction.mjs';

const agents = JSON.parse(fs.readFileSync(new URL('./fixtures/agents.json', import.meta.url)));
const intent = {outcome:'Working release',target:'Local backend',nonGoals:[],authorizedEffects:['Local changes'],assumptions:[],checks:[{id:'backend',description:'Actual backend check',mode:'local'}],sourceMessageIDs:['msg_user']};
const base = { background:true,intentRevision:1,checkIds:['backend'],taskId:'release',workKey:'backend',operation:'implement',agent:'builder',description:'Fix backend',prompt:'Implement requested backend checks: BRIEF-SENTINEL',requiredCapabilities:['edit','shell'],writePaths:['backend'] };

// ---- pure decision ----
const running = (patch = {}) => ({ key:'k', rootID:'root', taskId:'release', workKey:'backend', parentID:'root', childID:'child', state:'running', admissionGeneration:2, intentRevision:1, checkIds:['backend'],
  completionBinding:{ generation:2, marker:'task-dispatch-generation-x' }, ...patch });
const nativeAt = (tokens, patch = {}) => ({ id:'child', parentID:'root', active:true, contextTokens:tokens, contextMessageID:`msg_obs_${tokens}`, lastAssistantID:`msg_asst_${tokens}`, activity:{ runningTools:[] }, ...patch });
const opts = (patch = {}) => ({ compactionAvailable:true, threshold:120000, sessions:[{id:'root',active:true},{id:'child',parentID:'root',active:true}], ...patch });

test('mid-run decision admits a running child only at or above the absolute trigger with every safety gate open', () => {
  assert.equal(midRunCompactionDecision(running(), nativeAt(119999), opts()).reason, 'below_threshold');
  const ok = midRunCompactionDecision(running(), nativeAt(120000), opts());
  assert.equal(ok.admit, true); assert.equal(ok.sequence, 1);
  // 872k known window: the absolute threshold still applies.
  const model = {providerID:'anthropic',id:'roomy'}; const catalog = [{...model,limit:{context:1000000,output:128000}}];
  assert.equal(midRunCompactionDecision(running(), nativeAt(284000, {model,contextModel:model}), opts({catalog})).admit, true);
  const blocked = [
    [running(), nativeAt(200000, { activity:{ runningTools:[{ toolID:'t', name:'shell', status:'streaming' }] } }), opts(), 'tool_running'],
    [running(), nativeAt(200000), opts({ sessions:[{id:'child',parentID:'root',active:true},{id:'grand',parentID:'child',active:true}] }), 'descendant_active'],
    [running(), nativeAt(200000, { active:false }), opts(), 'not_running'],
    [running({ state:'completed' }), nativeAt(200000), opts(), 'not_running'],
    [running({ state:'compacting', compactionID:'msg_parent' }), nativeAt(200000), opts(), 'not_running'],
    [running({ compactionID:'msg_parent' }), nativeAt(200000), opts(), 'explicit_compaction_pending'],
    [running({ completionBinding:{ generation:1, marker:'old' } }), nativeAt(200000), opts(), 'generation_unbound'],
    [running(), nativeAt(200000), opts({ compactionAvailable:false }), 'native_compaction_unavailable'],
    [running(), nativeAt(200000), opts({ intentCurrent:false }), 'current_intent_rebind_required'],
    [running({ denial:{ category:'native_permission' } }), nativeAt(200000), opts(), 'not_running'],
    [running(), { ...nativeAt(200000), contextTokens:undefined }, opts(), 'context_unknown'],
    [running(), nativeAt(200000, { id:'other' }), opts(), 'native_state_unknown'],
  ];
  for (const [record, native, options, reason] of blocked) assert.equal(midRunCompactionDecision(record, native, options).reason, reason, reason);
});

test('mid-run compaction is idempotent: one pending at a time, growth required, failure stops, per-generation cap', () => {
  const record = running();
  const first = midRunCompactionDecision(record, nativeAt(150000), opts());
  const id = admitMidRunCompaction(record, first, 'frozen continuation', 10);
  assert.equal(id, midRunCompactionID('task-dispatch-generation-x', 1));
  assert.equal(recordAdmitted(record, id), true); assert.equal(recordAdmitted(record, id), false);
  assert.equal(midRunCompactionDecision(record, nativeAt(160000), opts()).reason, 'mid_run_compaction_pending');
  // Unrelated native compaction does not settle it.
  assert.equal(settleMidRunCompaction(record, nativeAt(160000, { lastCompaction:{ id:'msg_other', status:'completed' } })), false);
  assert.equal(activeContinuation(record), undefined);
  assert.equal(settleMidRunCompaction(record, nativeAt(150000, { lastCompaction:{ id, status:'completed' } }), 20), true);
  assert.equal(activeContinuation(record), 'frozen continuation');
  // Same pre-compaction observation: no growth since the last compaction.
  assert.equal(midRunCompactionDecision(record, nativeAt(150000), opts()).reason, 'no_growth_since_last_compaction');
  // First post-compaction observation becomes the baseline (summary was itself large).
  const baseline = midRunCompactionDecision(record, nativeAt(125000), opts());
  assert.equal(baseline.admit, false); assert.equal(baseline.baselineTokens, 125000);
  assert.equal(recordBaseline(record, baseline.baselineTokens), true); assert.equal(recordBaseline(record, 1), false);
  assert.equal(midRunCompactionDecision(record, nativeAt(125000 + growthRequired(120000) - 1), opts()).reason, 'no_growth_since_last_compaction');
  const second = midRunCompactionDecision(record, nativeAt(125000 + growthRequired(120000)), opts());
  assert.equal(second.admit, true); assert.equal(second.sequence, 2);
  const id2 = admitMidRunCompaction(record, second, 'second', 30); recordAdmitted(record, id2);
  assert.equal(activeContinuation(record), 'frozen continuation'); // the new text applies only after its compaction completes
  settleMidRunCompaction(record, nativeAt(1, { lastCompaction:{ id:id2, status:'failed' } }));
  assert.equal(midRunCompactionDecision(record, nativeAt(400000, { lastAssistantID:'msg_new', contextMessageID:'msg_new' }), opts()).reason, 'compaction_failed');
  assert.deepEqual(midRunCompactionStatus(record), { generation:2, count:2, limit:MAX_MID_RUN_COMPACTIONS, last:{ id:id2, status:'failed' }, stopped:'compaction_failed' });
  // A new generation starts clean.
  record.admissionGeneration = 3; record.completionBinding = { generation:3, marker:'next' };
  assert.equal(midRunCompactionDecision(record, nativeAt(400000), opts()).admit, true);
  // Cap.
  const capped = running({ midRunCompaction:{ generation:2, count:MAX_MID_RUN_COMPACTIONS, failures:0, history:[] } });
  assert.equal(midRunCompactionDecision(capped, nativeAt(400000), opts()).reason, 'per_generation_limit');
  assert.equal(MAX_MID_RUN_SEQUENCE, 10);
});

test('continuation preserves the brief, intent reference, check results and latest checkpoint within bounds', () => {
  const record = running({ handoffBrief:{ generation:2, text:'BRIEF '.repeat(3000) }, workCheckpoint:{ startedAt:1, preparedSteps:3, target:{ objective:'obj', expectedEvidence:'ev' } },
    progressCheckpoint:{ status:'in_progress', progressState:'working', recordedAt:5 } });
  const entry = { taskId:'release', revision:1, intent:{ ...intent } };
  const text = buildContinuation(record, { intent:entry, evidence:{ revision:1, checks:{ backend:{ id:'backend', status:'passed', mode:'local', evidence:'npm test exit 0', recordedAt:1, sessionID:'child' } } } });
  assert.ok(text.startsWith(CONTINUATION_PREFIX)); assert.ok(text.length <= 12000);
  const data = JSON.parse(text.slice(CONTINUATION_PREFIX.length + 2, text.indexOf('. Context was compacted')));
  assert.match(data.intentReference, /Shared user intent reference: .*"revision":1.*re-read task_intent/);
  assert.ok(data.taskBrief.startsWith('BRIEF')); assert.deepEqual(data.checkpointTarget, { objective:'obj', expectedEvidence:'ev' });
  assert.equal(data.latestCheckpoint.progressState, 'working'); assert.deepEqual(data.checkResults, [{ id:'backend', status:'passed', mode:'local', evidence:'npm test exit 0' }]);
  // Stale evidence revision and a brief from another generation are not carried.
  const stale = buildContinuation({ ...record, handoffBrief:{ generation:1, text:'old' } }, { intent:entry, evidence:{ revision:0, checks:{ a:{ id:'a', status:'passed' } } } });
  assert.doesNotMatch(stale, /checkResults|taskBrief/);
});

// ---- integration through the installed hooks ----
async function harness(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mid-run-compaction-')); t.after(() => fsp.rm(dir, { recursive:true, force:true }));
  const sessions = [{ id:'root', agent:'router', directory:'/project', active:true }], calls = [], tools = new Map(), compactions = [];
  const native = { name:'subagent', description:'Native subagent', input:{ type:'object', properties:{ agent:{type:'string'}, description:{type:'string'}, prompt:{type:'string'}, model:{type:'string'}, sessionID:{type:'string'}, background:{type:'boolean'} }, required:['agent','description','prompt'] },
    execute:async (input, context) => {
      calls.push(input); const id = input.sessionID ?? `ses_${calls.length}`; let child = sessions.find(s => s.id === id);
      if (!child) { child = { id, parentID:context.sessionID, agent:input.agent, directory:'/project', active:true }; sessions.push(child); }
      await context.progress({ sessionID:id, status:'running' }); child.active = true;
      return { output:{ sessionID:id, status:'running', output:'OK' }, content:'OK', metadata:{ sessionID:id, status:'running' } };
    } };
  tools.set('subagent', native);
  const ctx = { location:{ directory:'/project' }, agent:{ list:async () => ({ data:Object.entries(agents).map(([id, a]) => ({ id, ...a })) }) },
    tool:{ transform:async fn => fn({ get:n => tools.get(n), update:(n, fn) => fn(tools.get(n)), add:tool => tools.set(tool.name, tool) }) } };
  const registry = createRegistry(dir); await registry('/project', async (state, save) => { setIntent(state, { rootID:'root', taskId:'release', intent, expectedRevision:0, actorSessionID:'root' }); await save(); });
  const hooks = new Map(); ctx.session = { hook:async (name, fn) => { const previous = hooks.get(name); hooks.set(name, async event => { if (previous) await previous(event); return fn(event); }); },
    compact:async input => { compactions.push(input); } };
  await installTaskDispatch(ctx, { registry, globalRegistry:createRegistry(path.join(dir, 'global-writers')), loadSessions:async () => sessions, loadSources:async () => ['msg_user'], loadRoutingPolicy:() => undefined });
  const call = (input, tool = 'task_dispatch') => tools.get(tool).execute(input, { sessionID:'root', agent:'router', progress:async () => {} });
  const step = async id => { const event = { sessionID:id, agent:'builder', system:[] }; await hooks.get('context')(event); return event; };
  return { call, sessions, calls, ctx, registry, hooks, compactions, step };
}

test('a running builder is compacted at a step boundary once it crosses the threshold, and only once per growth', async t => {
  const h = await harness(t);
  const id = (await h.call(base)).metadata.sessionID; const child = h.sessions.find(s => s.id === id);
  Object.assign(child, { contextTokens:100000, contextMessageID:'msg_u1', lastAssistantID:'msg_a1', activity:{ runningTools:[] } });
  await h.step(id); assert.equal(h.compactions.length, 0);
  // A tool still running in native state: never compact.
  Object.assign(child, { contextTokens:284000, contextMessageID:'msg_u2', lastAssistantID:'msg_a2', activity:{ runningTools:[{ toolID:'call', name:'shell', status:'streaming' }] } });
  await h.step(id); assert.equal(h.compactions.length, 0);
  child.activity = { runningTools:[] };
  const before = await h.step(id);
  let marker; await h.registry('/project', async state => { marker = state.records[0].completionBinding.marker; });
  assert.deepEqual(h.compactions, [{ sessionID:id, id:midRunCompactionID(marker, 1) }]);
  assert.equal(before.system.some(p => p.text.startsWith(CONTINUATION_PREFIX)), false);
  // Repeated boundaries while pending do not compact again.
  await h.step(id); await h.step(id); assert.equal(h.compactions.length, 1);
  // The native summary request receives the preserved assignment.
  const summary = { sessionID:id, system:[] }; await h.hooks.get('compaction')(summary);
  assert.match(summary.system[0].text, /BRIEF-SENTINEL/); assert.match(summary.system[0].text, /Shared user intent reference/);
  // Native completion settles it; later requests carry the frozen continuation.
  Object.assign(child, { lastCompaction:{ id:h.compactions[0].id, status:'completed' }, contextTokens:30000, contextMessageID:'msg_u3', lastAssistantID:'msg_a3' });
  const after = await h.step(id);
  const continuation = after.system.find(p => p.text.startsWith(CONTINUATION_PREFIX));
  assert.ok(continuation); assert.match(continuation.text, /BRIEF-SENTINEL/);
  const again = await h.step(id); assert.equal(again.system.find(p => p.text.startsWith(CONTINUATION_PREFIX)).text, continuation.text);
  const noPending = { sessionID:id, system:[] }; await h.hooks.get('compaction')(noPending); assert.deepEqual(noPending.system, []);
  // Still below threshold after compaction: nothing more.
  assert.equal(h.compactions.length, 1);
  Object.assign(child, { contextTokens:125000, contextMessageID:'msg_u4', lastAssistantID:'msg_a4' });
  await h.step(id); assert.equal(h.compactions.length, 2); assert.equal(h.compactions[1].id, midRunCompactionID(marker, 2));
  // Status exposes bounded metadata, never the brief or continuation text.
  const status = (await h.call({ taskId:'release' }, 'task_dispatch_status')).content;
  assert.doesNotMatch(status, /BRIEF-SENTINEL/);
  const owner = JSON.parse(status).owners[0];
  assert.equal(owner.midRunCompaction.count, 2); assert.equal(owner.midRunCompaction.pending.id, h.compactions[1].id); assert.equal(owner.handoffBrief, undefined);
});

test('an explicit parent compaction, a stale intent, or a failed native admission prevents compaction loops', async t => {
  const h = await harness(t);
  const id = (await h.call(base)).metadata.sessionID; const child = h.sessions.find(s => s.id === id);
  Object.assign(child, { contextTokens:200000, contextMessageID:'msg_u1', lastAssistantID:'msg_a1', activity:{ runningTools:[] } });
  // An unsettled explicit compaction owns the compaction-wait lock.
  await h.registry('/project', async (state, save) => { state.records[0].compactionID = 'msg_parent'; await save(); });
  await h.step(id); assert.equal(h.compactions.length, 0);
  await h.registry('/project', async (state, save) => { state.records[0].compactionOutcome = { id:'msg_parent', status:'completed' }; await save(); });
  // Native admission conflict: recorded, not retried for the same observation, stops after the failure cap.
  h.ctx.session.compact = async input => { h.compactions.push(input); throw new Error('CompactionConflictError'); };
  await h.step(id); await h.step(id); assert.equal(h.compactions.length, 1);
  Object.assign(child, { contextMessageID:'msg_u2', lastAssistantID:'msg_a2' }); await h.step(id); assert.equal(h.compactions.length, 2);
  Object.assign(child, { contextMessageID:'msg_u3', lastAssistantID:'msg_a3' }); await h.step(id); assert.equal(h.compactions.length, 2);
  assert.notEqual(h.compactions[0].id, h.compactions[1].id);
  // Steps are never blocked by maintenance failures.
  const h2 = await harness(t);
  const id2 = (await h2.call(base)).metadata.sessionID; Object.assign(h2.sessions.find(s => s.id === id2), { contextTokens:200000, contextMessageID:'m', lastAssistantID:'a', activity:{ runningTools:[] } });
  await h2.registry('/project', async (state, save) => { setIntent(state, { rootID:'root', taskId:'release', intent:{ ...intent, outcome:'Corrected' }, expectedRevision:1, actorSessionID:'root' }); await save(); });
  await h2.step(id2); assert.equal(h2.compactions.length, 0);
});

test('HARNESS_MID_RUN_COMPACTION=off stops new mid-run admissions', async t => {
  const { midRunCompactionEnabled } = await import('../plugins/v2/mid-run-compaction.mjs');
  assert.equal(midRunCompactionEnabled({}), true); assert.equal(midRunCompactionEnabled({ HARNESS_MID_RUN_COMPACTION:'on' }), true);
  for (const value of ['off', '0', 'false', ' OFF ']) assert.equal(midRunCompactionEnabled({ HARNESS_MID_RUN_COMPACTION:value }), false);
  const h = await harness(t);
  const id = (await h.call(base)).metadata.sessionID;
  Object.assign(h.sessions.find(s => s.id === id), { contextTokens:300000, contextMessageID:'m', lastAssistantID:'a', activity:{ runningTools:[] } });
  process.env.HARNESS_MID_RUN_COMPACTION = 'off';
  try { await h.step(id); } finally { delete process.env.HARNESS_MID_RUN_COMPACTION; }
  assert.equal(h.compactions.length, 0);
  await h.step(id); assert.equal(h.compactions.length, 1);
});
