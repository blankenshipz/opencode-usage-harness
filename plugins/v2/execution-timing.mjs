// Passive timing telemetry. Event payloads can contain user content and provider
// state, so records deliberately retain only IDs, event names, timestamps, and
// the one native failure fact needed for rate-limit accounting.
import fs from 'node:fs/promises';
import path from 'node:path';
import { statePath } from './paths.mjs';

const DEFAULT_FILE = statePath('telemetry', 'execution-timing.jsonl');
const MAX_QUEUE = 256;
const MAX_TRACKED = 2048;
const MAX_GLOBAL_IDS = 8192;
const MAX_DESTINATIONS = 32;
const runtime = globalThis[Symbol.for('opencode-usage-harness.execution-timing')] ??=
  { destinations: new Map(), order: [] };

const string = (value, max = 256) => typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;
const stamp = (value, fallback) => Number.isFinite(value) && value >= 0 ? value : fallback();
const key = (...parts) => parts.map(part => string(part) ?? '').join('\0');

function remember(set, order, value, limit) {
  if (!value || set.has(value)) return false;
  set.add(value); order.push(value);
  if (order.length > limit) set.delete(order.shift());
  return true;
}

function nativeRateLimit(event) {
  // Do not infer a quota condition from an error message. The public event
  // schema supports an explicit numeric HTTP status on step failures.
  return event?.type === 'session.step.failed' && event?.data?.error?.status === 429;
}

function interval(map, order, id, value) {
  if (!id) return;
  map.set(id, value); order.push(id);
  if (order.length > MAX_TRACKED) map.delete(order.shift());
}

function destination(file) {
  let value = runtime.destinations.get(file);
  if (value) return value;
  value = { ids: new Set(), order: [], starts: new Map(), startOrder: [] };
  runtime.destinations.set(file, value); runtime.order.push(file);
  if (runtime.order.length > MAX_DESTINATIONS) runtime.destinations.delete(runtime.order.shift());
  return value;
}

/**
 * Subscribe passively to V2 execution boundaries. The returned cleanup function
 * only stops this observer; it never changes runtime execution or permissions.
 */
export function installExecutionTiming(ctx, options = {}) {
  const file = options.file ?? DEFAULT_FILE;
  const now = options.now ?? (() => Date.now());
  const io = options.io ?? fs;
  const maxQueue = Number.isInteger(options.maxQueue) && options.maxQueue > 0 ? options.maxQueue : MAX_QUEUE;
  const flushMs = Number.isInteger(options.flushMs) && options.flushMs >= 0 ? options.flushMs : 25;
  const controller = new AbortController();
  const pending = [];
  const shared = destination(file);
  const { starts, startOrder } = shared;
  let draining = false, stopped = false, dropped = 0, timer, activeDrain;

  const write = () => {
    if (draining) return activeDrain;
    if (pending.length === 0) return Promise.resolve();
    draining = true;
    const batch = pending.splice(0, pending.length);
    // Loss is reported beside the next retained event. This keeps diagnostics
    // parseable even when no separate diagnostic event has a session identity.
    // A loss count belongs to the observer service, not the session carried by
    // the retained record. Report it exactly once per batch.
    const reportedLoss = dropped;
    if (reportedLoss) batch[0] = { ...batch[0], droppedTelemetry: reportedLoss, telemetryScope: 'service' };
    activeDrain = (async () => { try {
      await io.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      try { await io.chmod(path.dirname(file), 0o700); } catch { /* best effort on restrictive filesystems */ }
      await io.appendFile(file, `${batch.map(record => JSON.stringify(record)).join('\n')}\n`, { mode: 0o600 });
      try { await io.chmod(file, 0o600); } catch { /* appendFile mode only applies on creation */ }
      if (reportedLoss) dropped = Math.max(0, dropped - reportedLoss);
    } catch {
      // Telemetry storage is intentionally unable to affect inference.
      dropped += batch.length;
    } finally {
      draining = false;
      if (!stopped && pending.length) schedule();
    } })();
    return activeDrain;
  };
  const schedule = () => {
    if (stopped || draining || timer || pending.length === 0) return;
    timer = setTimeout(() => { timer = undefined; void write(); }, flushMs);
  };
  const enqueue = record => {
    if (stopped) return;
    if (pending.length >= maxQueue) { dropped++; return; }
    pending.push(record);
    schedule();
  };
  const record = (event, phase, at, extra = {}) => {
    const data = event?.data ?? {};
    const sessionId = string(data.sessionID) ?? string(data.form?.sessionID);
    const messageId = string(data.assistantMessageID);
    const toolId = string(data.id);
    if (!sessionId) return;
    const eventId = string(event.id);
    enqueue({ schemaVersion: 1, eventId, observedAt: at, event: event.type, phase, sessionId,
      ...(messageId ? { messageId } : {}), ...(toolId ? { toolId } : {}), ...extra });
  };
  const observe = event => {
    if (stopped || !event || !remember(shared.ids, shared.order, string(event.id), MAX_GLOBAL_IDS)) return;
    const data = event.data ?? {}, at = stamp(event.created, now);
    if (event.type === 'session.step.started') {
      const id = key(data.sessionID, data.assistantMessageID);
      const startedAt = stamp(data.started, () => at);
      interval(starts, startOrder, `step:${id}`, startedAt);
      record(event, 'model_request', at, { startedAt });
      return;
    }
    if (event.type === 'session.step.streamed') {
      const id = `step:${key(data.sessionID, data.assistantMessageID)}`, startedAt = starts.get(id);
      starts.delete(id);
      record(event, 'model_request', at, { ...(startedAt === undefined ? {} : { startedAt, endedAt: at, durationMs: Math.max(0, at - startedAt) }), ...(nativeRateLimit(event) ? { rateLimited: true } : {}) });
      return;
    }
    if (event.type === 'session.step.failed') {
      starts.delete(`step:${key(data.sessionID, data.assistantMessageID)}`);
      // Step failures may be published after tool settlement. Preserve the
      // explicit status fact without inventing a provider-latency endpoint.
      record(event, 'observer', at, nativeRateLimit(event) ? { rateLimited: true } : {});
      return;
    }
    // `tool.called` is the supported boundary where native execution starts.
    // `tool.input.started` happens while the model is still producing the call.
    if (event.type === 'session.tool.called' && data.executed === false) {
      const id = `tool:${key(data.sessionID, data.assistantMessageID, data.id)}`;
      interval(starts, startOrder, id, at); record(event, 'native_tool', at, { startedAt: at, startBoundary: 'tool_called' }); return;
    }
    if ((event.type === 'session.tool.success' || event.type === 'session.tool.failed') && data.executed === false) {
      const id = `tool:${key(data.sessionID, data.assistantMessageID, data.id)}`, startedAt = starts.get(id);
      starts.delete(id); record(event, 'native_tool', at, startedAt === undefined ? { startBoundary: 'tool_called' } : { startBoundary: 'tool_called', startedAt, endedAt: at, durationMs: Math.max(0, at - startedAt) }); return;
    }
    if (event.type === 'permission.asked') {
      const id = `permission:${key(data.sessionID, data.id)}`;
      interval(starts, startOrder, id, at); record(event, 'permission', at, { requestId: string(data.id), startedAt: at }); return;
    }
    if (event.type === 'permission.replied') {
      const id = `permission:${key(data.sessionID, data.requestID)}`, startedAt = starts.get(id);
      starts.delete(id); record(event, 'permission', at, { requestId: string(data.requestID), ...(startedAt === undefined ? {} : { startedAt, endedAt: at, durationMs: Math.max(0, at - startedAt) }) }); return;
    }
    if (event.type === 'form.created') {
      const form = data.form ?? {}, id = `form:${key(form.sessionID, form.id)}`;
      interval(starts, startOrder, id, at); record(event, 'form', at, { formId: string(form.id), startedAt: at }); return;
    }
    if (event.type === 'form.replied' || event.type === 'form.cancelled') {
      const id = `form:${key(data.sessionID, data.id)}`, startedAt = starts.get(id);
      starts.delete(id); record(event, 'form', at, { formId: string(data.id), ...(startedAt === undefined ? {} : { startedAt, endedAt: at, durationMs: Math.max(0, at - startedAt) }) });
    }
  };

  if (typeof ctx?.event?.subscribe === 'function') void (async () => {
    try { for await (const event of ctx.event.subscribe({ signal: controller.signal })) observe(event); }
    catch { /* A failed passive subscription is never surfaced into execution. */ }
  })();
  return () => {
    stopped = true; controller.abort(); if (timer) clearTimeout(timer); timer = undefined;
    // Open intervals are shared with other plugin contexts targeting this file.
    // They expire through the bounded destination store if no terminal arrives.
    // Best effort only: stalled telemetry storage must not hold plugin reload.
    void (async () => { await write(); if (pending.length) await write(); })();
  };
}
