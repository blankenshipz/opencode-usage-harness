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

const listData = value => Array.isArray(value) ? value : Array.isArray(value?.data) ? value.data : [];

export async function installPermissionReevaluation(ctx, { delays = [1500, 6000], setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
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
  const pending = new Map(); // requestID -> sessionID
  const callAgents = new Map(); // `${sessionID}\0${callID}` -> agent
  const controller = new AbortController();
  let timers = [], running = Promise.resolve();

  if (typeof ctx.tool?.hook === 'function') {
    await ctx.tool.hook('execute.before', event => {
      if (!event?.sessionID || !event?.id || !event?.agent) return;
      if (callAgents.size >= 4096) callAgents.delete(callAgents.keys().next().value);
      callAgents.set(`${event.sessionID}\0${event.id}`, event.agent);
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
      for (const request of requests) {
        if (!request?.id || request.metadata?.[markers.GUARD_MARKER]) continue;
        const agent = request.source?.id ? callAgents.get(`${sessionID}\0${request.source.id}`) : undefined;
        try {
          await permission.assert({
            sessionID, ...(agent ? { agent } : {}), action: request.action, resources: request.resources,
            metadata: { ...(request.metadata ?? {}), [markers.PROBE_MARKER]: true },
          });
        } catch { continue; } // still ask, denied, or agent registry not reloaded yet
        try {
          await permission.reply({ sessionID, requestID: request.id, decision: 'once' });
          pending.delete(request.id);
          resolved.push(request.id);
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

  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        const data = event?.data ?? {};
        if (event?.type === 'permission.asked' && data.id && data.sessionID) pending.set(data.id, data.sessionID);
        else if (event?.type === 'permission.replied') pending.delete(data.requestID);
        else if (event?.type === 'config.updated' || event?.type === 'agent.updated') schedule();
      }
    } catch { /* re-evaluation is best effort; humans can still answer */ }
  })();
  return {
    recheck,
    stop() { controller.abort(); for (const timer of timers) clearTimer(timer); pending.clear(); callAgents.clear(); },
  };
}
