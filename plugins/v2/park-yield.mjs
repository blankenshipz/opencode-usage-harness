// r20 item 6: park and yield.
//
// A native permission ask that stays unanswered must not hold its parent forever.
// At NOTIFY_AFTER (10 min) the stall is logged once (workrelay session_notify
// already sends the user a stalled event). At PARK_AFTER (30 min) the ask is
// parked: it is never answered or rejected by the harness and stays answerable
// by a human, but a foreground parent waiting on that child (or a descendant)
// is released with an explicit blocked/incomplete result. Never auto-deny.
import fs from 'node:fs';
import path from 'node:path';
import { statePath } from './paths.mjs';

// r26 item 2: a blocked foreground parent (usually the router) is released after
// 5 min (was 30) so it keeps consuming new incoming messages; the stall is
// logged at 3 min. HARNESS_PARK_AFTER_MS / HARNESS_PARK_NOTIFY_MS override.
const envMs = (name, fallback) => { const raw = process.env[name]; return typeof raw === 'string' && /^\d{5,8}$/.test(raw) ? Number(raw) : fallback; };
export const NOTIFY_AFTER_MS = envMs('HARNESS_PARK_NOTIFY_MS', 3 * 60_000);
export const PARK_AFTER_MS = envMs('HARNESS_PARK_AFTER_MS', 5 * 60_000);
export const PENDING_ASKS_FILE = statePath('asks', 'pending.json');
const SECRETISH = /((?:token|secret|password|passwd|api[_-]?key|authorization|bearer|hmac|header_value)\S*\s*[=:]?\s*)\S+/gi;
// A short, redacted, single-line description of what the ask wants.
export function askSummary(data = {}) {
  const kind = String(data.permission ?? data.type ?? data.action ?? 'unknown').slice(0, 40);
  const patterns = Array.isArray(data.patterns) ? data.patterns : (typeof data.pattern === 'string' ? [data.pattern] : []);
  const subject = patterns.length ? patterns.join(' ') : String(data.title ?? data.metadata?.command ?? '');
  const text = `${kind}: ${subject}`.replace(/[\r\n\t]+/g, ' ').replace(SECRETISH, '$1[redacted]').replace(/\b[A-Za-z0-9_\-]{32,}\b/g, '[redacted]');
  return text.length > 160 ? text.slice(0, 157) + '...' : text;
}
// Stable, documented file for other tools (workrelay queued_behind):
// {schemaVersion:1, updatedAt, asks:[{requestID, sessionID, since, summary, stalled, parked}]}
export function pendingAsksWriter({ file = PENDING_ASKS_FILE } = {}) {
  return asks => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ schemaVersion: 1, updatedAt: new Date().toISOString(),
        asks: asks.map(a => ({ requestID: a.requestID, sessionID: a.sessionID, since: new Date(a.since).toISOString(), summary: a.summary, stalled: a.stalled, parked: a.parked })) }), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch { /* publishing state must not affect permissions */ }
  };
}
export const PARK_TICK_MS = 60_000;

export function parkLogger({ file = statePath('telemetry', 'permission-park.jsonl') } = {}) {
  return record => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.appendFileSync(file, JSON.stringify(record) + '\n', { mode: 0o600 });
    } catch { /* logging must not affect permissions */ }
  };
}

export function createParkMonitor({ now = Date.now, notifyAfter = NOTIFY_AFTER_MS, parkAfter = PARK_AFTER_MS, log = () => {}, publish = () => {} } = {}) {
  const asks = new Map(); // requestID -> {sessionID, since, action, stalled, parked}
  const waiters = new Set();
  let ticking = false;
  const parkedRecord = (id, ask) => ({ requestID: id, sessionID: ask.sessionID, action: ask.action, ...(ask.summary ? { summary: ask.summary } : {}), pendingMs: now() - ask.since });
  const sync = () => { try { publish([...asks].map(([id, ask]) => ({ requestID: id, ...ask }))); } catch { /* ignore */ } };
  const offer = async record => {
    for (const waiter of [...waiters]) {
      let match = false;
      try { match = await waiter.match(record.sessionID); } catch { match = false; }
      // An ask answered while match() was awaiting is no longer parked: never release on it.
      if (match && asks.get(record.requestID)?.parked && waiters.delete(waiter)) waiter.resolve(record);
    }
  };
  return {
    asked({ id, sessionID, action, summary, since = now() }) {
      if (!id || !sessionID || asks.has(id)) return;
      if (asks.size >= 4096) asks.delete(asks.keys().next().value);
      asks.set(id, { sessionID, action, ...(summary ? { summary } : {}), since, stalled: false, parked: false });
      sync();
    },
    replied(id) { if (asks.delete(id)) sync(); },
    pending() { return [...asks].map(([id, ask]) => ({ requestID: id, ...ask })); },
    forgetSession(sessionID) { let changed = false; for (const [id, ask] of asks) if (ask.sessionID === sessionID) changed = asks.delete(id) || changed; if (changed) sync(); },
    async tick() {
      if (ticking) return [];
      ticking = true;
      try { return await this.tickOnce(); } finally { ticking = false; }
    },
    async tickOnce() {
      const at = now(), events = [];
      for (const [id, ask] of asks) {
        const age = at - ask.since;
        if (!ask.stalled && age >= notifyAfter) {
          ask.stalled = true;
          const record = { at: new Date(at).toISOString(), outcome: 'stalled', ...parkedRecord(id, ask) };
          log(record); events.push(record);
        }
        if (!ask.parked && age >= parkAfter) {
          ask.parked = true;
          const record = { at: new Date(at).toISOString(), outcome: 'parked', ...parkedRecord(id, ask), answerable: true };
          log(record); events.push(record);
        }
      }
      if (events.length) sync();
      for (const [id, ask] of asks) if (ask.parked) await offer(parkedRecord(id, ask));
      return events;
    },
    // Resolves with the parked ask once any parked ask belongs to a session for which match(sessionID) is true.
    whenParked(match) {
      let waiter;
      const promise = new Promise(resolve => { waiter = { match, resolve }; waiters.add(waiter); });
      return { promise, cancel() { waiters.delete(waiter); } };
    },
  };
}

// One monitor per plugin process, shared by the event subscriber and task dispatch.
export const parkMonitor = createParkMonitor({ log: parkLogger(), publish: pendingAsksWriter() });

export function installParkYield(ctx, { monitor = parkMonitor, tickMs = PARK_TICK_MS, setTimer = setInterval, clearTimer = clearInterval } = {}) {
  if (typeof ctx?.event?.subscribe !== 'function') return { stop() {} };
  const controller = new AbortController();
  const timer = setTimer(() => { void monitor.tick().catch(() => {}); }, tickMs);
  timer?.unref?.();
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        const data = event?.data ?? {};
        if (event?.type === 'permission.asked' && data.id && data.sessionID) monitor.asked({ id: data.id, sessionID: data.sessionID, action: data.action ?? data.permission, summary: askSummary(data) });
        else if (event?.type === 'permission.replied') monitor.replied(data.requestID ?? data.id);
        // An aborted or deleted session's asks can no longer be answered; never park on them.
        else if (['session.deleted', 'session.execution.interrupted'].includes(event?.type) && (data.sessionID ?? data.id)) monitor.forgetSession(data.sessionID ?? data.id);
      }
    } catch { /* subscription closed */ }
  })();
  return { stop() { controller.abort(); clearTimer(timer); } };
}

// The parent-facing result for a parked foreground child. It is never a pass.
export function parkedResult({ parked, identity, collect }) {
  const minutes = Math.round(parked.pendingMs / 60_000);
  const content = `<subagent sessionID="${identity.sessionID}" state="blocked" agent="${identity.agent}" generation="${identity.generation}">\n` +
    `BLOCKED / INCOMPLETE: this child has waited ${minutes} min on permission request ${parked.requestID} (${parked.summary ?? parked.action ?? 'unknown action'}) in session ${parked.sessionID}. ` +
    `The ask is parked, not denied: it stays answerable by a human and the child resumes when it is answered.\n</subagent>\n\n` +
    `Harness park-and-yield: status blocked. This is NOT a pass: do not treat any verification, review or check from this child as passed or the task as complete. ` +
    `Continue other non-overlapping work or report the task blocked on human approval; after it is answered, collect with task_dispatch_collect(${JSON.stringify(collect)}).`;
  return { content, metadata: { ...identity, status: 'blocked', verdict: 'blocked', mode: 'parked', parked: { requestID: parked.requestID, sessionID: parked.sessionID, pendingMs: parked.pendingMs, ...(parked.summary ? { summary: parked.summary } : {}) }, collect },
    output: { sessionID: identity.sessionID, status: 'blocked', output: content } };
}
