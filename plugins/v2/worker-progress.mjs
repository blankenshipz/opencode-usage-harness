// Parent-tool progress is intentionally closed-set metadata. Event payloads can
// contain prompts, tool input, output, and provider text, none of which belong
// in a parent-visible status update.
const ACTIVITY_EVENTS = new Set(['session.tool.input.started', 'session.tool.success', 'session.tool.failed',
  'permission.asked', 'permission.replied', 'form.created', 'form.replied', 'form.cancelled',
  'session.execution.failed', 'session.execution.interrupted']);
const TOOL = /^[a-z][a-z0-9_.-]{0,47}$/i;
const sessionID = value => typeof value === 'string' && value.startsWith('ses') ? value : undefined;
const toolName = value => typeof value === 'string' && TOOL.test(value) ? value : 'tool';

export function createWorkerProgress(ctx, { loadSessions, now = () => Date.now(), minInterval = 500 } = {}) {
  const entries = new Set(), names = new Map(), controller = new AbortController();
  let stopped = false, cachedSessions = [], cachedAt, refreshing;
  const related = async (root, candidate) => {
    if (candidate === root) return true;
    if (!loadSessions) return false;
    const at = now();
    if (!refreshing && (cachedAt === undefined || at - cachedAt >= minInterval)) refreshing = Promise.resolve(loadSessions()).then(value => {
      cachedSessions = Array.isArray(value) ? value : []; cachedAt = now();
    }).catch(() => {}).finally(() => { refreshing = undefined; });
    await refreshing;
    const byID = new Map(cachedSessions.map(item => [item.id, item]));
    const seen = new Set(); let current = byID.get(candidate);
    while (current?.parentID && !seen.has(current.id)) {
      if (current.parentID === root) return true;
      seen.add(current.id); current = byID.get(current.parentID);
    }
    return false;
  };
  const flush = async entry => {
    entry.timer = undefined;
    if (entry.closed || !entry.pending) return;
    const next = entry.pending; entry.pending = undefined;
    entry.signature = JSON.stringify(next); entry.publishedAt = now();
    // The parent context is the only supported way to replace live tool metadata.
    // Do not let a best-effort UI update change the worker result.
    try { await entry.progress(next); } catch { /* Tool may have settled while an event was queued. */ }
  };
  const publish = async entry => {
    if (entry.closed || !entry.childID) return;
    const activity = entry.state === 'blocked' ? 'Blocked' : 'Active';
    // OpenChamber v2.0.3 consumes `summary` on a running `subagent` call and
    // renders its closed-set tool row in the parent card.
    const visibleTool = entry.tool ?? 'subagent';
    // Code Mode calls plugin tools through an outer `execute` call. Its
    // supported live surface is `toolCalls`, so mirror the same sanitized row
    // there; direct subagent calls use `summary` below.
    const next = { sessionID: entry.childID, status: 'running', ...(entry.background ? { background: true } : {}), toolCalls: [{ tool: visibleTool, status: entry.state === 'blocked' ? 'error' : 'running' }], summary: [{ id: `worker:${entry.childID}`, tool: visibleTool, state: { status: entry.state === 'blocked' ? 'error' : 'running', title: activity } }], workerProgress: { state: entry.state, ...(entry.tool ? { tool: entry.tool } : {}), updatedAt: now() } };
    if (JSON.stringify(next) === entry.signature && !entry.pending) return;
    entry.pending = next;
    const delay = Math.max(0, minInterval - (now() - entry.publishedAt));
    if (entry.timer) return;
    if (!delay) return flush(entry);
    entry.timer = setTimeout(() => { void flush(entry); }, delay);
  };
  const observe = async event => {
    if (!entries.size || !ACTIVITY_EVENTS.has(event?.type)) return;
    const data = event?.data ?? {}, current = sessionID(data.sessionID);
    if (!current) return;
    if (event.type === 'session.tool.input.started') {
      if (names.size >= 512) names.delete(names.keys().next().value);
      names.set(`${current}\0${data.id}`, toolName(data.name));
    }
    if (event.type === 'session.tool.success' || event.type === 'session.tool.failed') names.delete(`${current}\0${data.id}`);
    const matches = await Promise.all([...entries].map(async entry => ({ entry, match: await related(entry.childID, current) })));
    for (const { entry, match } of matches) {
      if (!match || entry.closed) continue;
      if (event.type === 'session.tool.input.started') { entry.state = 'working'; entry.tool = names.get(`${current}\0${data.id}`); }
      else if (event.type === 'session.tool.success' || event.type === 'session.tool.failed') { if (entry.tool && current === entry.childID) entry.tool = undefined; entry.state = 'working'; }
      else if (event.type === 'permission.asked' || event.type === 'form.created') { entry.state = 'blocked'; entry.tool = undefined; }
      else if (event.type === 'permission.replied' || event.type === 'form.replied' || event.type === 'form.cancelled') entry.state = 'working';
      else if (event.type === 'session.execution.failed' || event.type === 'session.execution.interrupted') { entry.state = 'blocked'; entry.tool = undefined; }
      else continue;
      await publish(entry);
    }
  };
  if (ctx.event?.subscribe) void (async () => {
    try { for await (const event of ctx.event.subscribe({ signal: controller.signal })) await observe(event); }
    catch { /* A display-only stream failure must not surface event payloads. */ }
  })();
  return {
    attach(progress) {
      const entry = { progress, childID: undefined, state: 'working', tool: undefined, background: false, signature: undefined, publishedAt: -Infinity, pending: undefined, timer: undefined, closed: false };
      entries.add(entry);
      return {
        native: async update => {
          const child = sessionID(update?.sessionID);
          if (child) { entry.childID = child; entry.background = update?.background === true; entry.state = update?.status === 'blocked' ? 'blocked' : 'working'; await publish(entry); }
          // Never forward native metadata verbatim: only the closed-set snapshot
          // constructed by publish() reaches the parent tool's live state.
        },
        close: () => { entry.closed = true; if (entry.timer) clearTimeout(entry.timer); entries.delete(entry); },
      };
    },
    dispose() { if (stopped) return; stopped = true; controller.abort(); for (const entry of entries) { entry.closed = true; if (entry.timer) clearTimeout(entry.timer); } entries.clear(); names.clear(); },
  };
}
