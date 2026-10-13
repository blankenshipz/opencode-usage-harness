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
export function beginCheckpoint(record, checkpoint, now = Date.now()) {
  record.workCheckpoint = { startedAt: now, preparedSteps: 0, ...(checkpoint ? { target: checkpoint } : {}) };
}
export function checkpointStatus(record, now = Date.now()) {
  const slice = record.workCheckpoint;
  if (!slice || !Number.isFinite(slice.startedAt)) return undefined;
  const elapsedMs = Math.max(0, now - slice.startedAt);
  return { ...slice, elapsedMs, due: elapsedMs >= CHECKPOINT_MS || slice.preparedSteps >= CHECKPOINT_STEPS,
    cooperative: true, limits: { elapsedMs: CHECKPOINT_MS, preparedSteps: CHECKPOINT_STEPS } };
}
export function prepareCheckpoint(record, now = Date.now()) {
  if (!record.workCheckpoint) return undefined; // Existing in-flight assignments stay untouched.
  record.workCheckpoint.preparedSteps = Math.min((record.workCheckpoint.preparedSteps ?? 0) + 1, 1000000);
  return checkpointStatus(record, now);
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
