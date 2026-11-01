// Advisory only: evaluate native metadata on an existing primary request.
// No timer, synthetic input, dispatch, inference or persistent reminder state.
export const ROOT_PROGRESS_MS = 10 * 60 * 1000;
const validClock = (value, at) => Number.isSafeInteger(value) && value > 0 && value <= at;
export function rootProgressStatus(session, at = Date.now()) {
  if (!session || session.parentID || session.canonicalSessionID || !session.active ||
      !Number.isSafeInteger(at) || !validClock(session.executionStartedAt, at)) return undefined;
  const visible = validClock(session.lastVisibleTextAt, at) ? session.lastVisibleTextAt : undefined;
  // A malformed/future supplied timestamp is unknown, never proof of silence.
  if (session.lastVisibleTextAt !== undefined && visible === undefined) return undefined;
  const elapsedMs = at - Math.max(session.executionStartedAt, visible ?? 0);
  return { due: elapsedMs >= ROOT_PROGRESS_MS, elapsedMs, intervalMs: ROOT_PROGRESS_MS,
    basis: 'native_execution_and_visible_text' };
}
export const rootProgressReminder = 'Root progress update due. Briefly report changed evidence, the current blocker if any, and the next concrete action in the visible conversation. Distinguish queued instructions, active work, collected evidence and accepted completion. Keep the update concise; do not dump worker logs. Continue useful authorized work without yielding, redispatching, repeating tests, escalating models, or requesting permission solely because time elapsed. This reminder creates no new task or authority.';
