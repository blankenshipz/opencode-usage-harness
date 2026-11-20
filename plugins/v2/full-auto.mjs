// Per-project "full-auto" permission profile.
//
// configure.py persists `full_auto_projects` ([{directory, data_dirs}]) in
// <state>/config/configure-choices.json. For sessions whose location lies inside one of those
// directories, the shell guard (shell-guard.mjs) downgrades native asks to allow:
//   - shell: only for calls the guard inspected in execute.before (session + tool-call id) and
//     found free of the still-dangerous forms below (fail closed: no inspection, no downgrade);
//   - external_directory / read / edit: when every resource resolves inside the project or a
//     configured data dir.
// Still asking under full-auto (fullAutoShellCheck): force/delete/mirror pushes and branch or tag
// deletes, history rewrites (rebase, commit --amend, filter-branch/filter-repo, reset --hard,
// reflog expire/delete, gc --prune, git prune, update-ref -d), deletes (rm/rmdir/unlink, find
// -delete/-exec rm, rsync --delete/--remove-source-files) whose targets are not strictly inside the
// project or a data dir (or are the project root or .git), disk writes (dd, mkfs*, shred, wipefs,
// partitioners, /dev block devices), secret-looking paths (except the value of docker's
// --env-file), truncating redirects outside the project, and the same inside sh/bash -c, eval, heredocs fed to a shell, and ssh remote commands
// (remote deletes of /, top-level dirs or the remote home). Deny rules are never touched.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { managedConfigRoot } from './paths.mjs';
import { scanShell, gitPushDanger, isSecretPath, isEnvTemplatePath, wildcardMatch, parseGitInvocation, isGitWord, cdTarget, literalPath } from './shell-guard.mjs';

// Must match configure.py SECRET_SHELL_ASK (tests/v2-full-auto.test.mjs checks).
export const SECRET_SHELL_PATTERNS = ['*.env*', '*auth.json*', '*.pem*', '*.key*', '*credentials*', '*secret*', '*financial-policy*', '*external-write-grants*'];
export const PATH_ACTIONS = new Set(['external_directory', 'read', 'edit']);

const contains = (root, target) => target === root || target.startsWith(root.endsWith('/') ? root : root + '/');
const strictlyInside = (root, target) => target !== root && contains(root, target);

// Resolves symlinks in the longest existing prefix of an absolute path.
export function realish(target, { realpath = fs.realpathSync } = {}) {
  let head = target;
  const tail = [];
  for (;;) {
    try { return path.join(realpath(head), ...tail); } catch {}
    const parent = path.dirname(head);
    if (parent === head) return target;
    tail.unshift(path.basename(head));
    head = parent;
  }
}

function normalizeProject(entry) {
  const raw = typeof entry === 'string' ? { directory: entry } : entry;
  if (!raw || typeof raw.directory !== 'string' || !path.isAbsolute(raw.directory)) return undefined;
  const directory = realish(path.resolve(raw.directory));
  if (directory === '/') return undefined;
  const dataDirs = (Array.isArray(raw.data_dirs) ? raw.data_dirs : [])
    .filter(dir => typeof dir === 'string' && path.isAbsolute(dir)).map(dir => realish(path.resolve(dir))).filter(dir => dir !== '/');
  return { directory, roots: [directory, ...dataDirs] };
}

let cache = { key: undefined, projects: [] };
// Reads full_auto_projects from configure-choices.json; cached by mtime/size so edits hot-reload.
export function loadFullAutoProjects({ choicesPath = path.join(managedConfigRoot, 'configure-choices.json'), stat = fs.statSync, readFile = fs.readFileSync } = {}) {
  let key;
  try { const info = stat(choicesPath); key = `${choicesPath}:${info.mtimeMs}:${info.size}`; } catch { return []; }
  if (cache.key === key) return cache.projects;
  let projects = [];
  try {
    const list = JSON.parse(readFile(choicesPath, 'utf8'))?.full_auto_projects;
    projects = (Array.isArray(list) ? list : []).map(normalizeProject).filter(Boolean);
  } catch { projects = []; }
  cache = { key, projects };
  return projects;
}

export function fullAutoProjectFor(directory, projects = loadFullAutoProjects()) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) return undefined;
  const resolved = realish(path.resolve(directory));
  return projects.find(project => contains(project.directory, resolved) || contains(project.directory, path.resolve(directory)));
}

// external_directory / read / edit: relative resources are location-internal; absolute ones
// (external_directory uses "<dir>/*") must lie inside the project or a data dir.
export function pathResourcesInside(resources, project, locationDirectory) {
  if (!Array.isArray(resources) || !resources.length) return false;
  return resources.every(resource => {
    if (typeof resource !== 'string' || !resource) return false;
    let target = resource.replace(/\/\*$/, '').replace(/\/\*\*$/, '');
    if (/[*?[\]{}]/.test(target)) return false;
    if (!path.isAbsolute(target)) {
      if (!locationDirectory) return false;
      target = path.resolve(locationDirectory, target);
    }
    const lexical = path.resolve(target), real = realish(lexical);
    return project.roots.some(root => contains(root, lexical) && contains(root, real));
  });
}

// Indexes of the words that are the value of docker's env-file option (`--env-file x` or
// `--env-file=x`) of a docker / docker-compose command. Docker loads that file into the
// containers' environment; deploys pass `.env` that way, so it is not a secret read.
// The docker word must be in command position: first word of the line or after a shell
// separator (`&&`, `||`, `|`, `;`, `&`, or a word ending in one), after leading VAR=value
// assignments and simple wrappers (sudo/env/timeout/nice/nohup/command/exec/time with their
// dash options and numeric arguments), the remote command of `ssh [opts] host`, or a
// `sh|bash -c` body. `cat docker
// --env-file .env`, `cp -- docker --env-file x.key …` and `sudo -u u docker …` do not qualify.
// A separator or `--` ends the exemption. Native resources are split on whitespace only.
const DOCKER_COMMAND = /^(?:.*\/)?(docker|docker-compose)$/;
const WRAPPER_COMMAND = /^(?:.*\/)?(sudo|env|timeout|nice|nohup|command|exec|time)$/;
const SSH_ARG_FLAGS = new Set(['-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-p', '-Q', '-R', '-S', '-W', '-w', '-B']);
export function dockerEnvFileValues(words) {
  const values = new Set();
  let state = 'command', docker = false;
  for (let k = 0; k < words.length; k++) {
    const raw = words[k];
    if (/^(&&|\|\|?|;|&)$/.test(raw)) { state = 'command'; docker = false; continue; }
    const word = raw.replace(/^["'(]+/, '');
    const ends = /[;&|]$/.test(raw);
    if (state === 'shell') {
      if (word === '-c') state = 'command'; // the -c body starts a command
      else if (!word.startsWith('-')) { state = 'args'; docker = false; } // a script file
    } else if (state === 'ssh') {
      if (SSH_ARG_FLAGS.has(word)) k++;
      else if (!word.startsWith('-')) state = 'command'; // the host; its remote command follows
    } else if (state === 'command' || state === 'wrapper') {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) && state === 'command') { /* assignment */ }
      else if (state === 'wrapper' && (word.startsWith('-') || /^\d+(\.\d+)?[smhd]?$/.test(word))) { /* wrapper option */ }
      else if (WRAPPER_COMMAND.test(word)) state = 'wrapper';
      else if (/^(?:.*\/)?ssh$/.test(word)) state = 'ssh';
      else if (SHELL_WORD.test(word)) state = 'shell';
      else { docker = DOCKER_COMMAND.test(word); state = 'args'; }
    } else if (docker) {
      if (word === '--') docker = false;
      else if (word === '--env-file' && k + 1 < words.length) { values.add(++k); if (/[;&|]$/.test(words[k])) { state = 'command'; docker = false; } continue; }
      else if (word.startsWith('--env-file=')) values.add(k);
    }
    if (ends) { state = 'command'; docker = false; }
  }
  return values;
}

// True when a native shell resource still names a secret-looking path once env templates and
// docker env-file values are removed.
export function secretShellResource(resource) {
  if (!SECRET_SHELL_PATTERNS.some(pattern => wildcardMatch(resource, pattern))) return false;
  const words = String(resource).split(/\s+/);
  const envFiles = dockerEnvFileValues(words);
  const rest = words.filter((word, k) => !isEnvTemplatePath(word) && !envFiles.has(k)).join(' ');
  return SECRET_SHELL_PATTERNS.some(pattern => wildcardMatch(rest, pattern));
}

const DISK_COMMANDS = /^(dd|mkfs(\..+)?|mke2fs|mkswap|shred|wipefs|fdisk|sfdisk|cfdisk|gdisk|sgdisk|parted|blkdiscard|hdparm|badblocks)$/;
const BLOCK_DEVICE = /^\/dev\/(sd|hd|vd|xvd|nvme|mmcblk|md|dm-|loop|disk|mapper\/|nbd|sr)/;
const SAFE_WRITE_TARGET = /^\/(dev\/(null|stdout|stderr|tty|fd\/\d+)|tmp\/|proc\/self\/fd\/)/;
const SHELL_WORD = /(^|\/)(sh|bash|zsh|dash|ksh|ash)$/;
// `docker rm`, `docker compose rm`, `git rm`, ... remove containers, volumes or index entries, not files.
const RM_HOSTS = new Set(['docker', 'podman', 'compose', 'docker-compose', 'podman-compose', 'container', 'image', 'volume', 'network',
  'kubectl', 'helm', 'buildx', 'builder', 'context', 'plugin', 'service', 'stack', 'npm', 'pnpm', 'yarn', 'cargo', 'systemctl', 'nerdctl', 'gh']);
const SSH_ARG_OPTIONS = new Set('BbcDEeFIiJLlmOopQRSWw'.split(''));
const REMOTE_HOME = '/home/~remote-home';
const isGlob = component => /[*?[\]]/.test(component);

const git = (words, k) => parseGitInvocation(words.slice(k + 1));

function gitHistoryDanger(words) {
  for (let k = 0; k < words.length; k++) {
    if (!isGitWord(words[k])) continue;
    const { sub, rest } = git(words, k);
    const args = []; for (const arg of rest) { if (arg === '--') break; args.push(arg); }
    const long = (arg, name, min = 3) => arg.startsWith('--') && arg.length >= min && name.startsWith(arg.slice(2).split('=')[0]);
    if (['rebase', 'filter-branch', 'filter-repo', 'prune', 'replace'].includes(sub)) return `git ${sub} rewrites history`;
    if (sub === 'commit' && args.some(arg => /^--am/.test(arg))) return 'git commit --amend rewrites history';
    if (sub === 'reset' && args.some(arg => long(arg, 'hard'))) return 'git reset --hard discards history and work';
    if (sub === 'reflog' && ['expire', 'delete'].includes(args[0])) return `git reflog ${args[0]} drops history`;
    if (sub === 'gc' && args.some(arg => /^--prune/.test(arg))) return 'git gc --prune drops unreachable history';
    if (sub === 'update-ref' && args.some(arg => arg === '-d' || long(arg, 'delete', 4))) return 'git update-ref -d deletes a ref';
    if (sub === 'tag' && args.some(arg => /^-[a-zA-Z]*d/.test(arg) || long(arg, 'delete', 4))) return 'git tag -d deletes a tag';
    if (sub === 'push' && args.some(arg => long(arg, 'force', 3) || long(arg, 'delete', 4) || long(arg, 'mirror', 4))) return 'git push rewrites or deletes remote refs';
  }
  return undefined;
}

// Classifies one delete target. ctx: { cwds (Set|undefined), roots, home, remote }.
function deleteTargetDanger(target, ctx) {
  if (!target || /[$`{}]/.test(target) || /^~[^/]/.test(target)) return `delete target ${JSON.stringify(target)} is not a literal path`;
  const home = ctx.remote ? REMOTE_HOME : ctx.home;
  const expanded = target === '~' || target.startsWith('~/') ? (home ? path.join(home, target.slice(2)) : undefined) : target;
  if (!expanded) return `delete target ${JSON.stringify(target)} has no known home`;
  const candidates = path.isAbsolute(expanded) ? [path.resolve(expanded)] : ctx.cwds ? [...ctx.cwds].map(cwd => path.resolve(cwd, expanded)) : undefined;
  if (!candidates) return `delete target ${JSON.stringify(target)} is relative to an unknown directory`;
  for (const candidate of candidates) {
    // A glob in the last component deletes the parent's contents: judge the parent.
    const effective = isGlob(path.basename(candidate)) ? path.dirname(candidate) : candidate;
    if (isGlob(effective)) return `delete target ${JSON.stringify(target)} globs over directories`;
    if (ctx.remote) {
      const depth = effective.split('/').filter(Boolean).length;
      if (depth < 2 || effective === REMOTE_HOME) return `remote delete of ${JSON.stringify(target)} reaches /, a top-level directory or the home directory`;
      continue;
    }
    const real = realish(effective);
    const inside = ctx.roots.some(root => strictlyInside(root, effective) && strictlyInside(root, real));
    if (!inside) return `delete target ${JSON.stringify(target)} resolves outside the project (${real})`;
    if (ctx.roots.some(root => contains(path.join(root, '.git'), effective) || contains(path.join(root, '.git'), real)))
      return `delete target ${JSON.stringify(target)} is git metadata`;
  }
  return undefined;
}

function rmDanger(words, ctx) {
  const reasons = [];
  const hasFind = words.some(word => /(^|\/)find$/.test(word));
  for (let k = 0; k < words.length; k++) {
    if (!/(^|\/)(rm|rmdir|unlink)$/.test(words[k])) continue;
    if (k > 0 && RM_HOSTS.has(words[k - 1])) continue;
    if (k > 0 && isGitWord(words[k - 1])) { // git rm: index + work tree of the current repository
      const parsed = git(words, k - 1);
      if (parsed.chdirs.length || parsed.unsafe) reasons.push('git rm in another repository');
    }
    if (words.slice(0, k).some(word => /(^|\/)(xargs|parallel)$/.test(word))) { reasons.push(`${words[k]} gets its targets from input`); continue; }
    let positional = false;
    for (const arg of words.slice(k + 1)) {
      if (!positional && arg === '--') { positional = true; continue; }
      if (!positional && arg.startsWith('-') && arg !== '-') { if (/^--no-preserve-root/.test(arg)) reasons.push('rm --no-preserve-root'); continue; }
      if ((arg === '{}' && hasFind) || arg === ';' || arg === '+') continue;
      const why = deleteTargetDanger(arg, ctx);
      if (why) reasons.push(why);
    }
  }
  return reasons;
}

function findDanger(words, ctx) {
  const reasons = [];
  for (let k = 0; k < words.length; k++) {
    if (!/(^|\/)find$/.test(words[k])) continue;
    const rest = words.slice(k + 1);
    const deletes = rest.includes('-delete') || rest.some((word, i) => /^-(exec|execdir|ok|okdir)$/.test(word) && /(^|\/)(rm|rmdir|unlink|shred)$/.test(rest[i + 1] ?? ''));
    if (!deletes) continue;
    const roots = [];
    for (const word of rest) { if (/^[-(!]/.test(word) || word === '(') break; roots.push(word); }
    for (const root of roots.length ? roots : ['.']) {
      // find roots are deleted below, never the root itself: judge as root/x.
      const why = deleteTargetDanger(root === '/' ? '/' : path.join(root, '__find_entry__'), ctx);
      if (why) reasons.push(why.replace('/__find_entry__', '').replace('__find_entry__', ''));
    }
  }
  return reasons;
}

function rsyncDanger(words, ctx, nested) {
  const reasons = [];
  for (let k = 0; k < words.length; k++) {
    if (!/(^|\/)rsync$/.test(words[k])) continue;
    const rest = words.slice(k + 1), positional = [];
    let deletes = false, removesSource = false;
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (/^--(del|delete)/.test(arg)) deletes = true;
      else if (/^--remove-source-files/.test(arg)) removesSource = true;
      else if (arg === '-e' || arg === '--rsh') { nested.push({ command: rest[++i] ?? '', remote: false }); }
      else if (/^--rsh=/.test(arg)) nested.push({ command: arg.slice(6), remote: false });
      else if (/^-[^-]/.test(arg) && arg.includes('e') && /^-[a-zA-Z]*e$/.test(arg)) nested.push({ command: rest[++i] ?? '', remote: false });
      else if (!arg.startsWith('-')) positional.push(arg);
    }
    const check = (spec, deleting) => {
      const remote = /^[^/.~][^/]*:/.test(spec);
      const target = remote ? spec.slice(spec.indexOf(':') + 1) || '~' : spec;
      const why = deleteTargetDanger(deleting ? path.join(target || '.', '__rsync_entry__') : target, { ...ctx, remote: remote || ctx.remote });
      if (why) reasons.push(`rsync ${deletes ? '--delete' : '--remove-source-files'}: ${why.replace('/__rsync_entry__', '')}`);
    };
    if (deletes && positional.length) check(positional.at(-1), true);
    if (removesSource) for (const source of positional.slice(0, -1)) check(source, false);
  }
  return reasons;
}

// Collects command strings that run elsewhere: sh/bash -c, eval, heredocs/here-strings fed to a
// shell or ssh, ssh remote commands. Returns reasons for inputs the guard cannot see.
function nestedCommands(segment, nested, ctx) {
  const { words, redirects } = segment;
  const reasons = [];
  const input = redirects.find(redirect => redirect.heredoc || redirect.herestring);
  for (let k = 0; k < words.length; k++) {
    const word = words[k];
    if (SHELL_WORD.test(word)) {
      const args = words.slice(k + 1);
      const c = args.findIndex(arg => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg));
      if (c >= 0) { const body = args.slice(c + 1).find(arg => !arg.startsWith('-')); nested.push({ command: body ?? '', remote: ctx.remote }); continue; }
      const script = args.find(arg => !arg.startsWith('-') && !arg.startsWith('+'));
      if (input) nested.push({ command: input.body ?? '', remote: ctx.remote });
      else if (!script && segment.prevSep === '|') reasons.push(`${word} runs commands piped from another command`);
    } else if (word === 'eval' && k === 0) {
      nested.push({ command: words.slice(k + 1).join(' '), remote: ctx.remote });
    } else if (/(^|\/)ssh$/.test(word)) {
      const args = words.slice(k + 1);
      let i = 0;
      for (; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--') { i++; break; }
        if (!arg.startsWith('-')) break;
        for (let j = 1; j < arg.length; j++) {
          if (!SSH_ARG_OPTIONS.has(arg[j])) continue;
          const value = arg.slice(j + 1) || args[++i] || '';
          if (arg[j] === 'o' && /^(proxycommand|localcommand|permitlocalcommand|knownhostscommand)/i.test(value)) reasons.push(`ssh -o ${value} runs a local command`);
          break;
        }
      }
      const remote = args.slice(i + 1);
      if (remote.length) nested.push({ command: remote.join(' '), remote: true });
      else if (input) nested.push({ command: input.body ?? '', remote: true });
      break;
    }
  }
  return reasons;
}

function segmentCwds(segments, base, home) {
  let cwds = base ? new Set([base]) : undefined;
  for (const segment of segments) {
    const { words } = segment;
    for (let k = 0; k < words.length; k++) {
      const word = words[k];
      if (['pushd', 'popd', 'chdir'].includes(word) || (word === 'cd' && k > 0)) return undefined;
      if (word !== 'cd') continue;
      if (!cwds) return undefined;
      const next = new Set(cwds);
      for (const cwd of cwds) { const target = cdTarget(cwd, words, home); if (!target) return undefined; next.add(target); }
      cwds = next;
    }
  }
  return cwds;
}

// Returns the reasons a full-auto project must still ask for a raw command (empty: allow).
// cwd: the shell's working directory; project: from fullAutoProjectFor. paths:false skips the
// path-dependent checks (used to re-check parsed native resources in the evaluate hook).
export function fullAutoShellCheck(command, cwd, project, { home = process.env.HOME || os.homedir(), remote = false, paths = true, depth = 0 } = {}) {
  if (typeof command !== 'string') return ['command is not a string'];
  if (depth > 4) return ['commands nested too deeply to inspect'];
  const { segments } = scanShell(command);
  const reasons = [];
  const ctx = { cwds: remote ? new Set([REMOTE_HOME]) : segmentCwds(segments, cwd, home), roots: project?.roots ?? [], home, remote };
  if (remote) { const tracked = segmentCwds(segments, REMOTE_HOME, REMOTE_HOME); ctx.cwds = tracked; ctx.home = REMOTE_HOME; }
  const nested = [];
  for (const segment of segments) {
    const { words, redirects } = segment;
    const text = JSON.stringify(segment.text.slice(0, 160));
    const push = gitPushDanger(words);
    if (push) reasons.push(`${text}: ${push}`);
    const history = gitHistoryDanger(words);
    if (history) reasons.push(`${text}: ${history}`);
    const disk = words.find(word => DISK_COMMANDS.test(word) || BLOCK_DEVICE.test(word) || /^of=\/dev\//.test(word));
    if (disk) reasons.push(`${text}: ${disk} writes disks or devices`);
    const envFiles = dockerEnvFileValues(words);
    const secret = words.find((word, k) => isSecretPath(word) && !isEnvTemplatePath(word) && !envFiles.has(k));
    if (secret !== undefined) reasons.push(`${text}: names secret-looking path ${JSON.stringify(secret)}`);
    for (const redirect of redirects) {
      if (!redirect.file) continue;
      if (isSecretPath(redirect.target)) reasons.push(`${text}: redirect to secret-looking path ${JSON.stringify(redirect.target)}`);
      if (BLOCK_DEVICE.test(redirect.target ?? '')) reasons.push(`${text}: redirect writes device ${redirect.target}`);
      if (paths && !remote && (['>', '>|', '&>', '<>'].includes(redirect.op) || /^\d+>$/.test(redirect.op))) {
        if (!SAFE_WRITE_TARGET.test(redirect.target ?? '')) {
          const why = deleteTargetDanger(redirect.target ?? '', ctx);
          if (why && !/is git metadata/.test(why)) reasons.push(`${text}: truncating redirect ${redirect.op} ${JSON.stringify(redirect.target)} (${why})`);
        }
      }
    }
    if (paths) reasons.push(...[...rmDanger(words, ctx), ...findDanger(words, ctx), ...rsyncDanger(words, ctx, nested)].map(why => `${text}: ${why}`));
    reasons.push(...nestedCommands(segment, nested, ctx).map(why => `${text}: ${why}`));
  }
  for (const inner of nested) {
    const innerCwd = inner.remote ? undefined : ctx.cwds && ctx.cwds.size === 1 ? [...ctx.cwds][0] : undefined;
    const innerReasons = innerCwd || inner.remote || !paths
      ? fullAutoShellCheck(inner.command, innerCwd, project, { home, remote: inner.remote || remote, paths, depth: depth + 1 })
      : fullAutoShellCheck(inner.command, undefined, project, { home, remote, paths, depth: depth + 1 });
    reasons.push(...innerReasons.map(why => `${inner.remote ? 'remote ' : 'nested '}${why}`));
  }
  return [...new Set(reasons)];
}

// Calls inspected by the guard and found safe under full-auto, keyed by session + tool call.
const VERIFIED = new Map();
const TTL_MS = 120_000;
const key = (sessionID, callID) => `${sessionID}\u0000${callID}`;

export function rememberFullAuto(event) {
  if (!event?.sessionID || !event?.id) return;
  const now = Date.now();
  for (const [k, entry] of VERIFIED) if (entry.expires <= now) VERIFIED.delete(k);
  VERIFIED.set(key(event.sessionID, event.id), { expires: now + TTL_MS });
}

// evaluate-hook half: shell asks for a verified call become allow unless a parsed resource is
// still dangerous on its own (secrets, pushes, history rewrites, disks). Never touches deny.
export function downgradeFullAutoShell(event, project) {
  const entry = VERIFIED.get(key(event.sessionID, event.source?.id));
  if (!entry || entry.expires <= Date.now() || !Array.isArray(event.resources) || !event.resources.length) return false;
  for (const resource of event.resources) {
    if (typeof resource !== 'string' || secretShellResource(resource)) return false;
    if (fullAutoShellCheck(resource, undefined, project, { paths: false }).length) return false;
  }
  event.effect = 'allow';
  return true;
}
