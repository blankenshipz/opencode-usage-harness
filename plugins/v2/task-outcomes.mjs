import { createMilestoneStore, installMilestoneSignals } from './milestones.mjs';
import { installEditRecovery } from './edit-recovery.mjs';
import { installProgressSnapshots } from './progress-snapshots.mjs';
import { installTaskDispatch } from './task-dispatch.mjs';
import { createRegistry } from './dispatch-registry.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { statePath } from './paths.mjs';

const statuses = ['in_progress', 'completed', 'blocked', 'failed'];
const scopes = ['task', 'checkpoint'];
const reasons = ['task_complexity', 'risk', 'verification_failure', 'user_override', 'quota_pressure', 'none'];
const efforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const checkModes = ['live', 'local', 'synthetic'];
const resultStatuses = ['passed', 'failed', 'blocked', 'not_run'];
const blockerKinds = ['authorization', 'tool_permission', 'environment', 'credential', 'implementation'];
const text = (value, name, max = 128) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\r\n]/.test(value)) throw new Error(`task-outcomes: invalid ${name}`);
  return value;
};
const contractKey = (sessionID, taskID) => crypto.createHash('sha256').update(`${sessionID}\0${taskID}`).digest('hex');
const contractPath = (sessionID, taskID) => statePath('task-contracts', `${contractKey(sessionID, taskID)}.json`);
const artifactDirectory = statePath('task-artifacts');
const artifactPath = (sessionID, taskID, directory = artifactDirectory) => path.join(directory, `${contractKey(sessionID, taskID)}.json`);
async function loadStoredContract(sessionID, taskID) {
  try { return JSON.parse(await fs.readFile(contractPath(sessionID, taskID), 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return undefined; throw error; }
}
async function saveStoredContract(sessionID, taskID, contract) {
  const file = contractPath(sessionID, taskID), directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 }); await fs.chmod(directory, 0o700);
  const temporary = path.join(directory, `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, JSON.stringify(contract), { mode: 0o600 }); await fs.chmod(temporary, 0o600);
    try { await fs.link(temporary, file); } catch (error) { if (error?.code === 'EEXIST') return false; throw error; }
    await fs.chmod(file, 0o600); return true;
  }
  finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}
function normalizeArtifacts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('task-outcomes: invalid artifact store');
  return Object.fromEntries(Object.entries(value).map(([subject, declaration]) => {
    const revision = typeof declaration === 'string' ? declaration : declaration?.revision;
    if (typeof declaration !== 'string' && (!declaration || typeof declaration !== 'object' || Array.isArray(declaration) || declaration.selfReported !== true)) throw new Error('task-outcomes: invalid artifact declaration');
    const generation = typeof declaration === 'string' ? 1 : declaration.generation;
    if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('task-outcomes: invalid artifact generation');
    return [text(subject, 'artifact.subject'), { revision: text(revision, 'artifact.revision', 500), generation, selfReported: true }];
  }));
}
async function loadStoredArtifacts(sessionID, taskID) {
  try { return normalizeArtifacts(JSON.parse(await fs.readFile(artifactPath(sessionID, taskID), 'utf8'))); }
  catch (error) { if (error?.code === 'ENOENT') return {}; throw error; }
}
async function writeStoredArtifacts(file, artifacts) {
  const directory = path.dirname(file), temporary = path.join(directory, `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  try { await fs.writeFile(temporary, JSON.stringify(artifacts), { mode: 0o600 }); await fs.chmod(temporary, 0o600); await fs.rename(temporary, file); await fs.chmod(file, 0o600); }
  finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}
export function createArtifactStore(directory = artifactDirectory) {
  const lockDirectory = `${directory}-locks`, registry = createRegistry(lockDirectory);
  return async (sessionID, taskID, operation) => {
  const file = artifactPath(sessionID, taskID, directory);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 }); await fs.chmod(directory, 0o700);
  await fs.mkdir(lockDirectory, { recursive: true, mode: 0o700 }); await fs.chmod(lockDirectory, 0o700);
  return registry(`${sessionID}\0${taskID}`, async () => {
    let artifacts = {};
    try { artifacts = normalizeArtifacts(JSON.parse(await fs.readFile(file, 'utf8'))); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    const mutation = await operation({ ...artifacts });
    if (!mutation || typeof mutation !== 'object' || Array.isArray(mutation)) throw new Error('task-outcomes: invalid artifact mutation');
    if (mutation.artifacts !== undefined) await writeStoredArtifacts(file, normalizeArtifacts(mutation.artifacts));
    return mutation.value;
  });
  };
}
const mutateStoredArtifacts = createArtifactStore();
function normalizeContract(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('task-outcomes: invalid contract');
  const goal = text(value.goal, 'contract.goal', 500), authorization = text(value.authorization, 'contract.authorization', 500);
  if (!Array.isArray(value.checks) || value.checks.length < 1 || value.checks.length > 12) throw new Error('task-outcomes: invalid contract.checks');
  const ids = new Set(); const checks = value.checks.map((check, index) => {
    if (!check || typeof check !== 'object' || Array.isArray(check)) throw new Error(`task-outcomes: invalid contract.checks[${index}]`);
    const id = text(check.id, `contract.checks[${index}].id`); if (ids.has(id)) throw new Error('task-outcomes: duplicate contract check id'); ids.add(id);
    const description = text(check.description, `contract.checks[${index}].description`, 500);
    if (!checkModes.includes(check.mode)) throw new Error('task-outcomes: invalid contract check mode');
    const artifact = check.artifact === undefined ? undefined : text(check.artifact, `contract.checks[${index}].artifact`);
    return artifact === undefined ? { id, description, mode: check.mode } : { id, description, mode: check.mode, artifact };
  });
  return { goal, checks, authorization };
}
function normalizeResults(value) {
  if (!Array.isArray(value) || value.length > 12) throw new Error('task-outcomes: invalid results');
  const ids = new Set(); return value.map((result, index) => {
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(`task-outcomes: invalid results[${index}]`);
    const id = text(result.id, `results[${index}].id`); if (ids.has(id)) throw new Error('task-outcomes: duplicate result id'); ids.add(id);
    if (!resultStatuses.includes(result.status) || !checkModes.includes(result.mode)) throw new Error('task-outcomes: invalid result status or mode');
    let artifact;
    if (result.artifact !== undefined) {
      if (!result.artifact || typeof result.artifact !== 'object' || Array.isArray(result.artifact)) throw new Error(`task-outcomes: invalid results[${index}].artifact`);
      if (!Number.isSafeInteger(result.artifact.generation) || result.artifact.generation < 1) throw new Error(`task-outcomes: invalid results[${index}].artifact.generation`);
      artifact = { subject: text(result.artifact.subject, `results[${index}].artifact.subject`), revision: text(result.artifact.revision, `results[${index}].artifact.revision`, 500), generation: result.artifact.generation };
    }
    const normalized = { id, status: result.status, mode: result.mode, evidence: text(result.evidence, `results[${index}].evidence`, 500) };
    return artifact ? { ...normalized, artifact } : normalized;
  });
}
function normalizeBlocker(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !blockerKinds.includes(value.kind)) throw new Error('task-outcomes: invalid blocker');
  return { kind: value.kind, evidence: text(value.evidence, 'blocker.evidence', 2000), nextAction: text(value.nextAction, 'blocker.nextAction', 2000) };
}

export function createV2TaskOutcomes({ dispatchOptions = {}, milestoneStore = createMilestoneStore(), append = async record => {
  const file = statePath('telemetry', 'task-outcomes.jsonl'); await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const handle = await fs.open(file, 'a', 0o600); try { await handle.writeFile(JSON.stringify(record) + '\n'); } finally { await handle.close(); } await fs.chmod(file, 0o600);
}, loadContract = loadStoredContract, saveContract = saveStoredContract, loadArtifacts = loadStoredArtifacts, mutateArtifacts = mutateStoredArtifacts, now = () => Date.now() } = {}) {
  return { id: 'subscription.task-outcomes', async setup(ctx) {
    const shared = await installTaskDispatch(ctx,dispatchOptions);
    const stopSnapshots = installProgressSnapshots(ctx);
    const stopMilestones = installMilestoneSignals(ctx,milestoneStore);
    const stopEditRecovery = await installEditRecovery(ctx);
    const withIntentOutcome = shared?.outcome ?? ((_args,_call,run)=>run(null));
    const tasks = new Map(), messages = new Map(), artifactUpdates = new Map(), controller = new AbortController();
    const mutateCurrentArtifacts = (sessionID, taskID, mutation) => {
      const key = JSON.stringify([sessionID, taskID]), previous = artifactUpdates.get(key) ?? Promise.resolve();
      const pending = previous.catch(() => {}).then(() => mutateArtifacts(sessionID, taskID, mutation));
      artifactUpdates.set(key, pending);
      return pending.finally(() => { if (artifactUpdates.get(key) === pending) artifactUpdates.delete(key); });
    };
    await ctx.tool.transform(editor => editor.add({ name: 'task_outcome', description: 'Record a self-reported task or checkpoint outcome. Task completion requires every contracted check to pass with matching mode; recorded evidence does not independently prove network activity.', input: { type: 'object', additionalProperties: false, properties: {
      taskId: { type: 'string', minLength: 1, maxLength: 128 }, intentRevision:{type:'integer',minimum:1}, scope: { type: 'string', enum: scopes }, status: { type: 'string', enum: statuses },
      contract: { type: 'object', additionalProperties: false, properties: { goal: { type: 'string', minLength: 1, maxLength: 500 }, authorization: { type: 'string', minLength: 1, maxLength: 500 }, checks: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', minLength: 1, maxLength: 128 }, description: { type: 'string', minLength: 1, maxLength: 500 }, mode: { type: 'string', enum: checkModes }, artifact: { type: 'string', minLength: 1, maxLength: 128 } }, required: ['id', 'description', 'mode'] } } }, required: ['goal', 'checks', 'authorization'] },
      results: { type: 'array', maxItems: 12, items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', minLength: 1, maxLength: 128 }, status: { type: 'string', enum: resultStatuses }, mode: { type: 'string', enum: checkModes }, evidence: { type: 'string', minLength: 1, maxLength: 500 }, artifact: { type: 'object', additionalProperties: false, properties: { subject: { type: 'string', minLength: 1, maxLength: 128 }, revision: { type: 'string', minLength: 1, maxLength: 500 }, generation: { type: 'integer', minimum: 1 } }, required: ['subject', 'revision', 'generation'] } }, required: ['id', 'status', 'mode', 'evidence'] } },
      blocker: { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', enum: blockerKinds }, evidence: { type: 'string', minLength: 1, maxLength: 2000 }, nextAction: { type: 'string', minLength: 1, maxLength: 2000 } }, required: ['kind', 'evidence', 'nextAction'] },
      selected: { type: 'object', additionalProperties: false, properties: { agent: { type: 'string', maxLength: 128 }, model: { type: 'string', maxLength: 128 }, effort: { type: 'string', enum: efforts } } }, escalationReason: { type: 'string', enum: reasons }, validationEvidence: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 500 } }, repairs: { type: 'integer', minimum: 0, maximum: 1000 }, userCorrections: { type: 'integer', minimum: 0, maximum: 1000 }
    }, required: ['taskId', 'scope', 'status'] }, execute: async (args, call) => withIntentOutcome(args,call,async sharedContract => {
      const taskID = text(args.taskId, 'taskId'), sessionID = text(call.sessionID, 'sessionID');
      if (!scopes.includes(args.scope) || !statuses.includes(args.status) || (args.escalationReason !== undefined && !reasons.includes(args.escalationReason))) throw new Error('task-outcomes: invalid scope, status or reason');
      for (const count of ['repairs', 'userCorrections']) if (args[count] !== undefined && (!Number.isSafeInteger(args[count]) || args[count] < 0 || args[count] > 1000)) throw new Error(`task-outcomes: invalid ${count}`);
      const contract = args.contract === undefined ? undefined : normalizeContract(args.contract), results = args.results === undefined ? undefined : normalizeResults(args.results), blocker = args.blocker === undefined ? undefined : normalizeBlocker(args.blocker);
      if (args.status === 'blocked' && !blocker) throw new Error('task-outcomes: blocked outcomes require blocker evidence and nextAction'); if (args.status !== 'blocked' && blocker) throw new Error('task-outcomes: blocker is only valid for blocked outcomes');
      let artifactChecks = new Map();
      if(sharedContract) artifactChecks = new Map(sharedContract.checks.filter(c=>c.artifact).map(c=>[c.id,c]));
      if (args.scope === 'task') {
        let stored = sharedContract ?? await loadContract(sessionID, taskID);
        if (contract && !sharedContract) {
          if (!stored && args.status !== 'in_progress') throw new Error('task-outcomes: new contracts require task in_progress');
          if (stored && JSON.stringify(stored) !== JSON.stringify(contract)) throw new Error('task-outcomes: task contract is immutable; use a new taskId for changed scope');
          if (!stored) { const created = await saveContract(sessionID, taskID, contract); stored = created === false ? await loadContract(sessionID, taskID) : contract; if (!stored || JSON.stringify(stored) !== JSON.stringify(contract)) throw new Error('task-outcomes: task contract is immutable; use a new taskId for changed scope'); }
        }
        else if (args.status === 'in_progress' && !stored) throw new Error('task-outcomes: initial task in_progress requires a contract');
        if (['completed', 'blocked', 'failed'].includes(args.status) && !stored) throw new Error('task-outcomes: task terminal outcome requires an existing contract; start task in_progress with contract');
        artifactChecks = new Map(stored?.checks.filter(check => check.artifact).map(check => [check.id, check]) ?? []);
        if (args.status === 'completed') { if (!results) throw new Error('task-outcomes: task completion requires results for every contracted check'); const byID = new Map(results.map(result => [result.id, result])); if (byID.size !== stored.checks.length || stored.checks.some(check => !byID.has(check.id))) throw new Error('task-outcomes: completion results must match every contracted check id'); for (const check of stored.checks) { const result = byID.get(check.id); if (result.status !== 'passed' || result.mode !== check.mode) throw new Error(`task-outcomes: contracted check ${check.id} must pass with mode ${check.mode}`); } }
      }
      const key = JSON.stringify([sessionID, taskID]), timestamp = now(); if (!tasks.has(key)) { if (tasks.size >= 512) tasks.delete(tasks.keys().next().value); tasks.set(key, timestamp); }
      const actor = messages.get(JSON.stringify([sessionID, call.messageID])), selected = args.selected && Object.fromEntries(Object.entries(args.selected).map(([k, v]) => [k, text(v, k)])); if (selected?.effort && !efforts.includes(selected.effort)) throw new Error('task-outcomes: invalid effort'); if (args.validationEvidence && (!Array.isArray(args.validationEvidence) || args.validationEvidence.length > 8 || args.validationEvidence.some(v => typeof v !== 'string' || v.length > 500))) throw new Error('task-outcomes: invalid evidence');
      const appendRecord = async artifacts => {
        const observedArtifactGenerations = [];
        for (const result of results ?? []) {
          const check = artifactChecks.get(result.id);
          if (!check || result.status !== 'passed') continue;
          const target = artifacts[check.artifact];
          if (!result.artifact || result.artifact.subject !== check.artifact || target?.revision !== result.artifact.revision || target.generation !== result.artifact.generation) throw new Error(`task-outcomes: contracted check ${check.id} requires the current artifact ${check.artifact} receipt`);
          observedArtifactGenerations.push({ checkId: check.id, subject: check.artifact, revision: target.revision, generation: target.generation, selfReported: true });
        }
        const recorded = { schemaVersion: 2, recordedAt: new Date(timestamp).toISOString(), elapsedScope: 'process_observation', sessionId: sessionID, taskId: taskID, scope: args.scope, messageId: call.messageID, status: args.status, elapsedMs: Math.max(0, timestamp - tasks.get(key)), attribution: { intended: selected, recordingActor: actor ? { ...actor, agent: call.agent ?? null, source: 'message.updated', agentSource: 'tool.context', effortSource: actor.effort ? 'message.updated.variant' : 'unavailable', messageId: call.messageID } : undefined, actualKnown: !!actor }, escalationReason: args.escalationReason, validationEvidence: args.validationEvidence, results, blocker, repairs: args.repairs ?? 0, userCorrections: args.userCorrections ?? 0, observedArtifactGenerations: observedArtifactGenerations.length ? observedArtifactGenerations : undefined, selfReported: true };
        await append(recorded);
        try { await milestoneStore.record(recorded); } catch { /* UI reporting must not affect checkpoint acceptance. */ }
        return observedArtifactGenerations;
      };
      const observedArtifactGenerations = artifactChecks.size && results?.some(result => artifactChecks.has(result.id) && result.status === 'passed') ? await mutateCurrentArtifacts(sessionID, taskID, async artifacts => ({ value: await appendRecord(artifacts) })) : await appendRecord({});
      return { content: `Recorded ${args.scope} outcome ${taskID} (${args.status}); evidence is self-reported and does not independently prove network activity; actual model provenance ${actor ? 'linked' : 'not observed'}.`, details: observedArtifactGenerations.length ? { observedArtifactGenerations, selfReported: true } : undefined };
    }) }));
    await ctx.tool.transform(editor => editor.add({ name: 'task_artifact', description: 'Record the current self-reported target revision for a task artifact. This declaration is not an automatic validation of Git or any other provider.', input: { type: 'object', additionalProperties: false, properties: { taskId: { type: 'string', minLength: 1, maxLength: 128 }, subject: { type: 'string', minLength: 1, maxLength: 128 }, revision: { type: 'string', minLength: 1, maxLength: 500 } }, required: ['taskId', 'subject', 'revision'] }, execute: async (args, call) => { const sessionID = text(call.sessionID, 'sessionID'), taskID = text(args.taskId, 'taskId'), subject = text(args.subject, 'subject'), revision = text(args.revision, 'revision', 500); const artifacts = await mutateCurrentArtifacts(sessionID, taskID, current => { const prior = current[subject], generation = prior?.revision === revision ? prior.generation : (prior?.generation ?? 0) + 1, artifacts = { ...current, [subject]: { revision, generation, selfReported: true } }; return { artifacts, value: artifacts }; }); return { content: `Recorded self-reported artifact ${subject} revision generation ${artifacts[subject].generation} for task ${taskID}; this does not automatically validate Git or any provider.`, details: { taskId: taskID, artifacts } }; } }));
    await ctx.tool.transform(editor => editor.add({ name: 'task_contract', description: 'Return the current-session contract and current self-reported artifact targets for a task, if a contract was stored.', input: { type: 'object', additionalProperties: false, properties: { taskId: { type: 'string', minLength: 1, maxLength: 128 } }, required: ['taskId'] }, execute: async (args, call) => { const sessionID = text(call.sessionID, 'sessionID'), taskID = text(args.taskId, 'taskId'), contract = await loadContract(sessionID, taskID); const artifacts = contract ? await loadArtifacts(sessionID, taskID) : {}; const details = contract ? { contract, artifacts } : undefined; return { content: contract ? JSON.stringify({ taskId: taskID, ...details }) : `No contract found for task ${taskID} in this session.`, details }; } }));
    void (async () => { try { for await (const event of ctx.event.subscribe({ signal: controller.signal })) { if (event.type === 'session.deleted') { const sessionID = event.data.sessionID; for (const key of tasks.keys()) if (JSON.parse(key)[0] === sessionID) tasks.delete(key); for (const key of messages.keys()) if (JSON.parse(key)[0] === sessionID) messages.delete(key); } if (event.type !== 'session.step.started') continue; const info = event.data; if (messages.size >= 32768) messages.delete(messages.keys().next().value); messages.set(JSON.stringify([info.sessionID, info.assistantMessageID]), { model: `${info.model.providerID}/${info.model.id}`, effort: info.model.variant ?? null }); } } catch (error) { if (!controller.signal.aborted) console.error('task-outcomes provenance stopped', error); } })();
    return () => { controller.abort(); stopSnapshots(); stopMilestones(); stopEditRecovery(); shared?.dispose?.(); tasks.clear(); messages.clear(); artifactUpdates.clear(); };
  } };
}
export default createV2TaskOutcomes();
