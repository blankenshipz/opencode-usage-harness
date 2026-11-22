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
// deletes, history rewrites (rebase, commit --amend unless every amend in the command is a top-level
// git commit in a repo inside the project whose branch is not main/master and whose HEAD is on no
// remote-tracking branch, filter-branch/filter-repo, reset --hard,
// reflog expire/delete, gc --prune, git prune, update-ref -d), deletes (rm/rmdir/unlink, find
// -delete/-exec rm, rsync --delete/--remove-source-files) whose targets are not strictly inside the
// project or a data dir (or are the project root or .git), disk writes (dd, mkfs*, shred, wipefs,
// partitioners, /dev block devices), secret-looking paths (except the value of docker's
// --env-file), truncating redirects outside the project, and the same inside sh/bash -c, eval, heredocs fed to a shell, and ssh remote commands
// (remote deletes of /, top-level dirs or the remote home). Deny rules are never touched.
// Standing exemption (0.3.2, operator: "always allow read-only access to /opt/wncscanner-docker/.env and
// the wncscanner-stack service"): see garageEnvReads / garageUnitDanger below. Changes to the
// wncscanner-stack unit (systemctl restart/stop/edit/..., writes to its unit file) always ask.

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { managedConfigRoot, stateRoot } from './paths.mjs';
import { scanShell, gitPushDanger, isSecretPath, secretWords, secretLiterals, wildcardMatch, parseGitInvocation, isGitWord, cdTarget, literalPath, nonFileWords } from './shell-guard.mjs';

// Must match configure.py SECRET_SHELL_ASK (tests/v2-full-auto.test.mjs checks). These native
// wildcards match the whole command string (`*.key*` also hits `d.keys()`); the shell guard drops
// an ask that only they raised when its argument-aware check finds no secret path.
export { SECRET_SHELL_PATTERNS } from './shell-guard.mjs';
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
  // no_push_deploy (0.3.3): pushes and deploys always ask in this project (yrdsale Phase 1 rule).
  // 0.4.0: no_push_deploy is parsed for back-compat but is a no-op (auto-approve; pushes and deploys allowed).
  return { directory, roots: [directory, ...dataDirs] };
}

// 0.3.4 (r36): protected locations. Read tools and read-only shell must ask for them even under
// full-auto: browser profile data (Chrome/Chromium user-data dirs and their Cookies, Login Data,
// Web Data, Local State files), the agents' logged-in browser profiles, browser-probe profile
// copies, and the harness install itself (bridge config, gateway, claude-config, xdg, state).
// Exceptions that stay readable: <state>/check-receipts/** (sessions read their own test receipts),
// the harness code <install>/harness/** (sessions run harness/releases/<v>/src/check_receipt.py)
// and OpenCode's shell-output files <xdg data>/opencode/shell/** (a session's own command output).
export const PROTECTED_DIRS = ['/home/box/work/agent-profiles', '/home/box/work/ocharness'];
export const READABLE_DIRS = ['/home/box/work/ocharness/state/check-receipts', '/home/box/work/ocharness/harness', '/home/box/work/ocharness/xdg/data/opencode/shell'];
// 0.4.0 (4.2): the `read` tool may open one OpenCode tool-output file (tool_*); no list/glob/grep there.
export const TOOL_OUTPUT_DIR = '/home/box/work/ocharness/xdg/data/opencode/tool-output';
export function toolOutputFileRead(action, target) {
  if (action !== 'read' || typeof target !== 'string' || !path.isAbsolute(target)) return false;
  const resolved = path.resolve(target);
  return path.dirname(resolved) === TOOL_OUTPUT_DIR && /^tool_[A-Za-z0-9._-]+$/.test(path.basename(resolved));
}
// Directories under which any component named like *profile* is a browser profile copy.
export const PROFILE_PARENTS = ['/workspace/browser-probe'];
const BROWSER_DATA_FILE = /^(Cookies|Extension Cookies|Safe Browsing Cookies|Login Data|Login Data For Account|Web Data|Local State)(-journal|-wal|-shm)?$/;
const PROFILE_DIR = /^(Default|Profile \d+|Guest Profile|System Profile)$/;
const CHROME_ANCESTOR = /chrom|user[-_ ]?data|browser[-_ ]?profile|agent[-_ ]?profile/i;

// Harness roots from the environment: the state dir (and its parent install when it is named
// `state`, as in <install>/state), OCH and CLAUDE_CONFIG_DIR, plus HARNESS_PROTECTED_DIRS (colon list).
export function protectedRoots({ env = process.env, state = stateRoot, home = os.homedir() } = {}) {
  const roots = new Set(PROTECTED_DIRS), readable = new Set(READABLE_DIRS);
  const add = dir => { if (typeof dir === 'string' && path.isAbsolute(dir)) { const r = path.resolve(dir); if (r !== '/' && r !== path.resolve(home)) roots.add(r); } };
  if (state && path.isAbsolute(state)) {
    add(state); readable.add(path.join(path.resolve(state), 'check-receipts'));
    if (path.basename(state) === 'state') add(path.dirname(path.resolve(state)));
  }
  add(env.OCH); add(env.CLAUDE_CONFIG_DIR);
  if (env.OCH && path.isAbsolute(env.OCH)) readable.add(path.join(path.resolve(env.OCH), 'harness'));
  if (env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME)) readable.add(path.join(path.resolve(env.XDG_DATA_HOME), 'opencode', 'shell'));
  for (const dir of String(env.HARNESS_PROTECTED_DIRS ?? '').split(':').filter(Boolean)) add(dir);
  return { roots: [...roots], readable: [...readable] };
}

// Reason an absolute path is a protected location (undefined: not protected). Lexical, plus an
// existence check for a Chrome `Local State` file in each ancestor (a user-data dir).
export function protectedLocation(target, { exists = fs.existsSync, roots = protectedRoots() } = {}) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) return undefined;
  const resolved = path.resolve(target);
  const parts = resolved.split('/').filter(Boolean);
  for (let k = 0; k < parts.length; k++) {
    const part = parts[k];
    if (BROWSER_DATA_FILE.test(part)) return `browser profile data ${JSON.stringify(part)}`;
    if (PROFILE_DIR.test(part) && parts.slice(0, k).some(p => CHROME_ANCESTOR.test(p))) return 'browser profile directory';
  }
  for (const parent of PROFILE_PARENTS) {
    if (strictlyInside(parent, resolved) && resolved.slice(parent.length + 1).split('/').some(part => /profile/i.test(part))) return 'browser profile copy';
  }
  for (let k = parts.length; k >= 1; k--) {
    const dir = '/' + parts.slice(0, k).join('/');
    try { if (exists(path.join(dir, 'Local State'))) return 'browser user-data directory'; } catch {}
  }
  if (roots.readable.some(dir => contains(dir, resolved))) return undefined;
  const root = roots.roots.find(dir => contains(dir, resolved));
  return root ? `harness/agent-profile location ${root}` : undefined;
}

// Search tools (grep, codesearch) on a directory that contains a protected root read it too.
export function containsProtected(target, { roots = protectedRoots() } = {}) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) return false;
  const resolved = path.resolve(target);
  return [...roots.roots, ...PROFILE_PARENTS].some(root => strictlyInside(resolved, root));
}

// Path-like words and redirect targets of one local segment that name a protected location.
// Relative words are resolved against every possible cwd; unknown variables are skipped.
function segmentProtectedReasons(segment, words, ctx, text) {
  const reasons = [];
  const skip = nonFileWords(segment.words);
  const candidates = [];
  words.forEach((word, k) => { if (!skip.has(k)) candidates.push(word.replace(/^(--?[\w-]+|[A-Za-z_][A-Za-z0-9_]*)=/, '')); });
  for (const redirect of segment.redirects) if (redirect.file && redirect.target) candidates.push(redirect.target);
  const roots = protectedRoots();
  const check = target => protectedLocation(target, { roots });
  for (const raw of candidates) {
    if (!raw || raw.startsWith('-') && !raw.includes('/')) continue;
    let word = raw.replace(/^(\$\{HOME\}|\$HOME)(?=\/|$)/, '~');
    if (word === '~' || word.startsWith('~/')) word = ctx.home ? path.join(ctx.home, word.slice(2)) : '';
    if (!word || word.includes('$') || /^~/.test(word)) continue;
    const targets = path.isAbsolute(word) ? [word] : [...(ctx.cwds ?? [])].map(cwd => path.resolve(cwd, word));
    for (const target of targets) {
      const why = check(target) ?? check(realish(target));
      if (why) { reasons.push(`${text}: names protected path ${JSON.stringify(raw.slice(0, 120))} (${why})`); break; }
    }
  }
  if (segment.hasCommand !== false && ctx.cwds) for (const cwd of ctx.cwds) {
    const why = check(cwd);
    if (why) { reasons.push(`${text}: runs inside protected directory ${JSON.stringify(cwd)} (${why})`); break; }
  }
  return reasons;
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

// 0.4.0: any project directory not listed gets the same auto-approve + hard-deny policy.
// r40 M5: the fallback root must be a real project directory, never a broad parent. The path is
// resolved and realpath'd first (so `/.`, `//` and symlinked aliases are judged by their target).
// Allowed: strictly under $HOME with at least 3 components, or strictly under /workspace or /tmp;
// never a directory that equals or contains $HOME, $HOME/work or /workspace.
const FALLBACK_REFUSED = ['/', '/home', '/workspace', '/opt', '/etc', '/usr', '/var', '/tmp', '/root', '/srv', '/mnt', '/media'];
export function defaultFullAutoProject(directory, { home = os.homedir(), realpath = fs.realpathSync } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) return undefined;
  const real = p => realish(path.resolve(p), { realpath });
  const resolved = real(directory);
  const homeReal = typeof home === 'string' && path.isAbsolute(home) ? real(home) : undefined;
  const depth = resolved.split('/').filter(Boolean).length;
  const refused = new Set([...FALLBACK_REFUSED, ...FALLBACK_REFUSED.map(real)]);
  if (refused.has(resolved)) return undefined;
  const parents = ['/workspace', real('/workspace')];
  if (homeReal) parents.push(homeReal, path.join(homeReal, 'work'), path.resolve(home), path.join(path.resolve(home), 'work'));
  if (parents.some(parent => contains(resolved, parent))) return undefined; // equals or contains a known parent
  const under = root => strictlyInside(root, resolved);
  const allowed = (homeReal && under(homeReal) && depth >= 3) || under('/workspace') || under(real('/workspace')) || under('/tmp') || under(real('/tmp'));
  if (!allowed) return undefined;
  return { directory: resolved, roots: [resolved], implicit: true };
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

// Secret-path reasons for one scanned segment: file arguments (docker --env-file values excepted),
// redirect targets, and quoted literals in heredoc/herestring bodies (python - <<EOF open('.env')).
// The docker --env-file exemption is part of the full-auto profile only (envFiles:false elsewhere).
function segmentSecretReasons(segment, text, { envFiles = true, skip } = {}) {
  const reasons = [];
  const skipped = envFiles ? dockerEnvFileValues(segment.words) : new Set();
  for (const k of skip ?? []) skipped.add(k);
  const secret = secretWords(segment.words, skipped)[0];
  if (secret !== undefined) reasons.push(`${text}: names secret-looking path ${JSON.stringify(secret)}`);
  for (const redirect of segment.redirects) {
    if (redirect.file && isSecretPath(redirect.target)) reasons.push(`${text}: redirect to secret-looking path ${JSON.stringify(redirect.target)}`);
    const literal = (redirect.heredoc || redirect.herestring) ? secretLiterals(redirect.body)[0] : undefined;
    if (literal !== undefined) reasons.push(`${text}: input names secret-looking path ${JSON.stringify(literal)}`);
  }
  return reasons;
}

// Reasons a command reads, copies or writes a secret path, including sh -c/eval/heredoc-to-shell
// and ssh remote commands (empty: none). Bare words in patterns, filters and code do not count.
export function shellSecretReasons(command, { depth = 0, envFiles = true } = {}) {
  if (typeof command !== 'string') return ['command is not a string'];
  if (depth > 4) return ['commands nested too deeply to inspect'];
  const reasons = [], nested = [];
  for (const segment of scanShell(command).segments) {
    reasons.push(...segmentSecretReasons(segment, JSON.stringify(segment.text.slice(0, 160)), { envFiles }));
    nestedCommands(segment, nested, { remote: false });
  }
  for (const inner of nested) reasons.push(...shellSecretReasons(inner.command, { depth: depth + 1, envFiles }).map(why => `nested ${why}`));
  return [...new Set(reasons)];
}

// The operator's standing rule (0.3.2): under full-auto only, `ssh garage-server` (or user@garage-server,
// with only the plain options below) may read exactly /opt/wncscanner-docker/.env with cat, less,
// grep, stat or readlink. Everything else about the command is still checked: other secret paths,
// redirects, writes, deletes, pushes. The exempted read must be a plain segment of the ssh remote
// command itself (no sudo/wrappers, no nested sh -c, no command or process substitution anywhere
// in the remote command, no file redirects except to /dev/null) whose output goes to the caller or
// through a pipe of read-only text filters only.
export const GARAGE_HOST = 'garage-server';
export const GARAGE_ENV_FILE = '/opt/wncscanner-docker/.env';
const GARAGE_SSH_OPTIONS = new Set(['batchmode', 'connecttimeout', 'serveraliveinterval', 'serveralivecountmax', 'connectionattempts', 'loglevel']);
const GARAGE_SSH_FLAGS = new Set('46CnqTtvx'.split(''));
const GARAGE_READERS = new Set(['cat', 'less', 'grep', 'stat', 'readlink']);
const GARAGE_PIPE_FILTERS = new Set(['cat', 'less', 'grep', 'cut', 'head', 'tail', 'wc']);
const isGarageHost = host => typeof host === 'string' && (host === GARAGE_HOST || /^[A-Za-z0-9._-]+@garage-server$/.test(host));

// Parses `ssh [opts] host [command...]` (args: the words after ssh). plain: every option is one
// of the harmless ones above (`-o HostName=x`, `-F cfg`, `-J jump`, `-p` ... are not).
function sshInvocation(args) {
  const localCommands = [];
  let i = 0, plain = true;
  for (; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { i++; break; }
    if (!arg.startsWith('-')) break;
    for (let j = 1; j < arg.length; j++) {
      if (!SSH_ARG_OPTIONS.has(arg[j])) { if (!GARAGE_SSH_FLAGS.has(arg[j])) plain = false; continue; }
      const value = arg.slice(j + 1) || args[++i] || '';
      if (arg[j] === 'o' && /^(proxycommand|localcommand|permitlocalcommand|knownhostscommand)/i.test(value)) localCommands.push(value);
      if (!(arg[j] === 'o' && GARAGE_SSH_OPTIONS.has(value.split(/[=\s]/)[0].toLowerCase())) && arg[j] !== 'l') plain = false;
      break;
    }
  }
  return { host: args[i], hostIndex: i, remote: args.slice(i + 1), localCommands, plain };
}

// `ssh [opts] host <remote words>` as the segment's command word: indexes of the remote words,
// which are re-checked as the remote command.
function sshRemoteWords(words) {
  if (!/(^|\/)ssh$/.test(words[0] ?? '')) return undefined;
  const inv = sshInvocation(words.slice(1));
  const skip = new Set();
  for (let k = inv.hostIndex + 2; k < words.length; k++) skip.add(k);
  return skip;
}

const quietRedirects = segment => segment.redirects.every(redirect => !redirect.heredoc && !redirect.herestring
  && (!redirect.file || (redirect.target === '/dev/null' && redirect.op !== '<')));

// Shell grammar that can carry a redirect or pipe in another segment ({ ... } > f, while ...; done | x).
const SHELL_KEYWORD = /^(\{|\}|!|do|done|then|fi|else|elif|if|while|until|for|select|case|esac|function|coproc|\[\[|\]\])$|\(\)$/;
// The command as a whole is simple enough to judge the exemption: one line, no command or process
// substitution, no shell keywords/grouping, and no file redirect anywhere (`exec > f; ...`)
// except to /dev/null.
const garageSimple = (command, segments) => !/[\r\n]/.test(command) && !/\$\(|`|<\(|>\(/.test(command)
  && segments.every(segment => !segment.sub && !SHELL_KEYWORD.test(segment.words[0] ?? '') && quietRedirects(segment));
// less is a reader/filter only without options or +commands (--log=, -o, +!cmd).
const plainLess = words => words[0] !== 'less' || words.slice(1).every(word => !word.startsWith('-') && !word.startsWith('+'));
// Segment n's output reaches the caller's terminal only: any pipe after it runs read-only text
// filters only (redirects are checked for the whole command by garageSimple).
function outputStaysQuiet(segments, n) {
  for (let m = n + 1; m < segments.length && ['|', '|&'].includes(segments[m].prevSep); m++) {
    const next = segments[m];
    if (!GARAGE_PIPE_FILTERS.has(next.words[0]) || !plainLess(next.words)) return false;
  }
  return true;
}

// Local side: segment n is `ssh [plain opts] garage-server ...` whose output stays on the terminal
// (not redirected to a file, not piped into anything but text filters, not inside a substitution).
function garageSshSegment(command, segments, n) {
  const words = segments[n].words;
  if (!garageSimple(command, segments) || !/(^|\/)ssh$/.test(words[0] ?? '')) return false;
  const inv = sshInvocation(words.slice(1));
  return inv.plain && isGarageHost(inv.host) && outputStaysQuiet(segments, n);
}

// Word indexes (per segment) of the exempted .env read in a garage-server remote command.
export function garageEnvReads(command, segments = scanShell(command).segments) {
  const skips = new Map();
  if (!garageSimple(command, segments)) return skips;
  segments.forEach((segment, n) => {
    const { words } = segment;
    if (!GARAGE_READERS.has(words[0]) || !plainLess(words) || !outputStaysQuiet(segments, n)) return;
    const indexes = new Set();
    words.forEach((word, k) => { if (k > 0 && word === GARAGE_ENV_FILE) indexes.add(k); });
    if (indexes.size) skips.set(n, indexes);
  });
  return skips;
}

// The wncscanner-stack unit may be read (systemctl cat/status/show/is-*, or a read of its unit
// file), never changed without asking, on any host: systemctl/service verbs other than the read
// ones (also for globs/braces naming wncscanner), redirects into the unit file or drop-in, and
// any other command naming the unit file.
const GARAGE_UNIT_WORD = word => /^wncscanner-stack(\.service|@|$)/.test(word) || (/wncscanner/.test(word) && /[*?[{]/.test(word));
const GARAGE_UNIT_FILE = /(^|\/)wncscanner-stack(@[^/]*)?\.service(\.d)?(\/|$)/;
const UNIT_READ_VERBS = new Set(['cat', 'status', 'show', 'is-active', 'is-enabled', 'is-failed', 'list-units', 'list-unit-files', 'list-dependencies']);
const UNIT_CHANGE_VERBS = new Set(['start', 'stop', 'restart', 'reload', 'try-restart', 'reload-or-restart', 'try-reload-or-restart', 'condrestart',
  'force-reload', 'enable', 'disable', 'reenable', 'preset', 'mask', 'unmask', 'link', 'revert', 'edit', 'kill', 'clean', 'freeze', 'thaw',
  'set-property', 'isolate', 'daemon-reload', 'daemon-reexec', 'add-wants', 'add-requires', 'bind', 'mount-image', 'reset-failed']);
// systemctl options whose value is a separate word (`-n 50`, `-o cat`, `-p show`).
const SYSTEMCTL_VALUE_SHORT = /^-[a-zA-Z]*[tpPsnoHM]$/;
const SYSTEMCTL_VALUE_LONG = new Set(['--type', '--property', '--signal', '--lines', '--output', '--host', '--machine', '--kill-whom', '--kill-value',
  '--state', '--job-mode', '--root', '--image', '--what', '--timestamp', '--check-inhibitors', '--when', '--preset-mode', '--boot-loader-menu', '--boot-loader-entry', '--reboot-argument', '--drop-in', '--message']);
const UNIT_FILE_READERS = new Set(['cat', 'less', 'grep', 'stat', 'readlink', 'ls', 'head', 'tail', 'wc', 'sha256sum', 'md5sum', 'journalctl']);
function systemctlVerb(args) {
  for (let k = 0; k < args.length; k++) {
    const arg = args[k];
    if (arg === '--') return args[k + 1];
    if (SYSTEMCTL_VALUE_SHORT.test(arg) || SYSTEMCTL_VALUE_LONG.has(arg)) { k++; continue; }
    if (!arg.startsWith('-')) return arg;
  }
  return undefined;
}
// skip: word indexes checked elsewhere (an ssh segment's remote words).
export function garageUnitDanger(segment, skip = sshRemoteWords(segment.words) ?? new Set()) {
  const { words, redirects } = segment;
  for (const redirect of redirects) {
    if (redirect.file && redirect.op !== '<' && GARAGE_UNIT_FILE.test(redirect.target ?? '')) return `redirect ${redirect.op} writes the wncscanner-stack unit`;
  }
  const s = words.findIndex(word => /(^|\/)(systemctl|service)$/.test(word));
  if (s >= 0 && !skip.has(s)) {
    const args = words.slice(s + 1);
    if (args.some(word => GARAGE_UNIT_WORD(word) || GARAGE_UNIT_FILE.test(word))) {
      if (/service$/.test(words[s]) && !/(^|\/)systemctl$/.test(words[s])) {
        const verb = args.find(word => !word.startsWith('-') && !GARAGE_UNIT_WORD(word) && !GARAGE_UNIT_FILE.test(word));
        if (verb !== 'status') return `service ${verb} changes the wncscanner-stack service`;
      } else {
        const verb = systemctlVerb(args);
        if (!UNIT_READ_VERBS.has(verb) || args.some(word => UNIT_CHANGE_VERBS.has(word)))
          return `systemctl ${verb} changes the wncscanner-stack service`;
        // A read only when systemctl is the command (behind sudo/simple wrappers at most), so
        // `cp u .../wncscanner-stack.service systemctl status x` still gets the file check below.
        if (words.slice(0, s).every(word => WRAPPER_COMMAND.test(word) || word.startsWith('-') || /^\d+(\.\d+)?[smhd]?$/.test(word))) return undefined;
      }
    }
  }
  if (words.some((word, k) => !skip.has(k) && GARAGE_UNIT_FILE.test(word)) && !UNIT_FILE_READERS.has(words[0]))
    return `${words[0]} on the wncscanner-stack unit file is not a read`;
  return undefined;
}

// 0.3.3: privilege escalation and system service changes always ask under full-auto (local or over
// ssh). systemctl/service reads (status, cat, show, is-*, list-*) stay allowed.
const SUDO_WORD = /^(?:.*\/)?(sudo|doas|su|pkexec|run0)$/;
export function serviceDanger(words) {
  for (let k = 0; k < words.length; k++) {
    const word = words[k];
    if (SUDO_WORD.test(word) && (k === 0 || /^(?:.*\/)?(env|timeout|nice|nohup|command|exec|time|xargs)$/.test(words[k - 1]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k - 1])))
      return `${word} runs commands as another user`;
    if (/(^|\/)systemctl$/.test(word)) {
      const args = words.slice(k + 1);
      const verb = systemctlVerb(args);
      if (verb !== undefined && (!UNIT_READ_VERBS.has(verb) || args.some(arg => UNIT_CHANGE_VERBS.has(arg)))) return `systemctl ${verb} changes a system service`;
    }
    if (/(^|\/)service$/.test(word) && k === 0 && words.length >= 3) {
      const verb = words.slice(k + 1).filter(arg => !arg.startsWith('-'))[1];
      if (verb && verb !== 'status') return `service ${verb} changes a system service`;
    }
  }
  return undefined;
}

// 0.3.3: projects with no_push_deploy (yrdsale Phase 1: never push or deploy) ask for every push,
// publish or deploy command. Lexical: a deploy run from a script file is not seen.
const DEPLOY_TOOLS = /^(?:.*\/)?(railway|fly|flyctl|vercel|netlify|heroku|eas|firebase|wrangler|serverless|sls|cdk|terraform|pulumi|kubectl|helm|ansible-playbook|twine|gcloud|aws|az|doctl)$/;
const DEPLOY_SUBS = new Set(['up', 'deploy', 'redeploy', 'publish', 'release', 'submit', 'update', 'apply', 'build', 'push', 'promote', 'upload', 'install', 'upgrade', 'rollout', 'create', 'sync']);
export function pushDeployDanger(words) {
  for (let k = 0; k < words.length; k++) {
    const word = words[k];
    if (isGitWord(word) && git(words, k).sub === 'push') return 'git push (pushes are off for this project)';
    if (/(^|\/)gh$/.test(word)) {
      const [group, sub] = words.slice(k + 1).filter(arg => !arg.startsWith('-'));
      if ((group === 'pr' && ['create', 'merge'].includes(sub)) || (group === 'release' && sub === 'create') || (group === 'repo' && ['sync', 'create'].includes(sub)) || (group === 'workflow' && sub === 'run'))
        return `gh ${group} ${sub} publishes (pushes are off for this project)`;
    }
    if (/(^|\/)(docker|podman)$/.test(word) && words[k + 1] === 'push') return `${word} push publishes an image`;
    if (/(^|\/)(npm|pnpm|yarn)$/.test(word) && words[k + 1] === 'publish') return `${word} publish`;
    if (DEPLOY_TOOLS.test(word)) {
      const sub = words.slice(k + 1).find(arg => !arg.startsWith('-'));
      if (/(^|\/)vercel$/.test(word) || (sub && DEPLOY_SUBS.has(sub))) return `${word} ${sub ?? ''} deploys (deploys are off for this project)`.replace('  ', ' ');
    }
    if (/(^|\/)(scp|rsync)$/.test(word) && words.slice(k + 1).some(arg => /^[^/.~\-][^/\s]*:/.test(arg))) return `${word} to a remote host (deploys are off for this project)`;
  }
  return undefined;
}

// 0.3.3: literal shell variables. `B=/abs/dir; ... > $B/x` and `for L in a b; do ... $L ...` are
// expanded before path checks. Values with $, backticks, globs or quotes stay unknown.
const LITERAL_VALUE = /^[A-Za-z0-9_./@%+=:,~-]*$/;
export function literalVariables(segments) {
  const vars = new Map();
  for (const segment of segments) {
    if (segment.sub) continue;
    const words = segment.words[0] === 'export' ? segment.words.slice(1) : segment.words;
    if (words.length && words.every(word => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word))) {
      for (const word of words) {
        const name = word.slice(0, word.indexOf('=')), value = word.slice(name.length + 1);
        vars.set(name, LITERAL_VALUE.test(value) && !value.startsWith('~') ? [value] : null);
      }
    } else if (words[0] === 'for' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(words[1] ?? '') && words[2] === 'in') {
      const values = words.slice(3);
      vars.set(words[1], values.length && values.every(value => LITERAL_VALUE.test(value) && !value.includes('/') && value !== '..') ? values : null);
    } else if (words[0] === 'read' || words[0] === 'select') {
      for (const word of words.slice(1)) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(word)) vars.set(word, null);
    }
  }
  return vars;
}
// Every expansion of target (array), or undefined when a variable is unknown.
export function expandVariables(target, vars) {
  if (typeof target !== 'string' || !/\$/.test(target)) return [target];
  let results = [''];
  const re = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)|\$/g;
  let last = 0, match;
  while ((match = re.exec(target))) {
    const literal = target.slice(last, match.index);
    const name = match[1] ?? match[2];
    const values = name ? vars.get(name) : undefined;
    if (!values) return undefined;
    results = results.flatMap(prefix => values.map(value => prefix + literal + value));
    last = re.lastIndex;
  }
  return results.map(prefix => prefix + target.slice(last));
}
// A write target whose unknown variables all sit after a literal directory that lies strictly inside
// the project (`.review/run-$TS/out.txt`, `$D/x` with D a project path) is judged by that directory.
function literalWritePrefix(target) {
  const index = target.indexOf('$');
  if (index < 0) return target;
  const head = target.slice(0, index);
  const slash = head.lastIndexOf('/');
  if (slash <= 0) return undefined;
  const dir = head.slice(0, slash);
  return dir.split('/').includes('..') && !/^(\.\.\/)+[^.]/.test(dir + '/') ? undefined : `${dir}/__write_entry__`;
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

// amendOk: skip `commit --amend` (the guard verified every amend in the command is on an unpushed
// feature-branch HEAD; see checkFullAutoAmends in shell-guard.mjs).
function gitHistoryDanger(words, { amendOk = false } = {}) {
  for (let k = 0; k < words.length; k++) {
    if (!isGitWord(words[k])) continue;
    const { sub, rest } = git(words, k);
    const args = []; for (const arg of rest) { if (arg === '--') break; args.push(arg); }
    const long = (arg, name, min = 3) => arg.startsWith('--') && arg.length >= min && name.startsWith(arg.slice(2).split('=')[0]);
    if (['rebase', 'filter-branch', 'filter-repo', 'prune', 'replace'].includes(sub)) return `git ${sub} rewrites history`;
    if (sub === 'commit' && !amendOk && args.some(arg => /^--am/.test(arg))) return 'git commit --amend rewrites history';
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
  if (typeof target === 'string' && !ctx.remote) {
    const home = ctx.home, cwd = ctx.cwds?.size === 1 ? [...ctx.cwds][0] : undefined;
    let t = target.replace(/^\$\{?TMPDIR\}?(?=\/|$)/, process.env.TMPDIR || '/tmp');
    if (home) t = t.replace(/^\$\{?HOME\}?(?=\/|$)/, home);
    if (cwd) t = t.replace(/^\$\{?PWD\}?(?=\/|$)/, cwd);
    if (t !== target) return deleteTargetDanger(t, ctx);
    if (/\{[^{}]*[,.][^{}]*\}/.test(target) && !/[$`]/.test(target)) { const all = braceExpand(target); if (all.length > 1) { for (const one of all) { const why = deleteTargetDanger(one, ctx); if (why) return why; } return undefined; } }
  }
  if (!target || /[$`{}]/.test(target) || /^~[^/]/.test(target)) return `delete target ${JSON.stringify(target)} is not a literal path`;
  const home = ctx.remote ? REMOTE_HOME : ctx.home;
  const expanded = target === '~' || target.startsWith('~/') ? (home ? path.join(home, target.slice(2)) : undefined) : target;
  if (!expanded) return `delete target ${JSON.stringify(target)} has no known home`;
  const resolve = (cwd, t) => ctx.remote ? path.resolve(cwd, t) : physicalResolve(cwd, t);
  const candidates = path.isAbsolute(expanded) ? [resolve('/', expanded)] : ctx.cwds ? [...ctx.cwds].map(cwd => resolve(cwd, expanded)) : undefined;
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
// garageOk: segment is a local ssh to garage-server whose output stays quiet (garageSshSegment).
function nestedCommands(segment, nested, ctx, { garageOk = false } = {}) {
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
      const inv = sshInvocation(words.slice(k + 1));
      for (const value of inv.localCommands) reasons.push(`ssh -o ${value} runs a local command`);
      // garage: the garage-server read exemption applies to this remote command (ssh from the
      // local machine as the segment's command word, plain options only).
      const garage = garageOk && !ctx.remote && k === 0;
      if (inv.remote.length) nested.push({ command: inv.remote.join(' '), remote: true, garage });
      else if (input) nested.push({ command: input.body ?? '', remote: true, garage });
      break;
    }
  }
  return reasons;
}

// 0.3.3: per-segment working directories. After a top-level `cd T`, the segments joined to it by
// `&&` (and the subshells opened by `&& (`) run only if the cd succeeded, so they run in T alone; a
// `;`, newline, `||` or `&` at the top level ends that, and later segments get the union (as before).
function segmentCwdList(segments, base, home, roots = []) {
  const union = segmentCwds(segments, base, home);
  const list = [];
  let exact, moved = false, exactKeep = false;
  for (const segment of segments) {
    const sep = segment.prevSep === '(' && segment.outer !== undefined ? segment.outer : segment.prevSep;
    const top = !segment.sub || segment.prevSep === '(';
    // 0.4.0 (4.1): a literal existing cd target inside the project roots stays exact across `;` and newlines.
    const keep = exactKeep && [';', '\n'].includes(sep);
    if (exact && top && !keep && ['', ';', '\n', '||', '&', '|', '|&', ')'].includes(sep) && !(sep === '' && segment.sub)) exact = undefined;
    list.push(exact ?? union);
    const { words } = segment;
    if (!segment.sub && words[0] === 'cd' && words.length <= 2 && union) {
      const from = exact ?? (!moved && base ? new Set([base]) : undefined);
      moved = true;
      const target = from && from.size === 1 ? cdTarget([...from][0], words, home) : undefined;
      exact = target ? new Set([realish(target)]) : undefined;
      exactKeep = Boolean(target && roots.some(root => contains(root, target)) && /^[A-Za-z0-9_./@%+=:,~-]+$/.test(words[1] ?? '') && (() => { try { fs.accessSync(target, fs.constants.X_OK); return fs.statSync(target).isDirectory(); } catch { return false; } })()); // M6: only a cd that will succeed (existing, enterable directory) stays exact
    } else if (words.some(word => ['cd', 'pushd', 'popd', 'chdir'].includes(word))) { exact = undefined; exactKeep = false; moved = true; }
  }
  return list;
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
      for (const cwd of cwds) { const target = cdTarget(cwd, words, home); if (!target) return undefined; next.add(realish(target)); }
      cwds = next;
    }
  }
  return cwds;
}

// ---- 0.4.0 hard-deny classification on parsed words (never on reason text) ----
// A redirect onto an existing directory fails; it truncates nothing.
const isDirectory = target => { try { return path.isAbsolute(target) && fs.statSync(target).isDirectory(); } catch { return false; } };
const resetHeadOnly = words => {
  const k = words.findIndex(isGitWord); if (k < 0) return false;
  const { sub, rest } = git(words, k);
  return sub === 'reset' && rest.every(arg => /^(-q|--quiet|--hard|HEAD|@)$/.test(arg));
};
const READERS = /(^|\/)(cat|tac|less|more|head|tail|grep|egrep|fgrep|rg|strings|base64|xxd|od|hexdump|nl|sed|awk|jq|bat|source|\.|cp|scp|nc|openssl)$/;
const CRED_PATH = /(^|\/)(\.netrc|\.npmrc|\.pypirc|\.pgpass|\.git-credentials|hosts\.yml|\.docker\/config\.json|\.kube\/config|\.[A-Za-z0-9_]*_history|\.histfile|shadow|gshadow|[^/]*\.p12|[^/]*\.pfx|service-account[^/]*\.json|[^/]*\.tfstate(\.backup)?|token[^/]*\.txt|environ)$/;
const SECRET_GLOB = /(^|\/)[.\[]?[\[\]?*]*\.?\[?e[\]?*]|(^|\/)\.[^/]*[*?[]/;
const isDynamic = word => /[$`]/.test(word);
// The next segment only counts or tests matches (`printenv | grep -c X`, `| wc -l`): nothing is printed.
const quietPipe = (segments, n) => { const next = segments[n + 1]; return next?.prevSep === '|' && (/^(wc)$/.test(next.words[0]) && next.words.some(w => /^-[a-zA-Z]*[clmw]/.test(w)) || (/^grep$/.test(next.words[0]) && next.words.some(w => /^-[a-zA-Z]*[cq]/.test(w)))) && !segments[n + 2]?.prevSep?.startsWith('|'); };
// ---- 0.4.0 (r40c): second-review hard-deny additions ----
// Environment variable names that hold secrets (GH_PAT, OPENAI_API_KEY, DATABASE_URL); TOKEN_COUNT, KEYBOARD, total_tokens are not.
const SECRET_TOKEN = /^(KEY|APIKEY|TOKEN|SECRET|SECRETS|PASSWORD|PASSWD|PASS|PAT|CREDENTIAL|CREDENTIALS|DSN|WEBHOOK|COOKIE|PRIVATE|PASSPHRASE|BEARER)$/;
const NOT_SECRET_NEXT = /^(COUNT|COUNTS|LIMIT|LIMITS|LEN|LENGTH|USAGE|BUDGET|SIZE|MAX|MIN|TYPE|NAME|ID|FILE|PATH|DIR|URL_BASE)$/;
export function secretVarName(name) {
  const up = String(name).toUpperCase();
  if (/(^|_)(DATABASE|DB|REDIS|MONGO[A-Z]*|POSTGRES[A-Z]*|PG|AMQP|SENTRY|MYSQL)_(URL|URI|DSN)$/.test(up)) return true;
  if (/^[A-Z0-9]*(APIKEY|TOKEN|SECRET|PASSWORD)$/.test(up)) return true;
  const toks = up.split('_').filter(Boolean);
  return toks.some((t, i) => SECRET_TOKEN.test(t) && !NOT_SECRET_NEXT.test(toks[i + 1] ?? ''));
}
// Names expanded in a word: [{ name, indirect }]. `${!X}` / `${!X*}` are indirect (undeterminable).
const expansions = word => [...String(word).matchAll(/\$(?:\{(!?)([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*))/g)].map(m => ({ name: m[2] ?? m[3], indirect: m[1] === '!' }));
const secretExpansion = word => expansions(word).some(e => e.indirect || secretVarName(e.name));
// Brace expansion (bash order), capped.
export function braceExpand(word, limit = 64) {
  const m = /^(.*?)\{([^{}]*)\}(.*)$/s.exec(word);
  if (!m) return [word];
  let items;
  const range = /^(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])$/.exec(m[2]);
  if (m[2].includes(',')) items = m[2].split(',');
  else if (range) { const num = /\d/.test(range[1]); const a = num ? +range[1] : range[1].charCodeAt(0), b = num ? +range[2] : range[2].charCodeAt(0); items = []; for (let i = a; a <= b ? i <= b : i >= b; i += a <= b ? 1 : -1) { items.push(num ? String(i) : String.fromCharCode(i)); if (items.length > limit) break; } }
  else return [word];
  const out = [];
  for (const item of items) for (const rest of braceExpand(m[1] + item + m[3], limit)) { out.push(rest); if (out.length > limit) return out; }
  return out;
}
// Names a glob could match that are secrets (dotglob off: a pattern not starting with `.` misses dotfiles).
const SECRET_CANDIDATES = ['.env', '.env.local', '.env.production', '.netrc', '.npmrc', '.pgpass', '.git-credentials', '.bash_history', 'id_rsa', 'id_ed25519', 'server.key', 'cert.pem', 'credentials', 'credentials.json', 'secrets.yaml', 'secret.txt', 'prod.env', 'auth.json', 'service-account.json', 'terraform.tfstate', 'environ', 'token.txt'];
export function globCanMatchSecret(pattern) {
  if (/[$`]/.test(pattern)) return true;
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '[') { const j = pattern.indexOf(']', i + 2); if (j < 0) { re += '\\['; continue; } re += '[' + pattern.slice(i + 1, j).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']'; i = j; }
    else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  let rx; try { rx = new RegExp('^' + re + '$'); } catch { return true; }
  return SECRET_CANDIDATES.some(name => (!name.startsWith('.') || pattern.startsWith('.') || pattern.startsWith('[')) && rx.test(name));
}
const secretFile = word => braceExpand(word).some(w => isSecretPath(w) || CRED_PATH.test(w) || /(^|\/)proc\/[^/]+\/environ$/.test(w) || (/[*?[]/.test(w.split('/').at(-1)) && globCanMatchSecret(w.split('/').at(-1))));
const TMP_ROOTS = ['/tmp', '/var/tmp', '/dev/shm'];
const PRINT_CALL = /\b(print|pprint|dumps?|console\.(log|error|info|dir)|puts|pp|p\s|say|warn|die|write|stringify|inspect|repr|str\(|items|keys|values|to_h|to_a|each|Dumper|log)\b/;
const SHELL_OUT = /\b(os\.(system|popen|exec\w*|spawn\w*)|subprocess|commands\.getoutput|pty\.spawn|child_process|execSync|execFileSync|execFile|spawnSync|spawn|exec|system|IO\.popen|Open3|Kernel\.(exec|system|spawn)|shell_exec|passthru|proc_open|popen|Deno\.(run|Command)|Bun\.(spawn|\$))\b|`|%x[({[]|qx[({[/]|\$`/;
const FILE_CHANGE = /\b(shutil\.(rmtree|move|copy\w*)|rmtree|remove_tree|os\.(remove|unlink|rmdir|removedirs|rename|replace|truncate)|unlinkSync|unlink|rmSync|rmdirSync|rmdir|rimraf|rm_rf|rm_r|rm_f|FileUtils\.\w+|File\.(delete|unlink|write|rename|truncate)|Dir\.(delete|rmdir|unlink)|renameSync|rename|writeFileSync|writeFile|appendFileSync|copyFileSync|cpSync|copyFile|write_text|write_bytes|truncate|Deno\.(remove|writeTextFile|writeFile|rename))\b|open\s*\([^)]*,\s*['"][wax+]|\.rm\s*\(|\bfsp?\.(rm|rmdir|unlink)\b/;
const stringLiterals = code => [...code.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`|q[qw]?\(([^)]*)\)/g)].map(m => m[1] ?? m[2] ?? m[3] ?? m[4]);
const INTERPRETER = /(^|\/)(python[0-9.]*|pypy[0-9.]*|node|nodejs|ruby|perl|php|deno|bun|Rscript|lua|osascript|tclsh|irb)$/;
// Inline program text of an interpreter invocation, or undefined when it runs a script file.
function interpreterCode(head, args, segment) {
  const base = head.split('/').at(-1);
  const input = segment.redirects.find(r => r.heredoc || r.herestring);
  const flag = /^python|^pypy/.test(base) ? /^-[a-zA-Z]*c$/ : /^php/.test(base) ? /^-r$/ : /^(deno)$/.test(base) ? /^eval$/ : /^-[a-zA-Z]*[eEp]$|^--(eval|print)$/;
  const i = args.findIndex(a => flag.test(a) || (/^--(eval|print)=/.test(a)));
  if (i >= 0) return /=/.test(args[i]) && args[i].startsWith('--') ? args[i].slice(args[i].indexOf('=') + 1) : (args[i + 1] ?? '');
  const positional = args.filter(a => !a.startsWith('-'));
  if ((positional.length === 0 || positional[0] === '-') && input) return input.body ?? '';
  if ((positional.length === 0 || positional[0] === '-') && segment.prevSep === '|') return null; // program piped in: undeterminable
  return undefined;
}
// Physical resolution: `..` after a symlinked directory goes to the link target's parent, as the kernel does.
function physicalResolve(base, rel) {
  let cur = path.isAbsolute(rel) ? '/' : base;
  for (const part of rel.split('/')) {
    if (!part || part === '.') continue;
    cur = part === '..' ? path.dirname(realish(cur)) : path.join(cur, part);
  }
  return cur;
}
function writeTargetDanger(target, ctx, what) {
  if (SAFE_WRITE_TARGET.test(target) || target === '-') return undefined;
  const why = deleteTargetDanger(target, ctx);
  return why && !/is git metadata/.test(why) ? `${what}: ${why.replace('delete target', 'write target')}` : undefined;
}
// Files a command overwrites in place: cp/mv/install/ln -f destinations, tee (not -a), sed -i / perl -i files, dd of=.
function overwriteTargets(head, args) {
  const base = head.split('/').at(-1);
  const pos = []; let endOpts = false, targetDir;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!endOpts && a === '--') { endOpts = true; continue; }
    if (!endOpts && /^-t$|^--target-directory$/.test(a) && /^(cp|mv|install|ln)$/.test(base)) { targetDir = args[++i]; continue; }
    if (!endOpts && /^--target-directory=/.test(a)) { targetDir = a.split('=').slice(1).join('='); continue; }
    if (!endOpts && /^(-S|--suffix|-m|--mode|-o|--owner|-g|--group)$/.test(a) && /^(cp|mv|install|ln)$/.test(base)) { i++; continue; }
    if (!endOpts && a.startsWith('-') && a !== '-') continue;
    pos.push(a);
  }
  const intoDir = (dir, sources) => { let isDir = false; try { isDir = fs.statSync(dir).isDirectory(); } catch {} return isDir || dir.endsWith('/') ? sources.map(s => path.join(dir, path.basename(s))) : [dir]; };
  if (/^(cp|mv|install)$/.test(base) || (base === 'ln' && args.some(a => /^-[a-zA-Z]*f|^--force$/.test(a)))) {
    if (targetDir !== undefined) return pos.map(s => path.join(targetDir, path.basename(s)));
    if (pos.length < 2) return [];
    return intoDir(pos.at(-1), pos.slice(0, -1));
  }
  if (base === 'tee') return args.some(a => /^-[a-zA-Z]*a|^--append$/.test(a)) ? [] : pos;
  if (base === 'sed' && args.some(a => /^-[a-zA-Z]*i|^--in-place/.test(a))) {
    const hasScript = args.some(a => /^(-e|-f|--expression|--file)/.test(a));
    const files = []; let skip = false;
    for (let i = 0; i < args.length; i++) { const a = args[i]; if (skip) { skip = false; continue; } if (/^(-e|-f|--expression|--file|-l)$/.test(a)) { skip = true; continue; } if (a.startsWith('-')) continue; files.push(a); }
    return hasScript ? files : files.slice(1);
  }
  if (base === 'perl' && args.some(a => /^-[a-zA-Z]*i/.test(a))) {
    const files = []; let skip = false;
    for (const a of args) { if (skip) { skip = false; continue; } if (/^-[a-zA-Z]*[eE]$/.test(a)) { skip = true; continue; } if (a.startsWith('-')) continue; files.push(a); }
    return args.some(a => /^-[a-zA-Z]*[eE]$/.test(a)) ? files : files.slice(1);
  }
  if (base === 'dd') return args.filter(a => a.startsWith('of=')).map(a => a.slice(3));
  return [];
}
const GIT_BUILTINS = new Set('add am annotate apply archive bisect blame branch bundle cat-file check-attr check-ignore check-mailmap check-ref-format checkout checkout-index cherry cherry-pick citool clean clone column commit commit-graph commit-tree config count-objects credential describe diff diff-files diff-index diff-tree difftool fast-export fast-import fetch fetch-pack filter-branch fmt-merge-msg for-each-ref for-each-repo format-patch fsck gc get-tar-commit-id grep gui hash-object help hook index-pack init instaweb interpret-trailers log ls-files ls-remote ls-tree mailinfo mailsplit maintenance merge merge-base merge-file merge-index merge-tree mergetool mktag mktree multi-pack-index mv name-rev notes pack-objects pack-refs patch-id prune prune-packed pull push range-diff read-tree rebase reflog remote repack replace request-pull rerere reset restore rev-list rev-parse revert rm send-email send-pack shortlog show show-branch show-index show-ref sparse-checkout stash status stripspace submodule switch symbolic-ref tag unpack-file unpack-objects update-index update-ref update-server-info var verify-commit verify-pack verify-tag version whatchanged worktree write-tree lfs filter-repo'.split(' '));
const GIT_CONFIG_DANGER = /^(alias\.|remote\..*\.(push|mirror)$|push\.default$|pull\.rebase$|branch\..*\.rebase$|include\.path$|includeif\.)/i;
function gitAlias(sub, cwd) {
  if (!cwd || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sub)) return undefined;
  try { return execFileSync('git', ['config', '--get', `alias.${sub}`], { cwd, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined; } catch { return undefined; }
}
const insideRoots = (target, ctx) => { if (!target || /[$`{}*?]/.test(target)) return false; const t = target === '~' || target.startsWith('~/') ? path.join(ctx.home ?? '/nonexistent', target.slice(2)) : target; const abs = path.isAbsolute(t) ? t : ctx.cwds?.size === 1 ? path.resolve([...ctx.cwds][0], t) : undefined; if (!abs) return false; const real = realish(abs); return ctx.roots.some(r => contains(r, abs) && contains(r, real)); };

function hardExtras2(segment, segments, n, ctx, { head, args, cmd, READ }) {
  const out = [];
  const { words, redirects } = segment;
  const base = head.split('/').at(-1);
  const quiet = quietPipe(segments, n);
  const inner = (command, label) => { for (const e of ctx.inner?.(command) ?? []) out.push([e.rule, `${label}: ${e.reason}`]); };
  // -- secrets: environment prints
  for (let k = 0; k < words.length; k++) {
    if (words[k] !== 'env' && !/\/env$/.test(words[k])) continue;
    if (words.slice(0, k).some(w => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) && !/^(sudo|time|nice|nohup|command|exec|-\S*)$/.test(w))) break;
    let rest = false;
    for (let i = k + 1; i < words.length; i++) {
      const a = words[i];
      if (/^(-u|--unset|-C|--chdir)$/.test(a)) { i++; continue; }
      if (/^(-S|--split-string)$/.test(a)) { inner(words[i + 1] ?? '', 'env -S'); rest = true; break; }
      if (/^--split-string=|^-S./.test(a)) { inner(a.replace(/^--split-string=|^-S/, ''), 'env -S'); rest = true; break; }
      if (a.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) continue;
      rest = true; break;
    }
    if (!rest && !quiet) out.push(['secret', 'env prints the environment']);
    break;
  }
  if (/^(export|declare|typeset|local|readonly)$/.test(base)) {
    const names = args.filter(a => !a.startsWith('-') && !a.includes('='));
    if (!quiet && (!args.length && base !== 'local' || (args.length && args.every(a => a.startsWith('-')) && args.some(a => /p|x/.test(a))))) out.push(['secret', `${base} ${args.join(' ')} prints the environment`.replace('  ', ' ')]);
    if (args.some(a => /^-[a-zA-Z]*p/.test(a)) && names.some(secretVarName)) out.push(['secret', `${base} -p prints a secret variable`]);
  }
  if (base === 'printenv' && args.some(a => !a.startsWith('-') && secretVarName(a)) && !quiet) out.push(['secret', 'printenv prints a secret variable']);
  if (/^(echo|printf|print|cat|tee|logger|wall)$/.test(base) && args.some(secretExpansion) && !quiet) out.push(['secret', `${base} prints a secret environment variable`]);
  for (const r of redirects) if (r.herestring && secretExpansion(r.body ?? '')) out.push(['secret', 'here-string expands a secret environment variable']);
  if (/^(curl|wget|nc|ncat|http|https|xh)$/.test(base)) {
    const valueOpts = /^(-H|--header|-u|--user|--oauth2-bearer|-A|--user-agent|-b|--cookie|-o|--output|-x|--proxy|-K|--config|--cacert|--cert|--key|-e|--referer|--max-time|-m|-w|--write-out|--connect-timeout|-X|--request|--retry|--resolve)$/;
    for (let i = 0; i < args.length; i++) { const a = args[i]; if (valueOpts.test(a)) { i++; continue; } if (/^-/.test(a) && !/^(-d|--data\S*|-F|--form\S*|--json|--url|--url-query)$/.test(a) && !/^(-d|-F)./.test(a)) continue; const v = /^(-d|--data\S*|-F|--form\S*|--json|--url|--url-query)$/.test(a) ? args[++i] ?? '' : a; if (secretExpansion(v)) { out.push(['secret', `${base} sends a secret environment variable in the URL or body`]); break; } }
  }
  if (/^(gh)$/.test(base) && args[0] === 'auth' && args[1] === 'status' && args.some(a => /^(-t|--show-token)$/.test(a))) out.push(['secret', 'gh auth status --show-token prints a token']);
  for (let k = 0; k < words.length; k++) if (isGitWord(words[k])) { const { sub, rest } = git(words, k); if (/^credential(-store|-cache)?$/.test(sub ?? '') && rest.some(a => /^(fill|get)$/.test(a))) out.push(['secret', 'git credential fill prints stored credentials']); }
  for (const r of redirects) if (!r.heredoc && !r.herestring && r.file && /^(\d*<|<>)$/.test(r.op) && r.target && (/(^|\/)proc\/[^/*?]+\/environ$/.test(r.target) || secretFile(r.target))) out.push(['secret', `input redirect reads ${JSON.stringify(r.target)}`]);
  // Brace-expanded reader arguments (`cat .en{v,}`).
  if (READ) for (const a of args) if (/\{/.test(a) && braceExpand(a).length > 1 && secretFile(a)) out.push(['secret', `reader argument ${JSON.stringify(a)} expands to a secret file`]);
  // -- secrets: uploads
  if (base === 'curl' || base === 'wget') {
    const refs = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      let opt = a, val;
      const eq = a.startsWith('--') ? a.indexOf('=') : -1;
      if (eq > 0) { opt = a.slice(0, eq); val = a.slice(eq + 1); }
      else if (/^-[dFT]./.test(a)) { opt = a.slice(0, 2); val = a.slice(2); }
      if (!/^(-d|--data|--data-binary|--data-ascii|--data-urlencode|--json|-F|--form|-T|--upload-file|--post-file|--body-file)$/.test(opt)) continue;
      if (val === undefined) val = args[++i] ?? '';
      if (/^(-T|--upload-file|--post-file|--body-file)$/.test(opt)) refs.push(val);
      else if (/^(-F|--form)$/.test(opt)) { const m = /^[^=]*=([@<])([^;]*)/.exec(val); if (m) refs.push(m[2].replace(/^"|"$/g, '')); }
      else if (opt === '--data-urlencode') { const m = /^([^=@]*)@(.*)$/.exec(val); if (m) refs.push(m[2]); }
      else if (val.startsWith('@')) refs.push(val.slice(1));
    }
    for (const ref of refs) {
      if (ref === '-' || ref === '/dev/stdin') { const r = redirects.find(r => r.file && /^0?<$/.test(r.op)); if (r && (isDynamic(r.target ?? '') || secretFile(r.target ?? ''))) out.push(['secret', `${base} uploads stdin from ${JSON.stringify(r.target)}`]); continue; }
      if (isDynamic(ref)) out.push(['secret', `${base} uploads a file whose name is not literal`]);
      else if (secretFile(ref)) out.push(['secret', `${base} uploads secret file ${JSON.stringify(ref)}`]);
    }
  }
  // -- deletes/writes through a symlink created in this command (ln -s TARGET LINK; ...; rm -rf LINK/x / cd LINK)
  const changes = /^(rm|rmdir|unlink|find|rsync|mv|truncate|cp|tee|sed|dd|install|shred|perl|ln)$/.test(base) || redirects.some(r => r.file && /^(\d*>|>\||&>|<>|\d*>>|&>>)$/.test(r.op));
  if (changes) {
    for (const s of segments.slice(0, n)) {
      const k = s.words.findIndex(w => /(^|\/)ln$/.test(w) || /(^|\/)cp$/.test(w));
      if (k < 0 || !s.words.slice(k + 1).some(w => /^-[a-zA-Z]*s|^--symbolic/.test(w))) continue;
      const pos = s.words.slice(k + 1).filter(w => !w.startsWith('-'));
      const linkTarget = pos[0];
      const linkDir = pos.length > 1 && !pos.at(-1).endsWith('/') ? path.dirname(pos.at(-1)) : '.';
      const resolvedTarget = linkTarget && !path.isAbsolute(linkTarget) && !linkTarget.startsWith('~') ? path.join(linkDir, linkTarget) : linkTarget;
      if (!insideRoots(resolvedTarget, ctx)) { out.push(['delete', `writes or deletes after creating symlink ${JSON.stringify(pos.at(-1) ?? linkTarget)} to ${JSON.stringify(linkTarget)} outside the project`]); break; }
    }
  }
  // -- interpreters: inline code that shells out, deletes/overwrites files or prints secrets
  if (INTERPRETER.test(head)) {
    const code = interpreterCode(head, args, segment);
    if (code === null) out.push(['delete', `${base} runs a program piped from another command`]);
    else if (typeof code === 'string' && code) {
      const lits = stringLiterals(code);
      if (SHELL_OUT.test(code)) {
        if (!lits.length) out.push(['delete', `${base} code runs a shell command that is not literal`]);
        for (const lit of new Set([...lits, lits.join(' ')])) if (/\s|^(git|rm|sh|bash)$/.test(lit)) inner(lit.replace(/\\(.)/g, '$1'), `${base} shell-out`);
        if (/\b(git|gh)\b/.test(code) && /\bpush\b/.test(code) && !/\bpush\b/.test(lits.join(' '))) out.push(['history', `${base} code builds a git push it does not spell out`]);
      }
      if (FILE_CHANGE.test(code)) {
        const paths = lits.filter(l => /^(\/|~|\.\.?\/)|\//.test(l) && !/\s/.test(l) && !/^(https?|wss?):/.test(l));
        if (!lits.length) out.push(['delete', `${base} code deletes or writes a path that is not literal`]);
        for (const p of paths) { const why = deleteTargetDanger(p, ctx); if (why && !/is git metadata/.test(why)) out.push(['delete', `${base} code: ${why}`]); }
      }
      const envNames = [...code.matchAll(/environ(?:\.get)?\s*[\[(]\s*['"](\w+)|getenv\s*\(\s*['"](\w+)|process\.env(?:\.(\w+)|\[\s*['"](\w+))|ENV\s*(?:\[\s*['"]|\.fetch\(\s*['"])(\w+)|\$ENV\{\s*['"]?(\w+)/g)].map(m => m.slice(1).find(Boolean));
      const bareEnv = /os\.environ(?!\s*(\.get|\[|\.copy|\.setdefault|\.pop|\.update))|process\.env(?!\s*[.\[])|\bENV\b(?!\s*[\[.])|%ENV|Deno\.env\.toObject/.test(code);
      if (PRINT_CALL.test(code) && (bareEnv || envNames.some(secretVarName))) out.push(['secret', `${base} code prints the environment or a secret variable`]);
      if (/open\s*\(|readFile|read_text|File\.read|IO\.read|slurp/.test(code) && lits.some(l => secretFile(l))) out.push(['secret', `${base} code reads a secret file`]);
    }
  }
  if (base === 'alias') for (const a of args) { const eq = a.indexOf('='); if (eq > 0) inner(a.slice(eq + 1), `alias ${a.slice(0, eq)}`); }
  // -- git environment, globals and configuration
  for (const w of words.slice(0, Math.max(cmd, 0)).concat(base === 'export' ? args : [])) {
    const m = /^(GIT_[A-Z_]+)=(.*)$/.exec(w); if (!m) continue;
    if (/^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|NAMESPACE)$/.test(m[1]) && !insideRoots(m[2], ctx)) out.push(['delete', `${m[1]} points git outside the project`]);
    if (/^GIT_(CONFIG\w*|EXEC_PATH|ALTERNATE_OBJECT_DIRECTORIES)$/.test(m[1])) out.push(['history', `${m[1]} injects git configuration`]);
  }
  for (let k = 0; k < words.length; k++) {
    if (!isGitWord(words[k])) continue;
    const g = words.slice(k + 1);
    for (let i = 0; i < g.length && g[i].startsWith('-'); i++) {
      const a = g[i];
      const m = /^--(work-tree|git-dir)(?:=(.*))?$/.exec(a);
      if (m) { const v = m[2] ?? g[++i]; if (!insideRoots(v, ctx)) out.push(['delete', `git --${m[1]} outside the project`]); continue; }
      if (a === '-c' && GIT_CONFIG_DANGER.test((g[i + 1] ?? '').split('=')[0])) out.push(['history', `git -c ${(g[i + 1] ?? '').split('=')[0]} can turn a push into a force push or rewrite`]);
      if (/^(-c|-C|--namespace|--exec-path|--super-prefix|--config-env)$/.test(a)) { if (a === '--config-env') out.push(['history', 'git --config-env injects configuration']); i++; }
    }
    const { sub, rest } = git(words, k);
    if (sub === 'config') {
      const pos = rest.filter(a => !a.startsWith('-'));
      const reading = rest.some(a => /^(--get|--get-all|--get-regexp|-l|--list|--unset|--unset-all|--show-origin)$/.test(a));
      if (!reading && pos.length >= 2 && GIT_CONFIG_DANGER.test(pos[0])) out.push(['history', `git config ${pos[0]} can turn a push into a force push or rewrite`]);
    }
    if (sub && !sub.startsWith('-') && !isDynamic(sub) && !GIT_BUILTINS.has(sub)) {
      const cwd = ctx.cwds?.size === 1 ? [...ctx.cwds][0] : undefined;
      const value = gitAlias(sub, cwd);
      if (value) inner(value.startsWith('!') ? value.slice(1) : `git ${value} ${rest.join(' ')}`, `git alias ${sub}`);
    }
  }
  // -- overwrites outside the project or /tmp (cp/mv/install/ln -f dest, tee, sed -i, perl -i, dd of=)
  if (ctx.cwds || words.some(w => path.isAbsolute(w) || w.startsWith('~'))) {
    const c = { ...ctx, cwds: ctx.cwds ?? new Set(['/nonexistent-cwd']) };
    for (const t of overwriteTargets(head, args)) { const why = writeTargetDanger(t, c, `${base} overwrites`); if (why) out.push(['delete', why]); }
  }
  return out;
}

function hardExtras(segment, segments, n, ctx, vars) {
  const out = [];
  const { words } = segment;
  const cmd = words.findIndex(word => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) && !['sudo', 'env', 'time', 'nice', 'nohup', 'command', 'timeout'].includes(word));
  const head = cmd >= 0 ? words[cmd] : '';
  const args = cmd >= 0 ? words.slice(cmd + 1) : [];
  // Undeterminable command word (G=git; $G ...), eval, xargs feeding dangerous commands.
  if (isDynamic(head)) out.push(['history', `command word ${JSON.stringify(head)} is not literal`]);
  if (/(^|\/)xargs$/.test(head) && args.some(arg => /(^|\/)(git|rm|rmdir|unlink|cat|sh|bash|curl|mv|shred|truncate)$/.test(arg))) out.push(['delete', 'xargs feeds input to a push, delete, shell or reader']);
  if (head === 'eval' && args.some(isDynamic)) out.push(['delete', 'eval of a non-literal string']);
  // Git: fail closed on pushes with dynamic args, aliases, remote.*.push config, more rewrites.
  for (let k = 0; k < words.length; k++) {
    if (!isGitWord(words[k])) continue;
    const { sub, rest, chdirs } = git(words, k);
    const globals = words.slice(k + 1, words.indexOf(sub, k + 1));
    if (globals.some(arg => /^alias\./i.test(arg) || /^pull\.rebase=(true|i|m|interactive|merges)/i.test(arg))) out.push(['history', 'git -c alias/pull.rebase can rewrite history']);
    if (sub === undefined || isDynamic(sub)) { if (sub !== undefined) out.push(['history', 'git subcommand is not literal']); continue; }
    const has = re => rest.some(arg => re.test(arg));
    if (sub === 'push' && rest.some(isDynamic)) out.push(['history', 'git push with non-literal arguments']);
    if (sub === 'push' && has(/^(-[a-zA-Z]*[fd]|--force|--force-with-lease|--delete|--prune|--mirror)/)) out.push(['history', 'git push force/delete']);
    if (sub === 'push' && rest.some(arg => /^\+|^:/.test(arg))) out.push(['history', 'git push forced or deleting refspec']);
    if (sub === 'config' && has(/^remote\..*\.push$|^alias\./i)) out.push(['history', 'git config redefines push or aliases']);
    if (sub === 'pull' && has(/^(-r|--rebase(=(true|i|interactive|merges))?)$/)) out.push(['history', 'git pull --rebase rewrites history']);
    if (sub === 'reset' && has(/^--keep$/)) out.push(['history', 'git reset --keep rewrites the branch']);
    if (sub === 'reset' && has(/^--hard$/) && !resetHeadOnly(words.slice(k))) out.push(['history', 'git reset --hard to another commit']);
    if (sub === 'update-ref') out.push(['history', 'git update-ref rewrites a ref']);
    if (sub === 'branch' && has(/^(-[a-zA-Z]*[fD]|--force|--delete)$/)) out.push(['history', 'git branch -f/-D rewrites or deletes a branch']);
    if ((sub === 'checkout' || sub === 'switch') && has(/^(-B|-C|--force-create)$/)) out.push(['history', `git ${sub} -B resets a branch`]);
    if (sub === 'send-pack' && has(/^(--force|-f|--mirror)$/)) out.push(['history', 'git send-pack --force']);
    if (sub === 'clean' && (chdirs.length || rest.some(isDynamic))) out.push(['delete', 'git clean in another repository']);
    if (['rebase', 'filter-branch', 'filter-repo', 'replace'].includes(sub)) out.push(['history', `git ${sub} rewrites history`]);
  }
  if (/(^|\/)gh$/.test(head) && args[0] === 'api' && /\/git\/refs/.test(args.join(' ')) && (args.some(a => /^(-XDELETE|DELETE|--method=DELETE)$/i.test(a)) || args.some(a => /^force=true$/.test(a)))) out.push(['history', 'gh api deletes or force-updates a ref']);
  // Deletes the old checks miss.
  if (/(^|\/)(mv|truncate|tar)$/.test(head) && ctx.cwds) {
    const targets = head === 'truncate' ? args.filter(a => !a.startsWith('-') && !/^\d+[KMG]?$/.test(a)) : head === 'mv' ? args.filter(a => !a.startsWith('-')).slice(0, -1) : args.some(a => /^--remove-files/.test(a)) ? args.filter(a => !a.startsWith('-')) : [];
    for (const t of targets) { const why = deleteTargetDanger(t, ctx); if (why) out.push(['delete', `${head}: ${why}`]); }
  }
  if (false) {
    const code = args.join(' ');
    if (/rmtree|unlink|rmdir|os\.remove|\bremove\(|truncate/.test(code)) {
      const lits = [...code.matchAll(/['"]((?:\/|~)[^'"]*)['"]|q\(([^)]*)\)/g)].map(m => m[1] ?? m[2]);
      if (!lits.length) out.push(['delete', 'interpreter deletes an undeterminable path']);
      for (const lit of lits) { const why = deleteTargetDanger(lit, ctx); if (why) out.push(['delete', `interpreter delete: ${why}`]); }
    }
    if (/environ|open\([^)]*["'][^"']*(\.env|netrc|npmrc|\.e["']\s*\+)/.test(code)) out.push(['secret', 'interpreter reads environment or secrets']);
  }
  // Symlink created earlier in this command, then deleted through.
  if (/(^|\/)(rm|rmdir|unlink|find|rsync)$/.test(head)) {
    const links = segments.slice(0, n).filter(s => s.words[0] === 'ln' && s.words.some(w => /^-[a-zA-Z]*s/.test(w))).map(s => s.words.filter(w => !w.startsWith('-')).at(-1));
    if (links.some(link => args.some(a => a === link || a.startsWith(link.replace(/\/$/, '') + '/')))) out.push(['delete', 'deletes through a symlink created in the same command']);
  }
  if (head === 'rm' && args.some(a => /(^|\/)\.git\/?$/.test(a))) out.push(['history', 'rm of .git destroys history']);
  // Secrets.
  if (/(^|\/)(printenv|set)$/.test(head) && !args.some(a => !a.startsWith('-') && !/=/.test(a)) && !(head === 'export' && args.length) && !(head === 'set' && args.length) && !(head === 'declare' && args.length) && !quietPipe(segments, n)) out.push(['secret', `${head} prints the environment`]);
  if (/(^|\/)gh$/.test(head) && args[0] === 'auth' && args[1] === 'token') out.push(['secret', 'gh auth token prints a token']);
  if (/(^|\/)curl$/.test(head) && args.some((a, i) => /^@/.test(a) && /^(-d|--data[a-z-]*|-F|--form|-T|--upload-file)$/.test(args[i - 1] ?? '') && (isDynamic(a) || isSecretPath(a.slice(1)) || CRED_PATH.test(a.slice(1)) || /[*?[]/.test(a)) || /^(-d|-F|--data[a-z-]*|--form)=?.*=?@(\.env|.*[$`*?])/.test(a) || /^[A-Za-z0-9_]+=@/.test(a) && (isSecretPath(a.split('@')[1]) || isDynamic(a)))) out.push(['secret', 'curl uploads a secret file']);
  if (/(^|\/)(tar|zip|scp|rsync)$/.test(head)) {
    const pos = args.filter(a => !a.startsWith('-'));
    const whole = pos.some(a => a === '.' || a === './' || a === '*' || (ctx.roots.some(r => r === a)));
    const remoteOrOut = head === 'tar' ? args.some((a, i) => a === '-' || /f$/.test(a) && args[i + 1] === '-') || segment.redirects.some(r => r.file) || segments[n + 1]?.prevSep === '|' : pos.some(a => /^[^/.~][^/]*:/.test(a));
    if (whole && (remoteOrOut || head === 'tar' || head === 'zip')) out.push(['secret', `${head} copies the whole repository (including secrets) out`]);
  }
  const READ = READERS.test(head);
  // The first positional of awk/sed/jq/grep/rg is a program or pattern, not a file.
  const programIndex = /(^|\/)(awk|sed|jq|grep|egrep|fgrep|rg)$/.test(head) && !args.some(a => /^(-e|-f|--regexp|--file)$/.test(a)) ? args.findIndex(a => !a.startsWith('-')) : -1;
  for (const [i, a] of args.entries()) {
    if (a.startsWith('-') && !a.includes('/')) continue;
    if (i === programIndex) continue;
    if (/(^|\/)proc\/[^/]+\/environ$/.test(a) || /(^|\/)proc\/[*?]/.test(a)) out.push(['secret', 'reads a process environment']);
    else if (CRED_PATH.test(a) && (READ || /(^|\/)(curl|tar|zip|rsync)$/.test(head))) out.push(['secret', `reads credential file ${JSON.stringify(a)}`]);
    else if (READ && isDynamic(a) && !/^\$\{?(HOME|PWD|TMPDIR)\}?(\/|$)/.test(a)) out.push(['secret', `reader argument ${JSON.stringify(a)} is not literal`]);
    else if (READ && /[*?[]/.test(a) && globCanMatchSecret(a.split('/').at(-1))) out.push(['secret', `reader glob ${JSON.stringify(a)} can match a secret file`]);
  }
  // A reader whose file arguments come from a command substitution (`cat \`ls | grep env\``) is undeterminable.
  if (READ && segments[n + 1]?.sub === true && segments[n + 1]?.prevSep === '`') out.push(['secret', `${head} reads files named by a command substitution`]);
  // find -exec/-execdir/-ok <reader> over a name glob that can match a secret (`find . -name ".e*" -exec cat {} +`).
  if (/(^|\/)find$/.test(head)) {
    const execs = args.flatMap((a, i) => /^-(exec|execdir|ok|okdir)$/.test(a) ? [args[i + 1]] : []);
    const names = args.flatMap((a, i) => /^-(i?name|i?path|regex)$/.test(a) ? [args[i + 1] ?? ''] : []);
    if (execs.some(x => x && (READERS.test(x) || SHELL_WORD.test(x))) && (!names.length || names.some(nm => isDynamic(nm) || isSecretPath(nm.replace(/[*?]/g, 'x')) || /^(\.|\[\.)/.test(nm) || /\.env|\.pem$|\.key$|netrc|credentials|secret/i.test(nm))))
      out.push(['secret', 'find -exec reader over files that can be secrets']);
  }
  // Input piped into a shell, or `sh` reading a pipe.
  if (SHELL_WORD.test(head) && segment.prevSep === '|' && !args.some(a => /^-[a-zA-Z]*c/.test(a))) out.push(['delete', `${head} runs piped input`]);
  // Garage exemption is a single file: a recursive grep over the directory reads .env too.
  if (words.some(w => /^-[a-zA-Z]*[rR]/.test(w)) && words.some(w => /^\/opt\/wncscanner-docker\/?$/.test(w))) out.push(['secret', 'recursive read over /opt/wncscanner-docker']);
  out.push(...hardExtras2(segment, segments, n, ctx, { head, args, cmd, READ }));
  return out;
}

// Structured hard-deny check: [{ rule: 'history'|'delete'|'secret', reason }] (empty: allow).
export function hardDenyCheck(command, cwd, project, opts = {}) {
  const hard = [];
  fullAutoShellCheck(command, cwd, project, { ...opts, hard });
  const seen = new Set();
  return hard.filter(entry => { const k = entry.rule + entry.reason; if (seen.has(k)) return false; seen.add(k); return true; });
}

// Returns the reasons a full-auto project must still ask for a raw command (empty: allow).
// cwd: the shell's working directory; project: from fullAutoProjectFor. paths:false skips the
// path-dependent checks (used to re-check parsed native resources in the evaluate hook).
// amendOk only applies to top-level local segments; amends in sh -c/eval/heredoc/ssh bodies still ask.
// garage: this is the remote command of a local `ssh garage-server` (set by the recursion only).
export function fullAutoShellCheck(command, cwd, project, { home = process.env.HOME || os.homedir(), remote = false, paths = true, depth = 0, amendOk = false, garage = false, hard } = {}) {
  const H = (rule, reason) => { if (hard) hard.push({ rule, reason }); return reason; };
  if (typeof command !== 'string') return [H('secret', 'command is not a string')];
  if (depth > 4) return [H('delete', 'commands nested too deeply to inspect')];
  const { segments } = scanShell(command);
  const reasons = [];
  const ctx = { cwds: remote ? new Set([REMOTE_HOME]) : segmentCwds(segments, cwd, home), roots: [...(project?.roots ?? []), ...(hard ? TMP_ROOTS : [])], home, remote };
  ctx.inner = inner => { const sub = []; const cw = ctx.cwds?.size === 1 ? [...ctx.cwds][0] : undefined; fullAutoShellCheck(inner, remote ? undefined : cw, project, { home, remote, paths, depth: depth + 1, hard: sub }); return sub; };
  if (remote) { const tracked = segmentCwds(segments, REMOTE_HOME, REMOTE_HOME); ctx.cwds = tracked; ctx.home = REMOTE_HOME; }
  const nested = [];
  const envReads = garage && remote && depth > 0 ? garageEnvReads(command, segments) : new Map();
  const vars = literalVariables(segments);
  const cwdList = remote ? undefined : segmentCwdList(segments, cwd, home, project?.roots ?? []);
  const baseCtx = ctx;
  segments.forEach((segment, n) => {
    const ctx = cwdList ? { ...baseCtx, cwds: cwdList[n] } : baseCtx;
    const { words, redirects } = segment;
    const text = JSON.stringify(segment.text.slice(0, 160));
    const push = gitPushDanger(words);
    if (push) reasons.push(H('history', `${text}: ${push}`));
    const history = gitHistoryDanger(words, { amendOk: amendOk && depth === 0 && !remote });
    if (history) { const r = `${text}: ${history}`; reasons.push(r); if (hard && !resetHeadOnly(words)) H('history', r); }
    if (hard) for (const [rule, why] of hardExtras(segment, segments, n, ctx, vars)) reasons.push(H(rule, `${text}: ${why}`));
    const disk = words.find(word => (DISK_COMMANDS.test(word) && !(hard && word === 'dd')) || BLOCK_DEVICE.test(word) || (/^of=\/dev\//.test(word) && !/^of=\/dev\/(null|stdout|stderr|fd\/\d+)$/.test(word)));
    if (disk) reasons.push(H('delete', `${text}: ${disk} writes disks or devices`));
    const garageOk = !remote && depth === 0 && garageSshSegment(command, segments, n);
    const skip = new Set([...(envReads.get(n) ?? []), ...(garageOk ? sshRemoteWords(words) : [])]);
    reasons.push(...segmentSecretReasons(segment, text, { skip }).map(r => H('secret', r)));
    if (!remote) reasons.push(...segmentProtectedReasons(segment, words.map(word => { const values = /\$/.test(word) ? expandVariables(word, vars) : undefined; return values?.length === 1 ? values[0] : word; }), ctx, text).map(r => H('secret', r)));
    const unit = garageUnitDanger(segment);
    if (unit) reasons.push(`${text}: ${unit}`);
    for (const redirect of redirects) {
      if (!redirect.file) continue;
      if (BLOCK_DEVICE.test(redirect.target ?? '')) reasons.push(H('delete', `${text}: redirect writes device ${redirect.target}`));
      if (paths && !remote && (['>', '>|', '&>', '<>'].includes(redirect.op) || /^\d+>$/.test(redirect.op))) {
        const raw = redirect.target ?? '';
        const expanded = expandVariables(raw, vars);
        const targets = expanded ?? [literalWritePrefix(raw) ?? raw];
        for (const target of targets) {
          if (SAFE_WRITE_TARGET.test(target)) continue;
          // Relative targets that resolve into /tmp (cd /tmp/x && cmd > out) are scratch writes too.
          if (!path.isAbsolute(target) && !target.includes('$') && !target.startsWith('~') && ctx.cwds?.size && [...ctx.cwds].every(cwd => SAFE_WRITE_TARGET.test(path.resolve(cwd, target)))) continue;
          const why = deleteTargetDanger(target, ctx);
          if (why && !/is git metadata/.test(why)) { const r = `${text}: truncating redirect ${redirect.op} ${JSON.stringify(raw)} (${why.replace('/__write_entry__', '/…')})`; reasons.push(r); if (hard && /resolves outside|reaches \/|globs over|not a literal|no known home/.test(why) && !isDirectory(target)) H('delete', r); }
        }
      }
    }
    const service = serviceDanger(words);
    if (service) reasons.push(`${text}: ${service}`);
    // Delete targets with literal variables (B=/x; rm -rf $B) are judged by their expansion.
    const expandedWords = words.map(word => { const values = /\$/.test(word) ? expandVariables(word, vars) : undefined; return values?.length === 1 ? values[0] : word; });
    if (paths) reasons.push(...[...rmDanger(expandedWords, ctx), ...findDanger(expandedWords, ctx), ...rsyncDanger(words, ctx, nested)].map(why => /is git metadata/.test(why) ? H('history', `${text}: ${why}`) : H('delete', `${text}: ${why}`)));
    reasons.push(...nestedCommands(segment, nested, ctx, { garageOk }).map(why => H('delete', `${text}: ${why}`)));
  });
  for (const inner of nested) {
    const sub = hard ? [] : undefined;
    const innerCwd = inner.remote ? undefined : ctx.cwds && ctx.cwds.size === 1 ? [...ctx.cwds][0] : undefined;
    const innerReasons = innerCwd || inner.remote || !paths
      ? fullAutoShellCheck(inner.command, innerCwd, project, { home, remote: inner.remote || remote, paths, depth: depth + 1, garage: inner.garage === true, hard: sub })
      : fullAutoShellCheck(inner.command, undefined, project, { home, remote, paths, depth: depth + 1, hard: sub });
    reasons.push(...innerReasons.map(why => `${inner.remote ? 'remote ' : 'nested '}${why}`));
    if (hard) hard.push(...sub.map(entry => ({ ...entry, reason: `${inner.remote ? 'remote ' : 'nested '}${entry.reason}` })));
  }
  return [...new Set(reasons)];
}

// 0.4.0 auto-approve: of the full-auto reasons, only these classes deny; everything else is allowed.
// Returns [{ rule, reason }].
export const HARD_DENY_RULES = {
  history: 'force push / history rewrite',
  delete: 'delete outside the project roots or /tmp',
  secret: 'secret read or exfiltration (incl. protected harness/browser-profile paths)',
};
export function hardDenyReasons(reasons) {
  const out = [];
  for (const reason of reasons ?? []) {
    if (typeof reason !== 'string') continue;
    if (/truncating redirect/.test(reason)) continue;
    if (/git push --force|git push \+|rewrites or deletes remote refs|git rebase rewrites|filter-branch|filter-repo|force-with-lease|--mirror/.test(reason)) { out.push({ rule: 'history', reason }); continue; }
    if (/commit --amend/.test(reason)) { out.push({ rule: 'history', reason }); continue; }
    if (/writes disks or devices|redirect writes device/.test(reason)) { out.push({ rule: 'delete', reason }); continue; }
    if (/git reset --hard/.test(reason)) {
      const seg = reason.match(/^(?:nested |remote )*"((?:[^"\\]|\\.)*)"/)?.[1] ?? '';
      if (/reset\s+(?:-q\s+)?--hard(?:\s+(?:-q|HEAD|@))*\s*$/.test(seg)) continue;
      out.push({ rule: 'history', reason }); continue;
    }
    if (/resolves outside the project|reaches \/, a top-level|--no-preserve-root|globs over directories/.test(reason)) { out.push({ rule: 'delete', reason }); continue; }
    if (/secret|credential|protected path|harness\/agent-profile location|browser profile|browser user-data|private key|token/i.test(reason)) { out.push({ rule: 'secret', reason }); continue; }
  }
  return out;
}
export function hardDenyMessage(hard, command) {
  const rules = [...new Set(hard.map(entry => HARD_DENY_RULES[entry.rule]))].join(', ');
  return `HARD DENY (harness auto-approve policy; rule: ${rules}): ${hard.map(entry => entry.reason).join('; ')}. `
    + `This is not an approval request and will not be asked. Do not retry variants of this command. Record a resumable blocker with the exact command ${JSON.stringify(String(command ?? '').slice(0, 400))} and continue with other work.`;
}

// Calls inspected by the guard and found safe under full-auto, keyed by session + tool call.
const VERIFIED = new Map();
const TTL_MS = 120_000;
const key = (sessionID, callID) => `${sessionID}\u0000${callID}`;

// amendOk: the call's amends were verified (feature branch, HEAD on no remote-tracking branch).
export function rememberFullAuto(event, { amendOk = false } = {}) {
  if (!event?.sessionID || !event?.id) return;
  const now = Date.now();
  for (const [k, entry] of VERIFIED) if (entry.expires <= now) VERIFIED.delete(k);
  VERIFIED.set(key(event.sessionID, event.id), { expires: now + TTL_MS, amendOk });
}

// evaluate-hook half: shell asks for a verified call become allow unless a parsed resource is
// still dangerous on its own (secret paths, pushes, history rewrites, disks). Never touches deny.
export function downgradeFullAutoShell(event, project) {
  const entry = VERIFIED.get(key(event.sessionID, event.source?.id));
  if (!entry || entry.expires <= Date.now() || !Array.isArray(event.resources) || !event.resources.length) return false;
  for (const resource of event.resources) {
    if (typeof resource !== 'string') return false;
    if (hardDenyCheck(resource, undefined, project, { paths: false, amendOk: entry.amendOk }).length) return false;
  }
  event.effect = 'allow';
  return true;
}
