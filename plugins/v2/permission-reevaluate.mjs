// Re-evaluates pending native permission asks after a config reload.
//
// OpenCode 2.0.30 re-evaluates pending asks only after an "always" reply, so an
// ask raised under old rules stays pending after a more permissive hot reload.
// On config.updated / agent.updated this module re-checks each pending request
// through the native evaluator (permission.assert with a probe marker that the
// shell guard's evaluate hook turns from ask into deny, so a probe never creates
// a new ask) and replies "once" only when the current rules now allow it.
// Requests forced by the harness shell guard always stay with a human.
import { markers } from './shell-guard.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { statePath } from './paths.mjs';
import { PROBE_TOOL } from './read-scope.mjs';

// r20 items 2/3: the pending map is persisted per location, so a plugin hot reload (deploy) can
// re-check asks raised under the previous release. Decisions are approve-only and logged.
export function pendingStore(directory, { root = statePath('permission-pending') } = {}) {
  const file = path.join(root, `${crypto.createHash('sha256').update(String(directory ?? '')).digest('hex').slice(0, 24)}.json`);
  return {
    file, root,
    load() {
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        const meta = data?.meta && typeof data.meta === 'object' ? data.meta : {};
        return Object.entries(data?.pending ?? {}).filter(([id, sid]) => typeof id === 'string' && typeof sid === 'string')
          .map(([id, sid]) => [id, sid, meta[id] && typeof meta[id] === 'object' ? meta[id] : {}]);
      } catch { return []; }
    },
    save(map, meta = new Map()) {
      try {
        // r32 item 3: an empty pending map leaves no file behind.
        if (!map.size) { try { fs.unlinkSync(file); } catch (error) { if (error?.code !== 'ENOENT') throw error; } return; }
        fs.mkdirSync(root, { recursive: true, mode: 0o700 });
        const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify({ pending: Object.fromEntries(map), meta: Object.fromEntries([...meta].filter(([id]) => map.has(id))) }), { mode: 0o600 });
        fs.renameSync(temporary, file);
      } catch { /* best effort */ }
    },
  };
}

// r32 item 3: remove `{"pending":{},...}` files left behind by earlier releases. A file is moved
// aside atomically before it is judged, so a concurrent writer's file is never lost: anything
// that is not a parseable, empty pending map is linked back (unless a newer file already exists).
export function isEmptyPendingText(text) {
  try {
    const data = JSON.parse(text);
    return data !== null && typeof data === 'object' && !Array.isArray(data)
      && data.pending !== null && typeof data.pending === 'object' && !Array.isArray(data.pending) && Object.keys(data.pending).length === 0;
  } catch { return false; }
}
export function sweepEmptyPending({ root = statePath('permission-pending'), io = fs } = {}) {
  const removed = [];
  let names;
  try { names = io.readdirSync(root); } catch { return removed; }
  // Fable r32: a crash between the move-aside and the restore strands a file as `.sweep`;
  // recover it (restore when no newer file exists, else drop it) once it is a minute old.
  for (const name of names) {
    const match = name.match(/^([a-f0-9]{24}\.json)\.\d+\.[0-9a-f-]{36}\.sweep$/);
    if (!match) continue;
    const aside = path.join(root, name), file = path.join(root, match[1]);
    try {
      if (Date.now() - io.lstatSync(aside).mtimeMs < 60_000) continue;
      if (!isEmptyPendingText(io.readFileSync(aside, 'utf8'))) { try { io.linkSync(aside, file); } catch { /* a newer file exists */ } }
      io.unlinkSync(aside);
    } catch { /* leave it */ }
  }
  for (const name of names) {
    if (!/^[a-f0-9]{24}\.json$/.test(name)) continue;
    const file = path.join(root, name);
    let text;
    try { if (!io.lstatSync(file).isFile()) continue; text = io.readFileSync(file, 'utf8'); } catch { continue; }
    if (!isEmptyPendingText(text)) continue;
    const aside = `${file}.${process.pid}.${crypto.randomUUID()}.sweep`;
    try { io.renameSync(file, aside); } catch { continue; }
    let empty = false;
    try { empty = isEmptyPendingText(io.readFileSync(aside, 'utf8')); } catch { /* keep it */ }
    if (empty) { try { io.unlinkSync(aside); removed.push(name); } catch {} continue; }
    // A writer replaced it between the read and the move: restore without clobbering anything newer.
    try { io.linkSync(aside, file); } catch { /* a newer file exists */ }
    try { io.unlinkSync(aside); } catch {}
  }
  return removed;
}
const sweptRoots = new Set(); // sweep each pending root once per module instance

export function reevaluationLogger({ file = statePath('telemetry', 'permission-reevaluation.jsonl') } = {}) {
  return record => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.appendFileSync(file, JSON.stringify(record) + '\n', { mode: 0o600 });
    } catch { /* logging must not affect permissions */ }
  };
}

const listData = value => Array.isArray(value) ? value : Array.isArray(value?.data) ? value.data : [];

export async function installPermissionReevaluation(ctx, { delays = [1500, 6000], setTimer = setTimeout, clearTimer = clearTimeout,
  store = ctx?.location?.directory ? pendingStore(ctx.location.directory) : undefined,
  log = ctx?.location?.directory ? reevaluationLogger() : () => {}, now = () => Date.now(),
  sweep = store?.root ? () => sweepEmptyPending({ root: store.root }) : undefined } = {}) {
  const permission = ctx?.permission;
  if (typeof ctx?.event?.subscribe !== 'function' || typeof permission?.hook !== 'function' || typeof permission?.assert !== 'function' ||
      typeof permission?.list !== 'function' || typeof permission?.reply !== 'function') return { stop() {}, recheck: async () => [] };
  // Without this hook a probe would create a real pending ask; install it first.
  await permission.hook('evaluate', event => {
    if (event?.metadata?.[markers.PROBE_MARKER] && event.effect !== 'allow') {
      event.effect = 'deny';
      event.message = 'harness permission probe: still requires approval';
    }
  });
  const sweepKey = store?.root ?? '';
  if (sweep && !sweptRoots.has(sweepKey)) {
    sweptRoots.add(sweepKey);
    try { const removed = sweep(); if (removed.length) log({ at: new Date(now()).toISOString(), event: 'pending_files_swept', removed: removed.length }); } catch {}
  }
  const loaded = store?.load?.() ?? [];
  const pending = new Map(loaded.map(([id, sid]) => [id, sid])); // requestID -> sessionID
  // requestID -> {agent, tool} of the asking call, so a probe after reload uses the asking agent's rules.
  const askMeta = new Map(loaded.map(([id, , meta]) => [id, { agent: typeof meta?.agent === 'string' ? meta.agent : undefined, tool: typeof meta?.tool === 'string' ? meta.tool : undefined }]));
  const reloaded = new Set(loaded.map(([id]) => id)); // raised under the previous plugin instance
  const persist = () => { for (const id of askMeta.keys()) if (!pending.has(id)) askMeta.delete(id); store?.save?.(pending, askMeta); };
  let trigger = pending.size ? 'reload' : 'config';
  const callAgents = new Map(); // `${sessionID}\0${callID}` -> agent
  const controller = new AbortController();
  let timers = [], running = Promise.resolve();

  if (typeof ctx.tool?.hook === 'function') {
    await ctx.tool.hook('execute.before', event => {
      if (!event?.sessionID || !event?.id || !event?.agent) return;
      if (callAgents.size >= 4096) callAgents.delete(callAgents.keys().next().value);
      callAgents.set(`${event.sessionID}\0${event.id}`, { agent: event.agent, tool: typeof event.tool === 'string' ? event.tool : undefined });
    });
    await ctx.tool.hook('execute.after', event => { callAgents.delete(`${event?.sessionID}\0${event?.id}`); });
  }

  const recheckOnce = async () => {
    const resolved = [];
    const sessions = new Set(pending.values());
    for (const sessionID of sessions) {
      let requests;
      try { requests = listData(await permission.list({ sessionID })); } catch { continue; }
      const live = new Set(requests.map(request => request?.id));
      for (const [id, owner] of pending) if (owner === sessionID && !live.has(id)) pending.delete(id);
      persist();
      for (const request of requests) {
        if (!request?.id || request.metadata?.[markers.GUARD_MARKER]) continue;
        const call = (request.source?.id ? callAgents.get(`${sessionID}\0${request.source.id}`) : undefined) ?? askMeta.get(request.id);
        const agent = call?.agent, tool = call?.tool;
        // Without the asking agent a probe could use a broader ruleset: leave it with a human.
        if (!agent && reloaded.has(request.id)) {
          log({ at: new Date(now()).toISOString(), trigger, sessionID, requestID: request.id, action: request.action, outcome: 'still_pending', why: 'agent_unknown' });
          continue;
        }
        try {
          await permission.assert({
            sessionID, ...(agent ? { agent } : {}), action: request.action, resources: request.resources,
            metadata: { ...(request.metadata ?? {}), [markers.PROBE_MARKER]: true, ...(tool ? { [PROBE_TOOL]: tool } : {}) },
          });
        } catch {
          // still ask, denied, or agent registry not reloaded yet: never auto-deny, leave it to a human
          log({ at: new Date(now()).toISOString(), trigger, sessionID, requestID: request.id, action: request.action, outcome: 'still_pending' });
          continue;
        }
        try {
          await permission.reply({ sessionID, requestID: request.id, decision: 'once' });
          pending.delete(request.id); persist();
          resolved.push(request.id);
          log({ at: new Date(now()).toISOString(), trigger, sessionID, requestID: request.id, action: request.action,
            resources: (request.resources ?? []).map(r => String(r).slice(0, 160)), outcome: 'approved_once' });
        } catch { /* already answered elsewhere */ }
      }
    }
    return resolved;
  };
  const recheck = () => (running = running.catch(() => []).then(recheckOnce));
  const schedule = () => {
    if (!pending.size) return;
    for (const timer of timers) clearTimer(timer);
    // The agent registry is briefly empty during reload (missing agents evaluate
    // as deny), so check once shortly after and once more after it settles.
    timers = delays.map(delay => setTimer(() => { void recheck(); }, delay));
  };

  // Asks persisted by the previous plugin instance (deploy hot reload) are re-checked once rules settle.
  schedule();
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        const data = event?.data ?? {};
        if (event?.type === 'permission.asked' && data.id && data.sessionID) {
          pending.set(data.id, data.sessionID);
          const call = data.source?.id ? callAgents.get(`${data.sessionID}\0${data.source.id}`) : undefined;
          askMeta.set(data.id, { agent: call?.agent, tool: call?.tool });
          persist();
        }
        else if (event?.type === 'permission.replied') { if (pending.delete(data.requestID)) persist(); }
        else if (event?.type === 'config.updated' || event?.type === 'agent.updated') { trigger = 'config'; schedule(); }
      }
    } catch { /* re-evaluation is best effort; humans can still answer */ }
  })();
  return {
    recheck,
    stop() { controller.abort(); for (const timer of timers) clearTimer(timer); pending.clear(); callAgents.clear(); }, // keeps the store for the next instance
  };
}
