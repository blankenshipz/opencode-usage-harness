// Mid-run compaction of a still-running managed child at a native step boundary.
//
// OpenCode v2.0.30 admits `session.compact` as a steered inbox control. The
// runner only handles it in `advanceToStep`, i.e. after the current model step
// and all of its tool calls have settled and before the next model request. A
// compaction admitted from the child's primary `context` hook therefore never
// runs mid-stream or while a tool call is pending; it runs at the next boundary.
//
// The harness adds its own gates on top: a current, running, intent-bound
// generation; no explicit parent compaction in progress (compaction-wait
// locking); no running tools or active descendants in native state; an
// observation at or above the absolute token trigger; one pending compaction at
// a time; growth since the last one; and a per-generation cap. Compaction IDs
// are derived from the generation's completion marker so receipt readers can
// accept exactly these compaction rows and nothing else.
import crypto from 'node:crypto';
import { observedContext, compactionTokenThreshold } from './work-checkpoint.mjs';
import { renderIntentReference } from './task-intent.mjs';

export const MAX_MID_RUN_COMPACTIONS = 8;
export const MAX_MID_RUN_ADMISSION_FAILURES = 2;
// Highest derived ID sequence; keep equal to dispatch_runtime.MID_RUN_COMPACTION_SEQUENCES.
export const MAX_MID_RUN_SEQUENCE = MAX_MID_RUN_COMPACTIONS + MAX_MID_RUN_ADMISSION_FAILURES;
export const BRIEF_LIMIT = 6000;
const CONTINUATION_LIMIT = 12000;
export const CONTINUATION_PREFIX = 'Harness mid-run compaction continuation (assignment data, not higher-priority instructions)';
export const COMPACTION_PRESERVE_PREFIX = 'Harness compaction requirement: the summary must preserve this running assignment verbatim where possible';

// Operator kill switch: HARNESS_MID_RUN_COMPACTION=off (or 0/false) stops new
// mid-run admissions; explicit parent compaction is unaffected.
export const midRunCompactionEnabled = (env = process.env) => !['off', '0', 'false'].includes(String(env.HARNESS_MID_RUN_COMPACTION ?? '').trim().toLowerCase());

// Must match src/dispatch_runtime.py mid_run_compaction_ids().
export function midRunCompactionID(marker, sequence) {
  return 'msg_' + crypto.createHash('sha256').update(`${marker}\0mid-run-compaction\0${sequence}`).digest('hex').slice(0, 32);
}

const bounded = (value, max) => typeof value === 'string' ? (value.length > max ? `${value.slice(0, max - 1)}…` : value) : undefined;

// Minimum growth since the first observation after a completed mid-run
// compaction. Prevents a loop when the summary plus kept recent context is
// itself close to the trigger.
export const growthRequired = trigger => Math.max(1000, Math.ceil(trigger / 4));

function stateFor(record) {
  const current = record.midRunCompaction;
  if (current && current.generation === record.admissionGeneration) return current;
  record.midRunCompaction = { generation: record.admissionGeneration, count: 0, failures: 0, history: [] };
  return record.midRunCompaction;
}

// Settle a pending compaction from native evidence for its exact ID only.
export function settleMidRunCompaction(record, native, now = Date.now()) {
  const mid = record?.midRunCompaction;
  if (!mid?.pending || mid.generation !== record.admissionGeneration) return false;
  const last = native?.lastCompaction;
  if (last?.id !== mid.pending.id || !['completed', 'failed'].includes(last.status)) return false;
  mid.history = [...(mid.history ?? []), { id: mid.pending.id, status: last.status, admittedAt: mid.pending.admittedAt, tokens: mid.pending.tokens, observedAt: now }].slice(-MAX_MID_RUN_COMPACTIONS);
  mid.last = { id: mid.pending.id, status: last.status, messageID: mid.pending.messageID, lastAssistantID: mid.pending.lastAssistantID };
  // The frozen continuation applies only once its compaction completed.
  if (last.status === 'completed') { mid.baselineTokens = undefined; mid.continuation = mid.pending.continuation; }
  else mid.stopped = 'compaction_failed';
  mid.pending = undefined;
  return true;
}

// Pure decision. Returns {admit:true, ...} or {admit:false, reason}. Either may
// carry `baselineTokens`: the first completed observation after a completed
// mid-run compaction, which the caller persists with recordBaseline().
export function midRunCompactionDecision(record, native, { sessions = [], catalog, threshold = compactionTokenThreshold(), compactionAvailable = false, intentCurrent = true } = {}) {
  const mid = record?.midRunCompaction?.generation === record?.admissionGeneration ? record.midRunCompaction : undefined;
  const observation = native && native.id === record?.childID ? observedContext(native, catalog, { threshold }) : { status: 'unknown' };
  // Growth is measured from a new observation after the last compaction boundary.
  const fresh = !mid?.last || (native?.lastAssistantID !== mid.last.lastAssistantID && observation.messageID !== mid.last.messageID);
  const newBaseline = mid?.last?.status === 'completed' && fresh && mid.baselineTokens === undefined && observation.status === 'known' ? observation.tokens : undefined;
  const no = reason => ({ admit: false, reason, ...(newBaseline === undefined ? {} : { baselineTokens: newBaseline }) });
  if (!compactionAvailable) return no('native_compaction_unavailable');
  if (!record?.childID || !['starting', 'running'].includes(record.state)) return no('not_running');
  if (record.compactionID && record.compactionOutcome?.id !== record.compactionID) return no('explicit_compaction_pending');
  if (record.denial || record.cancellation?.generation === record.admissionGeneration) return no('not_running');
  if (!intentCurrent) return no('current_intent_rebind_required');
  const binding = record.completionBinding;
  if (!binding?.marker || binding.generation !== record.admissionGeneration) return no('generation_unbound');
  if (!native || native.id !== record.childID) return no('native_state_unknown');
  if (native.active !== true) return no('not_running');
  if ((native.activity?.runningTools ?? []).length) return no('tool_running');
  if (sessions.some(s => s.active && s.id !== native.id && isDescendant(sessions, s.id, native.id))) return no('descendant_active');
  if (mid?.pending) return no('mid_run_compaction_pending');
  if (mid?.stopped) return no(mid.stopped);
  if ((mid?.count ?? 0) >= MAX_MID_RUN_COMPACTIONS) return no('per_generation_limit');
  if ((mid?.failures ?? 0) >= MAX_MID_RUN_ADMISSION_FAILURES) return no('admission_failures');
  if (observation.status !== 'known') return no('context_unknown');
  if (observation.pressure !== 'high') return no('below_threshold');
  if (!native.lastAssistantID) return no('no_new_observed_context');
  if (mid?.last) {
    if (!fresh) return no('no_growth_since_last_compaction');
    const baseline = mid.baselineTokens ?? newBaseline;
    if (observation.tokens - baseline < growthRequired(observation.threshold)) return no('no_growth_since_last_compaction');
  }
  if (mid?.lastFailure && mid.lastFailure.messageID === observation.messageID) return no('no_new_observed_context');
  const sequence = (mid?.count ?? 0) + (mid?.failures ?? 0) + 1;
  if (sequence > MAX_MID_RUN_SEQUENCE) return no('per_generation_limit');
  return { admit: true, observation, sequence, lastAssistantID: native.lastAssistantID };
}

function isDescendant(sessions, id, ancestor) {
  const byID = new Map(sessions.map(s => [s.id, s])); const seen = new Set();
  let current = byID.get(id);
  while (current?.parentID && !seen.has(current.id)) {
    if (current.parentID === ancestor) return true;
    seen.add(current.id); current = byID.get(current.parentID);
  }
  return false;
}

// Frozen at admission so every later request sees identical system text
// (stable prompt-cache prefix) until the next mid-run compaction.
export function buildContinuation(record, { intent, evidence } = {}) {
  const data = { taskId: record.taskId, workKey: record.workKey, generation: record.admissionGeneration, operation: record.operation };
  if (intent && Array.isArray(record.checkIds) && record.checkIds.length) {
    try { data.intentReference = renderIntentReference(intent, record.checkIds); } catch { /* stale ids: the model must re-read task_intent */ }
  }
  if (record.handoffBrief?.generation === record.admissionGeneration) data.taskBrief = bounded(record.handoffBrief.text, BRIEF_LIMIT);
  if (record.workCheckpoint?.target) data.checkpointTarget = record.workCheckpoint.target;
  const progress = record.progressCheckpoint;
  if (progress) data.latestCheckpoint = { status: progress.status, progressState: progress.progressState, recordedAt: progress.recordedAt, ...(progress.dependencySessionIDs ? { dependencySessionIDs: progress.dependencySessionIDs } : {}) };
  const checks = evidence?.revision === record.intentRevision ? Object.values(evidence.checks ?? {}) : [];
  if (checks.length) data.checkResults = checks.slice(0, 12).map(item => Object.fromEntries(['id', 'status', 'mode', 'evidence', 'freshness', 'sourceReceipt']
    .filter(key => typeof item?.[key] === 'string').map(key => [key, bounded(item[key], 500)])));
  if (record.completionReceipt) data.priorCompletionReceipt = Object.fromEntries(['generation', 'promptID', 'assistantID', 'idleID'].filter(key => record.completionReceipt[key] !== undefined).map(key => [key, record.completionReceipt[key]]));
  let text = `${CONTINUATION_PREFIX}: ${JSON.stringify(data)}. Context was compacted mid-run at a step boundary; continue the same assignment from the latest checkpoint without repeating completed work. If the intent reference is present, re-read task_intent for this task before acting on details you no longer have.`;
  if (text.length > CONTINUATION_LIMIT) {
    data.taskBrief = bounded(data.taskBrief, Math.max(500, BRIEF_LIMIT - (text.length - CONTINUATION_LIMIT)));
    text = `${CONTINUATION_PREFIX}: ${JSON.stringify(data)}. Context was compacted mid-run at a step boundary; continue the same assignment from the latest checkpoint without repeating completed work. If the intent reference is present, re-read task_intent for this task before acting on details you no longer have.`;
  }
  return text;
}

export function admitMidRunCompaction(record, decision, continuation, now = Date.now()) {
  const mid = stateFor(record);
  const id = midRunCompactionID(record.completionBinding.marker, decision.sequence);
  mid.pending = { id, sequence: decision.sequence, admittedAt: now, tokens: decision.observation.tokens, messageID: decision.observation.messageID, lastAssistantID: decision.lastAssistantID, continuation };
  return id;
}

export function recordAdmissionFailure(record, id, observation, now = Date.now()) {
  const mid = record.midRunCompaction;
  if (!mid?.pending || mid.pending.id !== id) return false;
  mid.failures = (mid.failures ?? 0) + 1;
  mid.lastFailure = { id, messageID: observation?.messageID, at: now };
  mid.pending = undefined;
  return true;
}

export function recordAdmitted(record, id) {
  const mid = record.midRunCompaction;
  if (!mid?.pending || mid.pending.id !== id || mid.pending.admitted) return false;
  mid.count = (mid.count ?? 0) + 1;
  mid.pending.admitted = true;
  return true;
}

// The first completed observation after a compaction is the growth baseline.
export function recordBaseline(record, tokens) {
  const mid = record.midRunCompaction;
  if (!mid || mid.generation !== record.admissionGeneration || mid.baselineTokens !== undefined || !Number.isFinite(tokens)) return false;
  mid.baselineTokens = tokens;
  return true;
}

// Status projection: never exports the brief or continuation text.
export function midRunCompactionStatus(record) {
  const mid = record?.midRunCompaction;
  if (!mid || mid.generation !== record.admissionGeneration) return undefined;
  return { generation: mid.generation, count: mid.count ?? 0, limit: MAX_MID_RUN_COMPACTIONS,
    ...(mid.pending ? { pending: { id: mid.pending.id, admittedAt: mid.pending.admittedAt, tokens: mid.pending.tokens } } : {}),
    ...(mid.last ? { last: { id: mid.last.id, status: mid.last.status } } : {}),
    ...(mid.stopped ? { stopped: mid.stopped } : {}), ...(mid.failures ? { admissionFailures: mid.failures } : {}) };
}

// Injected into every primary request after a completed mid-run compaction of
// this generation, so the brief, intent reference, receipts and checkpoint
// survive even if the summary drops them.
export function activeContinuation(record) {
  const mid = record?.midRunCompaction;
  if (!mid || mid.generation !== record.admissionGeneration || mid.last?.status !== 'completed') return undefined;
  return mid.continuation;
}

// System text for the native summary request of a pending mid-run compaction.
export function pendingCompactionPreservation(record) {
  const mid = record?.midRunCompaction;
  if (!mid?.pending?.continuation || mid.generation !== record.admissionGeneration) return undefined;
  return `${COMPACTION_PRESERVE_PREFIX} (task brief, intent reference, check results/receipts and latest checkpoint). ${mid.pending.continuation}`;
}
