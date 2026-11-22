// Commit attribution (parity 4.12): give every shell the harness runs the
// identity the prepare-commit-msg hook turns into trailers.  OpenCode 2.0.30
// fires shell `create.before` with the mutable invocation env before spawning;
// tool `execute.before` (which runs first) tells us which agent owns the session.
// Values already present in the environment (for example set by workrelay) win.
const clean = value => typeof value === 'string' ? value.replace(/[\r\n]/g, ' ').trim().slice(0, 200) : '';

export async function installAgentAttribution(ctx) {
  if (typeof ctx?.shell?.hook !== 'function') return { agents: new Map() };
  const agents = new Map();
  if (typeof ctx.tool?.hook === 'function') {
    await ctx.tool.hook('execute.before', event => {
      const agent = clean(event?.agent);
      if (event?.sessionID && agent) {
        agents.delete(event.sessionID);
        agents.set(event.sessionID, agent);
        if (agents.size > 500) agents.delete(agents.keys().next().value);
      }
    });
  }
  await ctx.shell.hook('create.before', event => {
    if (!event || typeof event !== 'object') return;
    const env = event.env && typeof event.env === 'object' ? event.env : (event.env = {});
    const sessionID = clean(event.metadata?.sessionID);
    const agent = sessionID ? agents.get(sessionID) : '';
    if (agent) {
      env.HARNESS_AGENT ||= agent;
      env.HARNESS_ROLE ||= agent;
    }
    if (sessionID) env.WORKRELAY_SESSION_ID ||= sessionID;
  });
  return { agents };
}
