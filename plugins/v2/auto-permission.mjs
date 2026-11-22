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
import { realish, fullAutoProjectFor, fullAutoShellCheck, protectedLocation, containsProtected, toolOutputFileRead, defaultFullAutoProject, hardDenyCheck, hardDenyMessage } from './full-auto.mjs';
import { statePath } from './paths.mjs';
import { parkLogger } from './park-yield.mjs';

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

// 0.3.4: also browser profile data, agent browser profiles and the harness install (protectedLocation
// in full-auto.mjs; <state>/check-receipts, harness code and shell output stay readable).
export function credentialPath(target, home = os.homedir(), { exists } = {}) {
  const creds = ['.ssh', '.aws', '.config', '.gnupg', '.docker', '.kube'].map(d => path.join(home, d));
  if (creds.some(c => contains(c, target))) return true;
  if (/(^|\/)gateway\/secrets(\/|$)/.test(target)) return true;
  if (protectedLocation(target, exists ? { exists } : {})) return true;
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
// Recursive content search: a directory that contains a protected location reads it too.
const SEARCH_TOOLS = new Set(['grep', 'codesearch']);
// r40 M4: in full-auto this never returns `ask`. Credential/secret paths and edits outside the
// project and /tmp deny immediately with a resumable-blocker message; everything else is allowed
// (shell deletes and pushes are owned by the shell guard's hard-deny classifier).
export function fullAutoDenyMessage(reason, subject) {
  return `HARD DENY (harness auto-approve policy; rule: ${reason}): this permission is denied immediately and will not be asked. `
    + `Do not retry variants or workarounds. Record a resumable blocker naming ${JSON.stringify(String(subject ?? '').slice(0, 200))} and continue with other work.`;
}
export function decideFullAutoExternal({ action, resources, tool, input, project, directory, home = os.homedir(), realpath = fs.realpathSync, exists = fs.existsSync, clean = committedClean } = {}) {
  const res = Array.isArray(resources) ? resources.map(String) : [];
  const deny = (reason, subject = res.join(' ')) => ({ decision: 'deny', reason, message: fullAutoDenyMessage(reason, subject) });
  if (!res.length) return deny('no_resources', action);
  const shell = SHELL_TOOLS.has(tool);
  const readOnly = READ_ONLY_TOOLS.has(tool);
  const editLike = action === 'edit' || (!shell && !readOnly);
  if (!editLike && !['external_directory', 'read'].includes(action)) return { decision: 'allow', reason: 'full_auto_action_auto_approved' };
  const roots = [...(project?.roots ?? []), ...(project?.directory ? [project.directory] : [])];
  for (const r of res) {
    const lexical = path.resolve(directory ?? '/', stripGlob(r).replace(/\/\*\*$/, ''));
    // 0.4.0 (4.2): the read tool may open a single OpenCode tool-output tool_* file.
    if (tool === 'read' && action === 'read' && toolOutputFileRead('read', lexical)) continue;
    for (const candidate of [lexical, realish(lexical, { realpath })]) {
      if (credentialPath(candidate, home)) return deny('credential_path', r);
      if (SEARCH_TOOLS.has(tool) && (containsProtected(candidate) || ['.ssh', '.aws', '.config', '.gnupg'].some(d => contains(candidate, path.join(home, d)))))
        return deny('search_covers_credential_path', r);
      if (editLike && !roots.some(root => contains(root, candidate)) && !(candidate.startsWith('/tmp/')))
        return deny('edit_outside_project', r);
    }
  }
  if (editLike) return { decision: 'allow', reason: 'full_auto_edit_inside_project_or_tmp' };
  if (shell) {
    const command = typeof input?.command === 'string' ? input.command : undefined;
    if (command === undefined) return deny('shell_without_command');
    const workdir = typeof input?.workdir === 'string' && input.workdir ? path.resolve(directory ?? '/', input.workdir) : directory;
    const hard = hardDenyCheck(command, workdir, project);
    if (hard.length) return { decision: 'deny', reason: 'full_auto_shell_hard_deny', message: hardDenyMessage(hard, command) };
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

export async function installAutoPermission(ctx, { log = autoPermissionLogger(), now = () => Date.now(), home = os.homedir(), realpath = fs.realpathSync, fullAutoProjects, defaultFullAuto = true, hardDenyLog = ctx?.location?.directory ? parkLogger() : () => {} } = {}) {
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
    let verdict, project;
    try {
      project = event.metadata?.[markers.PROBE_MARKER] ? undefined : (fullAutoProjectFor(ctx.location?.directory, ...(fullAutoProjects ? [fullAutoProjects()] : [])) ?? (defaultFullAuto ? defaultFullAutoProject(ctx.location?.directory) : undefined));
      verdict = decideAutoPermission({ action: event.action, resources: event.resources, tool: call.tool, input: call.input, directory: ctx.location?.directory, home, realpath, fullAutoProject: project });
    } catch { verdict = { decision: 'ask', reason: 'error' }; }
    const subject = typeof call.input?.command === 'string' ? call.input.command : (event.resources ?? []).join(' ');
    log({ time: new Date(now()).toISOString(), sessionID: event.sessionID, tool: call.tool, pattern: String(subject).slice(0, 200),
      decision: verdict.decision === 'allow' ? 'allow' : verdict.decision === 'deny' && project ? 'deny' : 'decline_to_auto', reason: verdict.reason });
    if (verdict.decision === 'allow') event.effect = 'allow';
    else if (verdict.decision === 'deny' && project) {
      // r40 M4: full-auto hard deny, immediately and without a pending ask.
      event.effect = 'deny';
      if (verdict.message) event.message = verdict.message;
      hardDenyLog({ at: new Date(now()).toISOString(), event: 'ask_hard_denied', sessionID: event.sessionID, permissionID: event.id ?? null, callID: event.source?.id ?? null, rule: verdict.reason, action: event.action, source: 'auto_permission' });
    }
  });
  return { stop() { calls.clear(); } };
}
