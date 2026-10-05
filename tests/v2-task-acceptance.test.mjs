import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createArtifactStore, createV2TaskOutcomes } from '../plugins/v2/task-outcomes.mjs';

async function harness(plugin) {
  const tools = new Map();
  const ctx = { tool: { transform: async callback => callback({ add: tool => tools.set(tool.name, tool) }) }, event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) } };
  return { tools, cleanup: await plugin.setup(ctx) };
}
const call = (sessionID = 's1') => ({ sessionID, messageID: 'm1', agent: 'builder' });
const contract = { goal: 'prove the result', authorization: 'user authorized this task', checks: [{ id: 'network', description: 'reach controlled endpoint', mode: 'live' }, { id: 'unit', description: 'run unit test', mode: 'local' }] };
const results = [{ id: 'network', status: 'passed', mode: 'live', evidence: 'HTTP 200 from controlled endpoint' }, { id: 'unit', status: 'passed', mode: 'local', evidence: 'node --test passed' }];
function memoryPlugin(rows = [], store = new Map(), artifactStore = new Map(), append = async row => rows.push(row)) {
  return createV2TaskOutcomes({ append, loadContract: async (sessionID, taskID) => store.get(`${sessionID}\0${taskID}`), saveContract: async (sessionID, taskID, value) => { const key = `${sessionID}\0${taskID}`; if (store.has(key)) return false; store.set(key, value); return true; }, loadArtifacts: async (sessionID, taskID) => ({ ...(artifactStore.get(`${sessionID}\0${taskID}`) ?? {}) }), mutateArtifacts: async (sessionID, taskID, mutation) => { const key = `${sessionID}\0${taskID}`, result = await mutation({ ...(artifactStore.get(key) ?? {}) }); if (result.artifacts) artifactStore.set(key, result.artifacts); return result.value; } });
}
async function start(tool, taskId = 't1', sessionID = 's1') { await tool.execute({ taskId, scope: 'task', status: 'in_progress', contract }, call(sessionID)); }

test('task completion requires every contracted id to pass in its contracted mode', async () => {
  const rows = [], h = await harness(memoryPlugin(rows)); const tool = h.tools.get('task_outcome'); await start(tool);
  await assert.rejects(tool.execute({ taskId: 't1', scope: 'task', status: 'completed', results: [{ ...results[0], mode: 'synthetic' }, results[1]] }, call()), /mode live/);
  await assert.rejects(tool.execute({ taskId: 't1', scope: 'task', status: 'completed', results: [results[0]] }, call()), /match every/);
  await assert.rejects(tool.execute({ taskId: 't1', scope: 'task', status: 'completed', results: [...results, { ...results[1] }] }, call()), /duplicate result id/);
  await tool.execute({ taskId: 't1', scope: 'task', status: 'completed', results }, call());
  assert.equal(rows.at(-1).scope, 'task'); h.cleanup();
});

test('contract survives plugin recreation, is session-isolated, and cannot be rewritten', async () => {
  const rows = [], store = new Map(), first = await harness(memoryPlugin(rows, store)); await start(first.tools.get('task_outcome')); first.cleanup();
  const second = await harness(memoryPlugin(rows, store)); const tool = second.tools.get('task_outcome');
  assert.deepEqual((await second.tools.get('task_contract').execute({ taskId: 't1' }, call())).details, { contract, artifacts: {} });
  await assert.rejects(tool.execute({ taskId: 't1', scope: 'task', status: 'in_progress', contract: { ...contract, goal: 'changed' } }, call()), /immutable/);
  await assert.rejects(tool.execute({ taskId: 't1', scope: 'task', status: 'completed', results }, call('s2')), /existing contract/);
  second.cleanup();
});

test('artifact-bound checks require a receipt for the latest declared revision, including in-progress claims', async () => {
  const rows = [], artifactContract = { ...contract, checks: [{ id: 'build', description: 'build backend target', mode: 'local', artifact: 'backend' }, contract.checks[1]] };
  const h = await harness(memoryPlugin(rows)); const outcome = h.tools.get('task_outcome'), artifact = h.tools.get('task_artifact');
  await outcome.execute({ taskId: 'artifact-task', scope: 'task', status: 'in_progress', contract: artifactContract }, call());
  const passed = { id: 'build', status: 'passed', mode: 'local', evidence: 'build passed', artifact: { subject: 'backend', revision: 'rev-1', generation: 1 } };
  await assert.rejects(outcome.execute({ taskId: 'artifact-task', scope: 'task', status: 'in_progress', results: [passed] }, call()), /current artifact backend receipt/);
  await artifact.execute({ taskId: 'artifact-task', subject: 'backend', revision: 'rev-1' }, call());
  await assert.rejects(outcome.execute({ taskId: 'artifact-task', scope: 'task', status: 'completed', results: [{ ...passed, artifact: { subject: 'mobile', revision: 'rev-1', generation: 1 } }, results[1]] }, call()), /current artifact backend receipt/);
  await outcome.execute({ taskId: 'artifact-task', scope: 'task', status: 'completed', results: [passed, results[1]] }, call());
  h.cleanup();
});

test('revision changes invalidate older artifact evidence and artifacts survive recreation per session', async () => {
  const rows = [], contracts = new Map(), artifacts = new Map(), artifactContract = { ...contract, checks: [{ id: 'build', description: 'build backend target', mode: 'local', artifact: 'backend' }, contract.checks[1]] };
  const first = await harness(memoryPlugin(rows, contracts, artifacts)); const outcome = first.tools.get('task_outcome'), artifact = first.tools.get('task_artifact');
  await outcome.execute({ taskId: 'artifact-task', scope: 'task', status: 'in_progress', contract: artifactContract }, call());
  await artifact.execute({ taskId: 'artifact-task', subject: 'backend', revision: 'rev-1' }, call());
  await artifact.execute({ taskId: 'artifact-task', subject: 'backend', revision: 'rev-2' }, call()); first.cleanup();
  const second = await harness(memoryPlugin(rows, contracts, artifacts)); const stale = { id: 'build', status: 'passed', mode: 'local', evidence: 'old build passed', artifact: { subject: 'backend', revision: 'rev-1', generation: 1 } };
  await assert.rejects(second.tools.get('task_outcome').execute({ taskId: 'artifact-task', scope: 'task', status: 'completed', results: [stale, results[1]] }, call()), /current artifact backend receipt/);
  assert.deepEqual((await second.tools.get('task_contract').execute({ taskId: 'artifact-task' }, call())).details.artifacts, { backend: { revision: 'rev-2', generation: 2, selfReported: true } });
  assert.deepEqual((await second.tools.get('task_contract').execute({ taskId: 'artifact-task' }, call('other-session'))).details, undefined);
  second.cleanup();
});

test('concurrent artifact declarations retain independent subjects through the injected atomic updater', async () => {
  const rows = [], contracts = new Map(), artifacts = new Map(); const h = await harness(memoryPlugin(rows, contracts, artifacts)); const tool = h.tools.get('task_artifact');
  await Promise.all([tool.execute({ taskId: 'parallel', subject: 'backend', revision: 'a1' }, call()), tool.execute({ taskId: 'parallel', subject: 'worker', revision: 'b1' }, call())]);
  assert.deepEqual((await h.tools.get('task_contract').execute({ taskId: 'parallel' }, call())).details, undefined);
  // Artifacts may be registered before a contract, and remain isolated to the calling session.
  assert.deepEqual(artifacts.get('s1\0parallel'), { backend: { revision: 'a1', generation: 1, selfReported: true }, worker: { revision: 'b1', generation: 1, selfReported: true } });
  h.cleanup();
});

test('filesystem artifact store serializes concurrent mutations without lost declarations', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-artifacts-'));
  try {
    const store = createArtifactStore(directory);
    await Promise.all(['backend', 'worker'].map(subject => store('s1', 'parallel', async current => ({ artifacts: { ...current, [subject]: { revision: `${subject}-1`, generation: 1, selfReported: true } } }))));
    const artifacts = await store('s1', 'parallel', async current => ({ value: current }));
    assert.deepEqual(artifacts, { backend: { revision: 'backend-1', generation: 1, selfReported: true }, worker: { revision: 'worker-1', generation: 1, selfReported: true } });
  } finally { await fs.rm(directory, { recursive: true, force: true }); await fs.rm(`${directory}-locks`, { recursive: true, force: true }); }
});

test('a target update waits for the receipt append transaction and old generations cannot later pass', async () => {
  const rows = [], contracts = new Map(), artifacts = new Map(), artifactContract = { ...contract, checks: [{ id: 'build', description: 'build backend target', mode: 'local', artifact: 'backend' }, contract.checks[1]] };
  let appendStarted; const started = new Promise(resolve => { appendStarted = resolve; }); let releaseAppend; const release = new Promise(resolve => { releaseAppend = resolve; });
  const h = await harness(memoryPlugin(rows, contracts, artifacts, async row => { if (!row.results?.length) { rows.push(row); return; } appendStarted(); await release; rows.push(row); })); const outcome = h.tools.get('task_outcome'), artifact = h.tools.get('task_artifact');
  await outcome.execute({ taskId: 'race', scope: 'task', status: 'in_progress', contract: artifactContract }, call());
  await artifact.execute({ taskId: 'race', subject: 'backend', revision: 'rev-1' }, call());
  const receipt = { id: 'build', status: 'passed', mode: 'local', evidence: 'build passed', artifact: { subject: 'backend', revision: 'rev-1', generation: 1 } };
  const recorded = outcome.execute({ taskId: 'race', scope: 'task', status: 'in_progress', results: [receipt] }, call()); await started;
  let updateFinished = false; const update = artifact.execute({ taskId: 'race', subject: 'backend', revision: 'rev-2' }, call()).then(value => { updateFinished = true; return value; });
  await Promise.resolve(); assert.equal(updateFinished, false);
  releaseAppend(); await recorded; await update;
  assert.deepEqual(rows.at(-1).observedArtifactGenerations, [{ checkId: 'build', subject: 'backend', revision: 'rev-1', generation: 1, selfReported: true }]);
  await assert.rejects(outcome.execute({ taskId: 'race', scope: 'task', status: 'completed', results: [receipt, results[1]] }, call()), /current artifact backend receipt/);
  h.cleanup();
});

test('declaring an unchanged target revision preserves its generation', async () => {
  const h = await harness(memoryPlugin()); const artifact = h.tools.get('task_artifact');
  const first = await artifact.execute({ taskId: 'same', subject: 'backend', revision: 'rev-1' }, call());
  const second = await artifact.execute({ taskId: 'same', subject: 'backend', revision: 'rev-1' }, call());
  assert.equal(first.details.artifacts.backend.generation, 1);
  assert.equal(second.details.artifacts.backend.generation, 1);
  h.cleanup();
});

test('checkpoints remain distinct and blocked outcomes require useful evidence', async () => {
  const rows = [], h = await harness(memoryPlugin(rows)); const tool = h.tools.get('task_outcome');
  await tool.execute({ taskId: 'cp', scope: 'checkpoint', status: 'completed' }, call());
  assert.equal(rows[0].scope, 'checkpoint'); assert.match(rows[0].selfReported ? 'self-reported' : '', /self/);
  await assert.rejects(tool.execute({ taskId: 'blocked', scope: 'checkpoint', status: 'blocked' }, call()), /require blocker/);
  await tool.execute({ taskId: 'blocked', scope: 'checkpoint', status: 'blocked', blocker: { kind: 'tool_permission', evidence: 'tool denied operation', nextAction: 'request permission' } }, call());
  assert.equal(rows.at(-1).blocker.kind, 'tool_permission'); h.cleanup();
});

test('task terminal outcomes retain the initial contract and reject blank evidence', async () => {
  const rows = [], h = await harness(memoryPlugin(rows)); const tool = h.tools.get('task_outcome');
  await assert.rejects(tool.execute({ taskId: 'no-contract-blocked', scope: 'task', status: 'blocked', blocker: { kind: 'environment', evidence: 'service unavailable', nextAction: 'retry later' } }, call()), /terminal outcome requires an existing contract/);
  await assert.rejects(tool.execute({ taskId: 'no-contract-failed', scope: 'task', status: 'failed' }, call()), /terminal outcome requires an existing contract/);
  await start(tool, 'stopped');
  await tool.execute({ taskId: 'stopped', scope: 'task', status: 'blocked', blocker: { kind: 'environment', evidence: 'service unavailable', nextAction: 'retry later' } }, call());
  await tool.execute({ taskId: 'stopped', scope: 'task', status: 'failed' }, call());
  await assert.rejects(tool.execute({ taskId: 'blank', scope: 'checkpoint', status: 'blocked', blocker: { kind: 'environment', evidence: '   ', nextAction: 'retry later' } }, call()), /invalid blocker.evidence/);
  h.cleanup();
});

test('dependency waits stay in progress and require bounded non-self references', async () => {
 const rows=[], h=await harness(memoryPlugin(rows)), tool=h.tools.get('task_outcome');
 const waiting={taskId:'cp',scope:'checkpoint',status:'in_progress',progressState:'waiting_dependency',dependencySessionIDs:['ses_other']};
 await tool.execute(waiting,call());assert.equal(rows.at(-1).progressState,'waiting_dependency');
 for(const change of [{dependencySessionIDs:undefined},{dependencySessionIDs:['s1']},{dependencySessionIDs:['ses_other','ses_other']},{status:'completed'},{status:'blocked'}])await assert.rejects(tool.execute({...waiting,...change},call()),/task-outcomes:/);
 await assert.rejects(tool.execute({...waiting,progressState:'needs_user_action'},call()),/progressState/);
 await tool.execute({taskId:'cp',scope:'checkpoint',status:'blocked',progressState:'needs_user_action',blocker:{kind:'authorization',evidence:'Operation awaits approval',nextAction:'User must approve operation'}},call());
 assert.equal(rows.at(-1).progressState,'needs_user_action');h.cleanup();
});
