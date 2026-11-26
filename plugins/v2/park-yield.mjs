// r20 item 6: park and yield.
//
// A native permission ask that stays unanswered must not hold its parent forever.
// At NOTIFY_AFTER (10 min) the stall is logged once (workrelay session_notify
// already sends the user a stalled event). At PARK_AFTER (30 min) the ask is
// parked: it is never answered or rejected by the harness and stays answerable
// by a human, but a foreground parent waiting on that child (or a descendant)
// is released with an explicit blocked/incomplete result. Never auto-approve; since 0.4.0 an ask
// pending past HARNESS_ASK_TIMEOUT_MS is auto-denied (see ASK_TIMEOUT_MS).
import fs from 'node:fs';
import path from 'node:path';
import { statePath } from './paths.mjs';

// 0.3.3: asks that still reach a human are the real MUST-ASK cases, so a foreground parent is
// released after 30 s (was 5 min) and keeps working on other tasks while the ask is pending; the
// stall is logged on the first tick (was 3 min). Ticks run every 10 s.
// r26 item 2: a blocked foreground parent (usually the router) is released after
// 5 min (was 30) so it keeps consuming new incoming messages; the stall is
// logged at 3 min. HARNESS_PARK_AFTER_MS / HARNESS_PARK_NOTIFY_MS override.
const envMs = (name, fallback) => { const raw = process.env[name]; return typeof raw === 'string' && /^\d{1,8}$/.test(raw) ? Number(raw) : fallback; };
export const NOTIFY_AFTER_MS = envMs('HARNESS_PARK_NOTIFY_MS', 0);
export const PARK_AFTER_MS = envMs('HARNESS_PARK_AFTER_MS', 30_000);
// 0.4.0 (parity 4.4): safety net. An ask still pending after HARNESS_ASK_TIMEOUT_MS (default
// 15 min) is DENIED (never approved) so a child does not hold its context until a human appears.
export const ASK_TIMEOUT_MS = envMs('HARNESS_ASK_TIMEOUT_MS', 900_000);
export const ASK_TIMEOUT_PREFIX = 'ASK TIMEOUT DENY (harness auto-approve policy)';
export function askTimeoutMessage({ summary, pendingMs } = {}) {
  return `${ASK_TIMEOUT_PREFIX}: this permission ask (${summary ?? 'unknown action'}) was not answered within ${Math.round((pendingMs ?? 0) / 60_000)} min and was denied. ` +
    'Status: blocked, resumable. Record a resumable blocker carrying the exact command, continue other non-overlapping work, and do NOT retry variants or workarounds of this command.';
}
export const PENDING_ASKS_FILE = statePath('asks', 'pending.json');
const REDACTIONS = [
  [/\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|PASS|KEY|AUTH|CREDENTIAL|HMAC|COOKIE)[A-Za-z0-9_]*)=\S+/gi, '$1=[redacted]'],
  [/\b(authorization|proxy-authorization|x-api-key|api-key|cookie|set-cookie|header_value)\s*[:=]\s*(?:(?:bearer|basic|token)\s+)?\S+/gi, '$1: [redacted]'],
  [/\b(bearer|basic)\s+\S+/gi, '$1 [redacted]'],
  [/(--?(?:token|password|passwd|api-key|apikey|key|secret|auth|hmac)(?:=|\s+))\S+/gi, '$1[redacted]'],
  [/(:\/\/[^\s:@/]+:)[^\s@/]+@/g, '$1[redacted]@'],
  [/\b[A-Za-z0-9_\-+/=]{24,}\b/g, '[redacted]'],
];
// A short, redacted, single-line description of what the ask wants.
export function askSummary(data = {}) {
  const kind = String(data.permission ?? data.type ?? data.action ?? 'unknown').slice(0, 40);
  const patterns = Array.isArray(data.patterns) ? data.patterns : (typeof data.pattern === 'string' ? [data.pattern] : []);
  const subject = patterns.length ? patterns.join(' ') : String(data.title ?? data.metadata?.command ?? '');
  const text = `${kind}: ${subject}`.replace(/[\r\n\t]+/g, ' ');
  const redacted = REDACTIONS.reduce((t, [re, to]) => t.replace(re, to), text);
  return redacted.length > 160 ? redacted.slice(0, 157) + '...' : redacted;
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
export const PARK_TICK_MS = 10_000;

// 0.4.3: every project's plugin instance in one `opencode serve` process has its own park monitor and
// sees every permission.asked event, so each ask was logged once per loaded project (2 to 5 copies on the
// live service). Like execution-timing, keep one process-wide registry of written lines so an ask's
// stalled/parked/timeout outcome is logged once per file. Records without an ID are always written.
const MAX_PARK_KEYS = 8192;
// Old and new module instances can share this registry across a deploy without a restart: a shape change needs a new key (e.g. a '.v2' suffix).
const parkLogged = globalThis[Symbol.for('opencode-usage-harness.permission-park')] ??= { keys: new Set(), order: [] };
const parkLogKey = (file, record) => {
  const id = record?.requestID ?? record?.permissionID ?? record?.callID;
  const kind = record?.outcome ?? record?.event;
  return typeof id === 'string' && id && typeof kind === 'string' ? [path.resolve(file), record.sessionID ?? '', id, kind, record.rule ?? '', record.action ?? ''].join('\0') : undefined;
};

export function parkLogger({ file = statePath('telemetry', 'permission-park.jsonl') } = {}) {
  return record => {
    const key = parkLogKey(file, record);
    if (key) {
      if (parkLogged.keys.has(key)) return;
      parkLogged.keys.add(key); parkLogged.order.push(key);
      if (parkLogged.order.length > MAX_PARK_KEYS) parkLogged.keys.delete(parkLogged.order.shift());
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.appendFileSync(file, JSON.stringify(record) + '\n', { mode: 0o600 });
    } catch { /* logging must not affect permissions */ }
  };
}

export function createParkMonitor({ now = Date.now, notifyAfter = NOTIFY_AFTER_MS, parkAfter = PARK_AFTER_MS, askTimeout = ASK_TIMEOUT_MS, log = () => {}, publish = () => {}, reject } = {}) {
  const asks = new Map(); // requestID -> {sessionID, since, action, stalled, parked}
  const waiters = new Set();
  let ticking = false;
  // r40 M3: one reject function per project directory, so the last ctx never answers another
  // project's asks. `reject` (or setReject without a directory) serves asks with no directory.
  const rejects = new Map();
  const rejectFor = ask => (ask.directory !== undefined ? rejects.get(ask.directory) : undefined) ?? (ask.directory === undefined || rejects.size === 0 ? reject : undefined);
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
    asked({ id, sessionID, action, summary, since = now(), directory }) {
      if (!id || !sessionID || asks.has(id)) return;
      if (asks.size >= 4096) asks.delete(asks.keys().next().value);
      asks.set(id, { sessionID, action, ...(summary ? { summary } : {}), ...(directory ? { directory } : {}), since, stalled: false, parked: false });
      sync();
    },
    replied(id) { if (asks.delete(id)) sync(); },
    setReject(fn, directory) { if (directory) rejects.set(directory, fn); else reject = fn; },
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
      // Safety net: deny (never approve) asks pending past askTimeout. Needs a reject function.
      // r40 M3: timedOut is set only after a successful reject; a failed reply is retried next tick.
      if (askTimeout > 0) {
        for (const [id, ask] of [...asks]) {
          if (ask.timedOut || at - ask.since < askTimeout) continue;
          const deny = rejectFor(ask);
          if (typeof deny !== 'function') continue;
          const base = parkedRecord(id, ask);
          const message = askTimeoutMessage(base);
          let denied = false;
          try { await deny({ sessionID: ask.sessionID, requestID: id, message }); denied = true; } catch { /* retried on the next tick */ }
          const record = { at: new Date(at).toISOString(), event: denied ? 'ask_timeout_denied' : 'ask_timeout_reply_failed', outcome: denied ? 'ask_timeout_denied' : 'ask_timeout_reply_failed',
            ...base, permissionID: id, rule: 'ask_timeout', ...(ask.failures ? { attempt: ask.failures + 1 } : {}) };
          if (denied) { ask.timedOut = true; asks.delete(id); }
          else ask.failures = (ask.failures ?? 0) + 1;
          // Log the first failure and the success, not one failure line per tick.
          if (denied || ask.failures === 1) { log(record); events.push(record); }
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
  // The shared monitor is created without a permission client; attach the deny path here.
  const directory = ctx?.location?.directory;
  if (typeof ctx?.permission?.reply === 'function' && typeof monitor.setReject === 'function')
    monitor.setReject(({ sessionID, requestID, message }) => ctx.permission.reply({ sessionID, requestID, decision: 'reject', message }), directory);
  const controller = new AbortController();
  // r40 M3: asks pending across a reload never produce a new permission.asked event; list them on
  // startup and on each sweep (permission.list, all sessions, then known sessions) so they time out.
  const listPending = async () => {
    if (typeof ctx?.permission?.list !== 'function') return;
    const listData = value => Array.isArray(value) ? value : Array.isArray(value?.data) ? value.data : [];
    const queries = [{}, ...new Set(monitor.pending().map(ask => ask.sessionID))].map(q => typeof q === 'string' ? { sessionID: q } : q);
    for (const query of queries) {
      let requests;
      try { requests = listData(await ctx.permission.list(query)); } catch { continue; }
      for (const data of requests) {
        if (!data?.id || !data?.sessionID) continue;
        const created = Number(data.time?.created ?? data.createdAt);
        monitor.asked({ id: data.id, sessionID: data.sessionID, action: data.action ?? data.permission, summary: askSummary(data), directory,
          ...(Number.isFinite(created) && created > 0 ? { since: created } : {}) });
      }
    }
  };
  const sweep = async () => { try { await listPending(); } catch { /* best effort */ } await monitor.tick(); };
  void sweep().catch(() => {});
  const timer = setTimer(() => { void sweep().catch(() => {}); }, tickMs);
  timer?.unref?.();
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        const data = event?.data ?? {};
        if (event?.type === 'permission.asked' && data.id && data.sessionID) { monitor.asked({ id: data.id, sessionID: data.sessionID, action: data.action ?? data.permission, summary: askSummary(data), directory }); void monitor.tick().catch(() => {}); }
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
