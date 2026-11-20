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

export const NOTIFY_AFTER_MS = 10 * 60_000;
export const PARK_AFTER_MS = 30 * 60_000;
export const PARK_TICK_MS = 60_000;

export function parkLogger({ file = statePath('telemetry', 'permission-park.jsonl') } = {}) {
  return record => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.appendFileSync(file, JSON.stringify(record) + '\n', { mode: 0o600 });
    } catch { /* logging must not affect permissions */ }
  };
}

export function createParkMonitor({ now = Date.now, notifyAfter = NOTIFY_AFTER_MS, parkAfter = PARK_AFTER_MS, log = () => {} } = {}) {
  const asks = new Map(); // requestID -> {sessionID, since, action, stalled, parked}
  const waiters = new Set();
  const parkedRecord = (id, ask) => ({ requestID: id, sessionID: ask.sessionID, action: ask.action, pendingMs: now() - ask.since });
  const offer = async record => {
    for (const waiter of [...waiters]) {
      let match = false;
      try { match = await waiter.match(record.sessionID); } catch { match = false; }
      if (match && waiters.delete(waiter)) waiter.resolve(record);
    }
  };
  return {
    asked({ id, sessionID, action, since = now() }) {
      if (!id || !sessionID || asks.has(id)) return;
      if (asks.size >= 4096) asks.delete(asks.keys().next().value);
      asks.set(id, { sessionID, action, since, stalled: false, parked: false });
    },
    replied(id) { asks.delete(id); },
    pending() { return [...asks].map(([id, ask]) => ({ requestID: id, ...ask })); },
    async tick() {
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
export const parkMonitor = createParkMonitor({ log: parkLogger() });

export function installParkYield(ctx, { monitor = parkMonitor, tickMs = PARK_TICK_MS, setTimer = setInterval, clearTimer = clearInterval } = {}) {
  if (typeof ctx?.event?.subscribe !== 'function') return { stop() {} };
  const controller = new AbortController();
  const timer = setTimer(() => { void monitor.tick().catch(() => {}); }, tickMs);
  timer?.unref?.();
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        const data = event?.data ?? {};
        if (event?.type === 'permission.asked' && data.id && data.sessionID) monitor.asked({ id: data.id, sessionID: data.sessionID, action: data.action });
        else if (event?.type === 'permission.replied') monitor.replied(data.requestID ?? data.id);
      }
    } catch { /* subscription closed */ }
  })();
  return { stop() { controller.abort(); clearTimer(timer); } };
}

// The parent-facing result for a parked foreground child. It is never a pass.
export function parkedResult({ parked, identity, collect }) {
  const minutes = Math.round(parked.pendingMs / 60_000);
  const content = `<subagent sessionID="${identity.sessionID}" state="blocked" agent="${identity.agent}" generation="${identity.generation}">\n` +
    `BLOCKED / INCOMPLETE: this child has waited ${minutes} min on permission request ${parked.requestID} (${parked.action ?? 'unknown action'}) in session ${parked.sessionID}. ` +
    `The ask is parked, not denied: it stays answerable by a human and the child resumes when it is answered.\n</subagent>\n\n` +
    `Harness park-and-yield: status blocked. This is NOT a pass: do not treat any verification, review or check from this child as passed or the task as complete. ` +
    `Continue other non-overlapping work or report the task blocked on human approval; after it is answered, collect with task_dispatch_collect(${JSON.stringify(collect)}).`;
  return { content, metadata: { ...identity, status: 'blocked', verdict: 'blocked', mode: 'parked', parked: { requestID: parked.requestID, sessionID: parked.sessionID, pendingMs: parked.pendingMs }, collect },
    output: { sessionID: identity.sessionID, status: 'blocked', output: content } };
}
