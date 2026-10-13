import crypto from 'node:crypto';

const MAX_HISTORY = 32;
const MAX_KEY_LENGTH = 128;
const MAX_REFERENCE_LENGTH = 500;
const POSITIVE_KINDS = new Set(['cause_eliminated', 'reproduced', 'check_passed']);

// This is a worker report, not an authorization or completion gate.
export const progressEvidenceSchema = Object.freeze({
  type: 'object', additionalProperties: false, required: ['failureKey', 'kind', 'reference'],
  properties: {
    failureKey: { type: 'string', minLength: 1, maxLength: MAX_KEY_LENGTH, pattern: '^[^\\r\\n\\u0000]+$' },
    kind: { enum: ['cause_eliminated', 'reproduced', 'check_passed', 'no_change'] },
    reference: { type: 'string', minLength: 1, maxLength: MAX_REFERENCE_LENGTH, pattern: '^[^\\r\\n\\u0000]+$' }
  }
});

export function normalizeProgressEvidence(evidence) {
  if (evidence === undefined || evidence === null) return undefined;
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) throw new TypeError('progressEvidence must be an object');
  const keys = Object.keys(evidence).sort();
  if (keys.length !== 3 || keys.some((key, index) => key !== ['failureKey', 'kind', 'reference'][index])) throw new TypeError('progressEvidence has unknown or missing fields');
  if (typeof evidence.failureKey !== 'string' || evidence.failureKey.trim().length === 0 || /[\r\n\0]/.test(evidence.failureKey) || evidence.failureKey.trim().length > MAX_KEY_LENGTH) throw new TypeError('progressEvidence.failureKey is invalid');
  if (!POSITIVE_KINDS.has(evidence.kind) && evidence.kind !== 'no_change') throw new TypeError('progressEvidence.kind is invalid');
  if (typeof evidence.reference !== 'string' || evidence.reference.trim().length === 0 || /[\r\n\0]/.test(evidence.reference) || evidence.reference.trim().length > MAX_REFERENCE_LENGTH) throw new TypeError('progressEvidence.reference is invalid');
  return { failureKey: evidence.failureKey.trim(), kind: evidence.kind, reference: evidence.reference.trim() };
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function boundedHistory(values) {
  return [...new Set(values ?? [])].slice(-MAX_HISTORY);
}

function progressState(record) {
  const convergence = record.convergence ?? (record.convergence = {});
  return convergence.progress ?? (convergence.progress = {
    binding: undefined, initialized: false, noProgressContinuations: 0,
    evidenceDigests: [], positiveEvidenceCount: 0, observedPositiveEvidenceCount: 0, passedChecks: [], everPassedChecks: []
  });
}

export function recordProgress(record, evidence) {
  const normalized = normalizeProgressEvidence(evidence);
  const progress = progressState(record);
  if (!normalized) return progress;
  const id = digest([normalized.kind, normalized.failureKey, normalized.reference]);
  const seen = progress.evidenceDigests?.includes(id);
  progress.evidenceDigests = boundedHistory([...(progress.evidenceDigests ?? []), id]);
  if (!seen && POSITIVE_KINDS.has(normalized.kind)) progress.positiveEvidenceCount = Math.min((progress.positiveEvidenceCount ?? 0) + 1, 1000000);
  return progress;
}

function assignedChecks(state, input, rootID) {
  const evidence = state.intentEvidence?.[JSON.stringify([rootID, input.taskId])];
  return [...(input.checkIds ?? [])].sort().map(id => {
    const r = evidence?.revision === input.intentRevision ? evidence.checks?.[id] : undefined;
    return [id, r?.status, r?.mode, r?.freshness, r?.artifact?.subject, r?.artifact?.revision, r?.artifact?.generation];
  });
}

// Receipt semantics, not prose, timestamps, or token volume, define observed
// progress. Missing receipts mean unknown progress, never proof of wasted work.
export function observeAdmission(record, state, input, rootID) {
  const checks = assignedChecks(state, input, rootID);
  const fingerprint = digest([input.intentRevision, input.operation, checks]);
  const prior = record.convergence;
  record.convergence = { ...(prior ?? {}), fingerprint, admissions: prior?.fingerprint === fingerprint ? Math.min((prior.admissions ?? 0) + 1, 1000000) : 1 };

  const progress = progressState(record);
  const binding = digest([input.intentRevision, [...(input.checkIds ?? [])].sort()]);
  const passedChecks = checks.filter(([, status]) => status === 'passed').map(([id]) => id);
  if (progress.binding !== binding) {
    progress.binding = binding; progress.initialized = true; progress.noProgressContinuations = 0;
    progress.evidenceDigests = []; progress.positiveEvidenceCount = 0; progress.observedPositiveEvidenceCount = 0;
    progress.passedChecks = passedChecks; progress.everPassedChecks = passedChecks;
  } else {
    const newlyPassed = passedChecks.some(id => !(progress.everPassedChecks ?? progress.passedChecks ?? []).includes(id));
    const newEvidence = (progress.positiveEvidenceCount ?? 0) > (progress.observedPositiveEvidenceCount ?? 0);
    if (newlyPassed || newEvidence) progress.noProgressContinuations = 0;
    else progress.noProgressContinuations = Math.min((progress.noProgressContinuations ?? 0) + 1, 1000000);
    progress.observedPositiveEvidenceCount = progress.positiveEvidenceCount ?? 0;
    progress.passedChecks = passedChecks;
    progress.everPassedChecks = [...new Set([...(progress.everPassedChecks ?? []), ...passedChecks])];
  }
  return convergenceAdvice(record);
}

export function convergenceAdvice(record) {
  const progress = record.convergence?.progress;
  if ((progress?.noProgressContinuations ?? 0) >= 2) return { admissionsWithoutReceiptChange: record.convergence?.admissions, semanticNoProgressContinuations: progress.noProgressContinuations, advisory: 'Repeated dispatches without new reported semantic progress or newly passed assigned checks. Inspect the last artifact/checkpoint or concrete failure, then give the same owner one next action. Reported evidence is not independent proof. Do not infer a stall, replace a worker, or add review from this count alone.' };
  // Once semantic observations exist, fresh reported evidence can advance the
  // task even before an entire assigned check passes. Do not contradict it with
  // the legacy receipt-only advisory.
  if (progress?.initialized || (record.convergence?.admissions ?? 0) < 3) return undefined;
  return { admissionsWithoutReceiptChange: record.convergence.admissions, advisory: 'Repeated dispatches without changed assigned-check receipts. Progress may be unrecorded: inspect the last artifact/checkpoint or concrete failure, then give the same owner one next action. Diagnose unchanged failures before another attempt; preserve unaffected passing checks. Do not infer a stall, replace a worker, or add review from this count alone.' };
}

export function userActions(records, revision) {
  return records.filter(r => r.intentRevision === revision && r.attention?.intentRevision === revision && r.attention?.progressState === 'needs_user_action')
    .map(r => ({ sessionID: r.childID, taskId: r.taskId, workKey: r.workKey, ...r.attention }));
}
