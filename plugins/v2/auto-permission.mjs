// Narrow auto-allow for native permission asks (approve-only, never auto-reject):
//   1. names-only listing of system binary dirs: glob of `<dir>/*` (no `**`) or plain
//      `ls [-1|-a|-d] <dir>` on exactly /opt, /snap/bin, /bin, /sbin, /usr/bin, /usr/local/bin;
//   2. non-shell file operations whose lexical and real path lies inside <repo>/.review/.
// Never: /home/box outside the repo, credential dirs, secret-looking paths, or commands that
// start background processes. Every auto decision (allow or decline) is logged.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isSecretPath, markers, scanShell } from './shell-guard.mjs';
import { realish, fullAutoProjectFor, fullAutoShellCheck } from './full-auto.mjs';
import { statePath } from './paths.mjs';

export const LISTABLE_DIRS = ['/opt', '/snap/bin', '/bin', '/sbin', '/usr/bin', '/usr/local/bin'];
// 0.3.3: a real background job only (`cmd &`, nohup/setsid/disown, `$!`); `&&` and `2>&1` are not.
// Before 0.3.3 any `&` matched, so 10 of 10 logged declines were `&&` chains or `2>&1`.
export function startsBackground(text) {
  if (typeof text !== 'string' || !text) return false;
  if (/\$!/.test(text)) return true;
  const { segments } = scanShell(text);
  if (segments.some(segment => segment.prevSep === '&' || segment.words.some(word => /^(?:.*\/)?(nohup|setsid|disown)$/.test(word)))) return true;
  return /(^|[^&>|<])&\s*$/.test(text.trim()) || /(^|[^&>|<])&\s*\)/.test(text);
}
const BACKGROUND = { test: startsBackground };
const LS = /^ls((?:\s+-[1ad]+)*)\s+(\S+?)\/?$/;
const contains = (root, target) => target === root || target.startsWith(root + '/');

function credentialPath(target, home) {
  const creds = ['.ssh', '.aws', '.config', '.gnupg', '.docker', '.kube'].map(d => path.join(home, d));
  if (creds.some(c => contains(c, target))) return true;
  if (/(^|\/)gateway\/secrets(\/|$)/.test(target)) return true;
  return isSecretPath(target) || target.split('/').some(part => part && isSecretPath(part));
}

const stripGlob = resource => String(resource).replace(/\/\*$/, '');

// 0.3.3 full-auto: read-only tools may look anywhere outside the project except credential/secret
// paths and other projects' uncommitted files; a shell call's external_directory ask is allowed when
// the full-auto shell check finds nothing that must ask (it re-checks deletes, secrets, pushes,
// sudo/services, deploys) and it names no other project. Edits outside the project still ask.
export const READ_ONLY_TOOLS = new Set(['read', 'glob', 'grep', 'list', 'ls', 'large_file_check', 'structured_json_read', 'repo_identity', 'codesearch', 'lsp']);
const SHELL_TOOLS = new Set(['shell', 'bash']);
// Sibling git repositories of the project (e.g. /home/box/work/yrdsale for a demodirector session).
export function otherProjectOf(target, project, { exists = fs.existsSync } = {}) {
  const parent = path.dirname(project.directory);
  if (!contains(parent, target) || contains(project.directory, target)) return undefined;
  const top = target.slice(parent.length + 1).split('/')[0];
  if (!top) return undefined;
  const repo = path.join(parent, top);
  return exists(path.join(repo, '.git')) ? repo : undefined;
}
// Clean and tracked in its repository (read-only git, no optional locks): safe to read.
export function committedClean(repo, target, { run = execFileSync } = {}) {
  try {
    const rel = path.relative(repo, target) || '.';
    const opts = { cwd: repo, timeout: 2000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } };
    const status = run('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', 'status', '--porcelain', '--untracked-files=all', '--', rel], opts);
    if (String(status).trim()) return false;
    const tracked = run('git', ['--no-optional-locks', 'ls-files', '--', rel], opts);
    return Boolean(String(tracked).trim());
  } catch { return false; }
}
export function decideFullAutoExternal({ action, resources, tool, input, project, directory, home = os.homedir(), realpath = fs.realpathSync, exists = fs.existsSync, clean = committedClean } = {}) {
  const res = Array.isArray(resources) ? resources.map(String) : [];
  if (!res.length) return { decision: 'ask', reason: 'no_resources' };
  if (!['external_directory', 'read'].includes(action)) return { decision: 'ask', reason: 'full_auto_action_not_covered' };
  const shell = SHELL_TOOLS.has(tool);
  if (!shell && !READ_ONLY_TOOLS.has(tool)) return { decision: 'ask', reason: 'full_auto_tool_not_read_only' };
  for (const r of res) {
    const lexical = path.resolve(directory ?? '/', stripGlob(r).replace(/\/\*\*$/, ''));
    for (const candidate of [lexical, realish(lexical, { realpath })]) {
      if (credentialPath(candidate, home)) return { decision: 'ask', reason: 'credential_path' };
      const other = otherProjectOf(candidate, project, { exists });
      if (other && (shell || !clean(other, candidate))) return { decision: 'ask', reason: shell ? 'other_project_shell' : 'other_project_uncommitted' };
    }
  }
  if (shell) {
    const command = typeof input?.command === 'string' ? input.command : undefined;
    if (command === undefined) return { decision: 'ask', reason: 'shell_without_command' };
    const workdir = typeof input?.workdir === 'string' && input.workdir ? path.resolve(directory ?? '/', input.workdir) : directory;
    if (fullAutoShellCheck(command, workdir, project).length) return { decision: 'ask', reason: 'full_auto_shell_reasons' };
    // Words naming another project's files (cat ../yrdsale/x) ask: a shell may write them.
    for (const word of command.split(/[\s'"=:;|&()<>]+/).filter(word => word.startsWith('/') || word.startsWith('..'))) {
      const target = path.resolve(workdir ?? '/', word);
      if (otherProjectOf(target, project, { exists })) return { decision: 'ask', reason: 'other_project_shell' };
    }
    return { decision: 'allow', reason: 'full_auto_shell_external' };
  }
  return { decision: 'allow', reason: 'full_auto_read_only_external' };
}

export function decideAutoPermission({ action, resources, tool, input, directory, home = os.homedir(), realpath = fs.realpathSync, fullAutoProject } = {}) {
  if (fullAutoProject) return decideFullAutoExternal({ action, resources, tool, input, project: fullAutoProject, directory, home, realpath });
  const res = Array.isArray(resources) ? resources.map(String) : [];
  const command = typeof input?.command === 'string' ? input.command.trim() : undefined;
  const pattern = typeof input?.pattern === 'string' ? input.pattern : undefined;
  const texts = [...res, command ?? '', pattern ?? ''];
  if (texts.some(t => BACKGROUND.test(t))) return { decision: 'ask', reason: 'background_process' };
  const real = p => realish(p, { realpath });
  const repo = directory ? real(path.resolve(directory)) : undefined;
  // Absolute targets: native resources plus the shell/glob target, checked for forbidden areas.
  const absolute = res.filter(r => path.isAbsolute(r)).map(stripGlob);
  for (const target of absolute) {
    if (target.split('/').includes('..')) return { decision: 'ask', reason: 'dotdot' };
    for (const candidate of [path.resolve(target), real(path.resolve(target))]) {
      if (credentialPath(candidate, home)) return { decision: 'ask', reason: 'credential_path' };
      if (contains(home, candidate) && !(repo && contains(repo, candidate))) return { decision: 'ask', reason: 'home_outside_repo' };
    }
  }
  // Any shell-like tool or shell action only ever qualifies through the listing rule.
  const shellLike = tool === 'bash' || tool === 'shell' || action === 'bash' || action === 'shell' || command !== undefined;
  // Secret-looking or credential names anywhere in relative resources too.
  for (const r of res) if (!path.isAbsolute(r) && (r.split('/').includes('..') || credentialPath(path.resolve(repo ?? '/', stripGlob(r)), home) || r.split('/').some(part => part && isSecretPath(part)))) return { decision: 'ask', reason: 'credential_or_dotdot_relative' };
  // 1. names-only listing of system binary dirs.
  if (shellLike) {
    if (command === undefined) return { decision: 'ask', reason: 'shell_without_command' };
    const match = LS.exec(command);
    if (!match || /[;|<>`$(){}*?\n]/.test(command)) return { decision: 'ask', reason: 'shell_not_listing' };
    const dir = match[2].replace(/\/$/, '') || '/';
    if (!LISTABLE_DIRS.includes(dir)) return { decision: 'ask', reason: 'ls_outside_listable' };
    if (!res.every(r => r === dir || r === `${dir}/*` || r === command)) return { decision: 'ask', reason: 'resource_mismatch' };
    return { decision: 'allow', reason: 'ls_system_bin' };
  }
  if (tool === 'glob' && res.length && res.every(r => LISTABLE_DIRS.some(d => r === d || r === `${d}/*`))) {
    const inputPath = typeof input?.path === 'string' ? input.path.replace(/\/$/, '') : undefined;
    const ok = pattern === undefined || (!pattern.includes('**') && (
      (!pattern.includes('/') && (inputPath === undefined || LISTABLE_DIRS.includes(inputPath))) ||
      LISTABLE_DIRS.some(d => pattern === `${d}/*`)));
    return ok ? { decision: 'allow', reason: 'glob_system_bin' } : { decision: 'ask', reason: 'glob_recursive_or_nested' };
  }
  // 2. file operations inside <repo>/.review (never shell).
  if (repo && !shellLike && res.length) {
    const scratch = path.join(repo, '.review');
    let scratchReal;
    try { scratchReal = realpath(scratch); } catch { return { decision: 'ask', reason: 'no_scratch' }; }
    if (scratchReal !== scratch) return { decision: 'ask', reason: 'scratch_symlinked' };
    const allInside = res.every(r => {
      const lexical = path.resolve(repo, stripGlob(r));
      return !r.split('/').includes('..') && contains(scratch, lexical) && contains(scratchReal, real(lexical));
    });
    if (allInside) return { decision: 'allow', reason: 'review_scratch' };
  }
  return { decision: 'ask', reason: 'not_covered' };
}

export function autoPermissionLogger({ file = statePath('telemetry', 'auto-permission.jsonl') } = {}) {
  return record => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.appendFileSync(file, JSON.stringify(record) + '\n', { mode: 0o600 });
    } catch { /* logging must not affect permissions */ }
  };
}

export async function installAutoPermission(ctx, { log = autoPermissionLogger(), now = () => Date.now(), home = os.homedir(), realpath = fs.realpathSync, fullAutoProjects } = {}) {
  const permission = ctx?.permission;
  if (typeof permission?.hook !== 'function') return { stop() {} };
  const calls = new Map(); // `${sessionID}\0${callID}` -> {tool, input}
  if (typeof ctx.tool?.hook === 'function') {
    await ctx.tool.hook('execute.before', event => {
      if (!event?.sessionID || !event?.id || typeof event.tool !== 'string') return;
      if (calls.size >= 4096) calls.delete(calls.keys().next().value);
      calls.set(`${event.sessionID}\0${event.id}`, { tool: event.tool, input: event.input });
    });
    await ctx.tool.hook('execute.after', event => { calls.delete(`${event?.sessionID}\0${event?.id}`); });
  }
  await permission.hook('evaluate', event => {
    if (event?.effect !== 'ask' || event.metadata?.[markers.GUARD_MARKER]) return;
    const call = event.source?.id ? calls.get(`${event.sessionID}\0${event.source.id}`) : undefined;
    if (!call) return; // unknown tool/input: leave it with the human
    let verdict;
    try {
      const project = event.metadata?.[markers.PROBE_MARKER] ? undefined : fullAutoProjectFor(ctx.location?.directory, ...(fullAutoProjects ? [fullAutoProjects()] : []));
      verdict = decideAutoPermission({ action: event.action, resources: event.resources, tool: call.tool, input: call.input, directory: ctx.location?.directory, home, realpath, fullAutoProject: project });
    } catch { verdict = { decision: 'ask', reason: 'error' }; }
    const subject = typeof call.input?.command === 'string' ? call.input.command : (event.resources ?? []).join(' ');
    log({ time: new Date(now()).toISOString(), sessionID: event.sessionID, tool: call.tool, pattern: String(subject).slice(0, 200),
      decision: verdict.decision === 'allow' ? 'allow' : 'decline_to_auto', reason: verdict.reason });
    if (verdict.decision === 'allow') event.effect = 'allow';
  });
  return { stop() { calls.clear(); } };
}
