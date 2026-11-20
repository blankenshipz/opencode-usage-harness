// Read-only path allowances outside the project (r20 item 1).
//
// Downgrades native external_directory / read asks to allow when every resource lies in:
//   - the session's own shell-output directory, <data>/opencode/shell/<location.project.id>/
//     (OpenCode core/src/shell.ts writes sh_*.out there; other projects' outputs may hold
//     secrets, so only the location's own project id qualifies), for any read-only tool; or
//   - /usr (system files), only for calls of the read-only tools read/glob/grep/list, so an
//     edit or write that passes the directory gate still hits its own edit ask.
// Never touches deny or guard-forced asks; secret-looking paths stay asked. Reevaluation probes
// are evaluated too, so asks raised before a deploy can be approved (never denied) by it.
import os from 'node:os';
import path from 'node:path';
import { isSecretPath, markers } from './shell-guard.mjs';
import { realish } from './full-auto.mjs';

export const READ_ONLY_TOOLS = new Set(['read', 'glob', 'grep', 'list']);
const SYSTEM_READ_ROOTS = ['/usr'];

export function opencodeDataDir(env = process.env) {
  const base = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(os.homedir(), '.local/share');
  return path.join(base, 'opencode');
}

export function shellOutputDir(projectID, env = process.env) {
  if (typeof projectID !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(projectID)) return undefined;
  return path.join(opencodeDataDir(env), 'shell', projectID);
}

const contains = (root, target) => target === root || target.startsWith(root + '/');

// resources: native resources (external_directory uses "<dir>/*"). Relative ones are internal to
// the location and never need this allowance, so they fail closed here.
export function readScopeAllows(resources, { action, tool, projectID, env = process.env, realpath } = {}) {
  if (action !== 'external_directory' && action !== 'read') return false;
  if (!Array.isArray(resources) || !resources.length) return false;
  const own = shellOutputDir(projectID, env);
  const readOnly = READ_ONLY_TOOLS.has(tool);
  return resources.every(resource => {
    if (typeof resource !== 'string' || !path.isAbsolute(resource)) return false;
    const target = resource.replace(/\/\*\*?$/, '');
    if (/[*?[\]{}]/.test(target) || target.split('/').includes('..')) return false;
    const lexical = path.resolve(target), real = realish(lexical, realpath ? { realpath } : undefined);
    if (lexical.split('/').some(part => part && isSecretPath(part))) return false;
    if (own && contains(own, lexical) && contains(realish(own, realpath ? { realpath } : undefined), real)) return true;
    return readOnly && SYSTEM_READ_ROOTS.some(root => contains(root, lexical) && contains(root, real));
  });
}

export async function installReadScope(ctx, { env = process.env } = {}) {
  const permission = ctx?.permission;
  if (typeof permission?.hook !== 'function') return { stop() {} };
  const callTools = new Map(); // `${sessionID}\0${callID}` -> tool
  if (typeof ctx.tool?.hook === 'function') {
    await ctx.tool.hook('execute.before', event => {
      if (!event?.sessionID || !event?.id || typeof event.tool !== 'string') return;
      if (callTools.size >= 4096) callTools.delete(callTools.keys().next().value);
      callTools.set(`${event.sessionID}\0${event.id}`, event.tool);
    });
    await ctx.tool.hook('execute.after', event => { callTools.delete(`${event?.sessionID}\0${event?.id}`); });
  }
  await permission.hook('evaluate', event => {
    // Guard-forced asks stay with a human. Reevaluation probes may pass (r20 item 3: approve-only).
    if (event?.effect !== 'ask' || event.metadata?.[markers.GUARD_MARKER]) return;
    const tool = event.source?.id ? callTools.get(`${event.sessionID}\0${event.source.id}`) : undefined;
    if (readScopeAllows(event.resources, { action: event.action, tool, projectID: ctx.location?.project?.id, env })) event.effect = 'allow';
  });
  return { stop() { callTools.clear(); } };
}
