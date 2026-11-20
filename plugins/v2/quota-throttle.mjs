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
//
// Budget brake (r25): projects the weekly used percent at reset from the observed trailing burn
// (burn-pacing windowBurn). Projected > 100%: level 1 caps builder children to 1 active per root;
// level 2 (projected > 115% or used >= 90%) refuses new builder children unless user-requested.
// Required reviews, verifier/reviewer agents, continuations and compaction are never braked.
// Missing data fails open. HARNESS_BUDGET_BRAKE=off disables it.
import { quotaPace } from './dispatch-routing.mjs';
import { windowBurn } from './burn-pacing.mjs';

export const QUOTA_SAMPLE_MS = 10 * 60_000;
export const THROTTLE_MAX_ACTIVE = 2;

function activeChildren({ rootID, records, sessions, callerID }) {
  const byID = new Map((sessions ?? []).map(s => [s.id, s]));
  const ancestors = new Set();
  for (let s = byID.get(callerID), guard = 0; s && guard < 64; s = byID.get(s.parentID), guard++) ancestors.add(s.id);
  return (records ?? []).filter(r => r?.rootID === rootID && !(r.childID && ancestors.has(r.childID)) &&
    !(r.parked && r.parked.generation === r.admissionGeneration) &&
    ((r.childID && byID.get(r.childID)?.active) || (r.inFlight && ['starting', 'running'].includes(r.state ?? 'starting')))).map(r => r.childID ?? r.key);
}

const msOf = v => typeof v === 'number' ? (v > 1e12 ? v : v * 1000) : Date.parse(v);

// Worst weekly projection for the provider, or undefined when data is missing.
export function weeklyProjection(quota, provider = 'openai', now = Date.now(), burn = windowBurn) {
  const pool = quota?.pools ? quota.pools[provider] : undefined;
  const windows = (pool?.windows ?? []).filter(w => (w.scope ?? 'account') === 'account'
    && Number.isFinite(w.used_percent) && Number.isFinite(w.duration_minutes) && w.duration_minutes >= 10080
    && Number.isFinite(msOf(w.resets_at)) && msOf(w.resets_at) > now);
  let worst;
  for (const w of windows) {
    // r26 fable: a short trailing burst must not be extrapolated over the whole week.
    // Prefer the week-to-date average (used / elapsed) once 12 h of the window elapsed.
    const elapsedH = (w.duration_minutes * 60_000 - (msOf(w.resets_at) - now)) / 3600_000;
    const average = elapsedH >= 12 ? w.used_percent / elapsedH : undefined;
    const rate = Number.isFinite(w.burn_rate_per_hour) ? w.burn_rate_per_hour : Number.isFinite(average) ? average : burn(provider, w, now)?.ratePerHour;
    if (!Number.isFinite(rate)) continue;
    const resetMs = msOf(w.resets_at);
    const projected = w.used_percent + rate * (resetMs - now) / 3600_000;
    if (!worst || projected > worst.projected) worst = { projected, used: w.used_percent, resetsAt: new Date(resetMs).toISOString() };
  }
  return worst;
}

export function budgetBrake({ quota, provider = 'openai', now = Date.now(), agent, newChild, compact = false, review = false, userRequested = false,
  rootID, records, sessions, callerID, env = process.env, burn } = {}) {
  if (String(env?.HARNESS_BUDGET_BRAKE ?? '').toLowerCase() === 'off') return undefined;
  // Builders only: reviews, verifiers, routers and other roles are never braked.
  if (!newChild || compact || review || /verif|review/i.test(String(agent ?? '')) || !/build|debug|implement/i.test(String(agent ?? ''))) return undefined;
  let p;
  try { p = weeklyProjection(quota, provider, now, burn); } catch { return undefined; }
  if (!p || !(p.projected > 100)) return undefined;
  const level = p.projected > 115 || p.used >= 90 ? 2 : 1;
  const head = `task-dispatch: QUOTA_BUDGET_BRAKE: pacing for weekly quota (level ${level}): projected ${Math.round(p.projected)}% of the weekly allowance at reset ${p.resetsAt} (used ${Math.round(p.used)}% now).`;
  const tail = 'No child was launched; this is pacing, not a permission denial.';
  if (userRequested) return undefined;
  if (level === 2)
    return { reason: 'weekly_budget_brake', level, projected: p.projected, resetsAt: p.resetsAt,
      message: `${head} New builder children are paused until the projection drops or the quota resets; continue an existing child or run reviews/verification instead. ${tail}` };
  const active = activeChildren({ rootID, records, sessions, callerID });
  if (active.length < 1) return undefined;
  return { reason: 'weekly_budget_brake', level, projected: p.projected, resetsAt: p.resetsAt, active, maxActive: 1,
    message: `${head} Limit is 1 active builder child per root; ${active.length} active. Wait for it to finish or continue it. ${tail}` };
}

// Counts same-root children that are active natively or still being admitted (inFlight, possibly
// without a childID yet). Excludes the caller and its own ancestors, and parked children.
// Optional quota/agent/userRequested/priority/provider enable the weekly budget brake (fails open without them).
export function dispatchThrottle({ pace, newChild, compact = false, review = false, rootID, records, sessions, callerID, maxActive = THROTTLE_MAX_ACTIVE,
  quota, provider, agent, userRequested, priority, now, env, burn }) {
  if (quota) {
    const brake = budgetBrake({ quota, provider, agent, newChild, compact, review, userRequested: userRequested === true || priority === 'user',
      rootID, records, sessions, callerID, now, env, burn });
    if (brake) return brake;
  }
  if (pace !== 'ahead' || !newChild || compact || review) return undefined;
  const active = activeChildren({ rootID, records, sessions, callerID });
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
