// Cooperative work slices: no timers, cancellations, extra requests or permission changes.
export const checkpointSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    objective: { type: 'string', minLength: 1, maxLength: 500 },
    expectedEvidence: { type: 'string', minLength: 1, maxLength: 500 },
  }, required: ['objective', 'expectedEvidence'],
};
export function normalizeCheckpoint(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(k => !['objective', 'expectedEvidence'].includes(k)) ||
      ['objective', 'expectedEvidence'].some(k => typeof value[k] !== 'string' ||
        !value[k].trim() || value[k].length > 500 || /[\r\n\0]/.test(value[k]))) {
    throw new Error('task-dispatch: invalid checkpoint');
  }
  return { objective: value.objective.trim(), expectedEvidence: value.expectedEvidence.trim() };
}
export const CHECKPOINT_MS = 10 * 60 * 1000;
export const CHECKPOINT_STEPS = 30;
export const TASK_REVIEW_STEPS = 120;
export const TASK_REVIEW_CONTINUATIONS = 6;
export const HIGH_CONTEXT_RATIO = 0.8;
export const HIGH_CONTEXT_TOKENS = 120000;

const boundedCount = value => Number.isFinite(value) ? Math.min(Math.max(0, Math.floor(value)), 1000000) : 0;
const sameReviewBaseline = accounting => ({ preparedSteps: accounting.preparedSteps, continuations: accounting.continuations });

function accountingFor(record) {
  const existing = record.workAccounting;
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    existing.preparedSteps = boundedCount(existing.preparedSteps);
    existing.continuations = boundedCount(existing.continuations);
    const baseline = existing.reviewBaseline;
    existing.reviewBaseline = baseline && typeof baseline === 'object' && !Array.isArray(baseline)
      ? { preparedSteps: boundedCount(baseline.preparedSteps), continuations: boundedCount(baseline.continuations) }
      : sameReviewBaseline(existing);
    return existing;
  }
  // Old persisted records only have the current slice. Preserve its known work rather than
  // pretending it never happened, then start future accounting from this durable snapshot.
  const accounting = { preparedSteps: boundedCount(record.workCheckpoint?.preparedSteps), continuations: 0 };
  accounting.reviewBaseline = sameReviewBaseline(accounting);
  record.workAccounting = accounting;
  return accounting;
}

function contextAdvisory(knownContext) {
  if (knownContext === undefined || knownContext === null || (typeof knownContext !== 'number' && (typeof knownContext !== 'object' || Array.isArray(knownContext)))) return undefined;
  const used = typeof knownContext === 'number' ? knownContext : knownContext.used ?? knownContext.tokens ?? knownContext.usedTokens;
  const limit = typeof knownContext === 'number' ? undefined : knownContext.limit ?? knownContext.maxTokens ?? knownContext.contextWindow;
  if (!Number.isFinite(used) || used < 0) return undefined;
  if (Number.isFinite(limit) && limit > 0) {
    const ratio = used / limit;
    return ratio >= HIGH_CONTEXT_RATIO ? { used, limit, ratio, advisory: 'Known context is high. Reassess the next hypothesis with retained evidence before adding more work.' } : undefined;
  }
  return used >= HIGH_CONTEXT_TOKENS ? { used, advisory: 'Known context is high. Reassess the next hypothesis with retained evidence before adding more work.' } : undefined;
}

export function normalizeReviewAcknowledgement(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['hypothesis', 'evidenceReference'].includes(key)) ||
      ['hypothesis', 'evidenceReference'].some(key => typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 500 || /[\r\n\0]/.test(value[key]))) {
    throw new Error('task-dispatch: invalid task review acknowledgement');
  }
  return { hypothesis: value.hypothesis.trim(), evidenceReference: value.evidenceReference.trim() };
}

// This is deliberately explicit: redispatching a child does not silently waive a task review.
// The caller must retain a concrete next hypothesis and evidence reference before moving its
// review baseline. Lifetime totals remain intact for status and later review.
export function acknowledgeTaskReview(record, acknowledgement, now = Date.now()) {
  const evidence = normalizeReviewAcknowledgement(acknowledgement);
  const accounting = accountingFor(record);
  accounting.reviewBaseline = sameReviewBaseline(accounting);
  accounting.lastReview = { ...evidence, acknowledgedAt: now };
  return checkpointStatus(record, now);
}
export function beginCheckpoint(record, checkpoint, now = Date.now()) {
  const continuing = !!record.workCheckpoint;
  const accounting = accountingFor(record);
  if (continuing) accounting.continuations = Math.min(accounting.continuations + 1, 1000000);
  record.workCheckpoint = { startedAt: now, preparedSteps: 0, ...(checkpoint ? { target: checkpoint } : {}) };
}
export function checkpointStatus(record, now = Date.now(), { knownContext } = {}) {
  const slice = record.workCheckpoint;
  if (!slice || !Number.isFinite(slice.startedAt)) return undefined;
  const elapsedMs = Math.max(0, now - slice.startedAt);
  const accounting = accountingFor(record);
  const baseline = accounting.reviewBaseline;
  const sinceReview = { preparedSteps: Math.max(0, accounting.preparedSteps - baseline.preparedSteps), continuations: Math.max(0, accounting.continuations - baseline.continuations) };
  const taskReview = { due: sinceReview.preparedSteps >= TASK_REVIEW_STEPS || sinceReview.continuations >= TASK_REVIEW_CONTINUATIONS,
    sinceReview, limits: { preparedSteps: TASK_REVIEW_STEPS, continuations: TASK_REVIEW_CONTINUATIONS }, baseline: { ...baseline }, ...(accounting.lastReview ? { lastAcknowledgement: { ...accounting.lastReview } } : {}) };
  const highContext = contextAdvisory(knownContext);
  return { ...slice, elapsedMs, due: elapsedMs >= CHECKPOINT_MS || slice.preparedSteps >= CHECKPOINT_STEPS,
    cooperative: true, limits: { elapsedMs: CHECKPOINT_MS, preparedSteps: CHECKPOINT_STEPS }, cumulative: { preparedSteps: accounting.preparedSteps, continuations: accounting.continuations }, taskReview, ...(highContext ? { highContext } : {}) };
}
export function prepareCheckpoint(record, now = Date.now(), options) {
  if (!record.workCheckpoint) return undefined; // Existing in-flight assignments stay untouched.
  record.workCheckpoint.preparedSteps = Math.min((record.workCheckpoint.preparedSteps ?? 0) + 1, 1000000);
  const accounting = accountingFor(record);
  accounting.preparedSteps = Math.min(accounting.preparedSteps + 1, 1000000);
  return checkpointStatus(record, now, options);
}
export const checkpointReminder = 'Work checkpoint due. Finish collecting any already-running operation; do not cancel it or start replacement workers. Record one compact checkpoint with changed evidence, the current failed transition (if any), and one next action. Then hand the bounded result to your parent instead of starting another implementation cycle. If a child is still running, retain its ownership and report waiting_dependency; do not claim task completion or a human blocker. The parent continues authorized work from this checkpoint.';
export function checkpointHandoff(checkpoint) {
  const target = checkpoint ? `\nCheckpoint target (assignment data): ${JSON.stringify(checkpoint)}` : '';
  return `Bounded work checkpoint: produce one next result, not the whole remaining project. Reassess after 10 minutes or 30 prepared model steps at the next model boundary; collect running operations, record evidence and hand back. Do not expand into adjacent fixes. Preserve existing owners and passing evidence.${target}`;
}
export function backgroundDispatch(input) {
  // Inspect/summary calls remain short foreground work. Explicit overrides always win.
  return input.background ?? ['coordinate', 'implement', 'deploy'].includes(input.operation);
}
