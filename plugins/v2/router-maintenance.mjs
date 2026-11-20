// r20 item 8: routers wake less often and compact at about 100k tokens.
//
// Wake hold: a harness fallback result delivery to a parent that still has other
// background children running is held (re-checked on the normal delivery
// interval) for up to ROUTER_WAKE_HOLD_MS, so finishing siblings wake the
// parent once instead of once each. Native completion notices are unchanged.
//
// Compaction: a root router/coordinator session whose last completed model
// input reached ROUTER_COMPACTION_TOKENS is compacted natively once per
// observed message at the next step boundary.
export const ROUTER_WAKE_HOLD_MS = 10 * 60_000;
export const ROUTER_COMPACTION_TOKENS = 100_000;
export const ROUTER_COMPACTION_ENV = 'HARNESS_ROUTER_COMPACTION_TOKENS';

export function routerCompactionTokens(env = process.env) {
  const raw = env?.[ROUTER_COMPACTION_ENV];
  const value = typeof raw === 'string' && /^\d{4,9}$/.test(raw.trim()) ? Number(raw.trim()) : undefined;
  return value ?? ROUTER_COMPACTION_TOKENS;
}

// A sibling counts as running only while its native child session is active (a finished
// background child keeps state 'running' until collected, so the record state alone would
// make finished siblings hold each other). Without native session evidence nothing is held.
export function holdWake({ records, key, parentID, settledAt, now, sessions, holdMs = ROUTER_WAKE_HOLD_MS }) {
  if (!(holdMs > 0) || !Number.isFinite(settledAt) || now - settledAt >= holdMs || !Array.isArray(sessions)) return false;
  const active = new Set(sessions.filter(s => s?.active).map(s => s.id));
  return (records ?? []).some(r => r?.key !== key && r?.parentID === parentID && ['running', 'starting'].includes(r?.state) &&
    r?.resultDelivery?.mode === 'background' && r?.resultDelivery?.status === 'pending' && active.has(r.childID));
}

export function routerCompactionDue(session, { threshold = routerCompactionTokens(), lastMessageID } = {}) {
  if (!session || session.parentID || !Number.isFinite(session.contextTokens)) return false;
  if (session.contextTokens < threshold) return false;
  if (typeof session.contextMessageID === 'string' && session.contextMessageID === lastMessageID) return false;
  return true;
}

export function createRouterCompactor({ compact, loadSessions, threshold = routerCompactionTokens(), newID }) {
  const last = new Map(); // sessionID -> contextMessageID compacted (or attempted)
  return async sessionID => {
    if (typeof compact !== 'function') return false;
    const session = (await loadSessions()).find(s => s.id === sessionID);
    if (!routerCompactionDue(session, { threshold, lastMessageID: last.get(sessionID) })) return false;
    if (last.size >= 1024) last.delete(last.keys().next().value);
    last.set(sessionID, session.contextMessageID ?? `tokens:${session.contextTokens}`);
    try { await compact({ sessionID, id: newID() }); return true; } catch { return false; }
  };
}
