// r20 item 4: timer-based quota sampling and a real dispatch throttle when pace is ahead.
//
// Sampling: every QUOTA_SAMPLE_MS the provider quota snapshot is read and fed to
// quotaPace, so the trailing weekly burn samples (burn-pacing.mjs) accrue even
// when nothing is dispatching. Read-only; failures are ignored.
//
// Throttle: while the selected provider's pace is "ahead", a NEW child (not a
// continuation of an existing one) is admitted only while fewer than
// THROTTLE_MAX_ACTIVE harness children of the same root are active. Continuations,
// compaction and required independent reviews are never throttled.
import { quotaPace } from './dispatch-routing.mjs';

export const QUOTA_SAMPLE_MS = 10 * 60_000;
export const THROTTLE_MAX_ACTIVE = 2;

// Counts same-root children that are active natively or still being admitted (inFlight, possibly
// without a childID yet). Excludes the caller and its own ancestors, and parked children.
export function dispatchThrottle({ pace, newChild, compact = false, review = false, rootID, records, sessions, callerID, maxActive = THROTTLE_MAX_ACTIVE }) {
  if (pace !== 'ahead' || !newChild || compact || review) return undefined;
  const byID = new Map((sessions ?? []).map(s => [s.id, s]));
  const ancestors = new Set();
  for (let s = byID.get(callerID), guard = 0; s && guard < 64; s = byID.get(s.parentID), guard++) ancestors.add(s.id);
  const active = (records ?? []).filter(r => r?.rootID === rootID && !(r.childID && ancestors.has(r.childID)) &&
    !(r.parked && r.parked.generation === r.admissionGeneration) &&
    ((r.childID && byID.get(r.childID)?.active) || (r.inFlight && ['starting', 'running'].includes(r.state ?? 'starting')))).map(r => r.childID ?? r.key);
  if (active.length < maxActive) return undefined;
  return { reason: 'quota_pace_ahead', active, maxActive,
    message: `task-dispatch: QUOTA_PACE_THROTTLED: provider quota pace is ahead of the sustainable rate; ${active.length} children of this root are active (limit ${maxActive} while ahead). No child was launched. Wait for an active child to finish (or continue an existing child) before starting new work; this is pacing, not a permission denial.` };
}

export function sampleQuota(quota, now = Date.now()) {
  const providers = Object.keys(quota?.pools ?? {});
  return Object.fromEntries((providers.length ? providers : ['openai']).map(provider => [provider, quotaPace(quota, now, provider)]));
}

export function installQuotaSampler(ctx, { read, intervalMs = QUOTA_SAMPLE_MS, setTimer = setInterval, clearTimer = clearInterval, now = Date.now, onSample = () => {} } = {}) {
  if (typeof read !== 'function') return { stop() {}, sample: async () => undefined };
  let busy = false;
  const sample = async () => {
    if (busy) return undefined;
    busy = true;
    try { const paces = sampleQuota(await read(ctx), now()); onSample(paces); return paces; }
    catch { return undefined; }
    finally { busy = false; }
  };
  const timer = setTimer(() => { void sample(); }, intervalMs);
  timer?.unref?.();
  return { stop() { clearTimer(timer); }, sample };
}
