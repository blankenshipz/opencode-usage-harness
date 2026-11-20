// Raw-command shell guard for OpenCode 2.0.30.
//
// The native bash parser (core/src/shell/parse.ts) attaches a trailing redirect
// of a list or pipeline to the whole list, so `cd x && cat >> f <<EOF` yields the
// permission resource "cat", and a bare `> f` yields no command and therefore no
// permission check at all. This guard inspects the RAW command string before the
// shell tool runs and forces a native permission ask when:
//   - an unquoted redirect targets a secret-looking path,
//   - a bare redirect (no command word) would otherwise skip permission checks,
//   - a compound command's redirect-bearing segment matches a configured
//     shell ask/deny rule that the parser's resource would no longer match,
//   - any segment force-pushes, deletes or mirrors a remote ref (gitPushDanger).
//   - git add/commit targets main/master or an unresolvable branch/directory
//     (checkCommitBranches); verified feature-branch add/commit asks are downgraded.
// It is lexical and quoting-aware for common cases, not a shell interpreter.

import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fullAutoProjectFor, fullAutoShellCheck, rememberFullAuto, downgradeFullAutoShell, pathResourcesInside, PATH_ACTIONS, realish } from './full-auto.mjs';

const SECRET_BASENAME = [
  /^\.env$/i, /^\.env\..+/i, /credentials/i, /\.pem$/i, /\.key$/i, /^auth\.json$/i,
  /secret/i, /financial-policy/i, /external-write-grants/i,
];
// Committed env templates hold placeholders, not secrets (exact basename, any directory).
const ENV_TEMPLATE_BASENAME = /^\.env\.(example|sample|template)$/i;
const GUARD_MARKER = 'harnessShellGuard';
const PROBE_MARKER = 'harnessPermissionProbe';

export function isEnvTemplatePath(target) {
  if (typeof target !== 'string' || !target) return false;
  const base = target.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) ?? '';
  return ENV_TEMPLATE_BASENAME.test(base);
}

export function isSecretPath(target) {
  if (typeof target !== 'string' || !target) return false;
  const normalized = target.replaceAll('\\', '/');
  const parts = normalized.split('/').filter(Boolean);
  const base = parts.at(-1) ?? '';
  if (!isEnvTemplatePath(target) && SECRET_BASENAME.some(pattern => pattern.test(base))) return true;
  // Directory components named like secrets (e.g. secrets/token.txt, .env.d/x).
  return parts.slice(0, -1).some(part => /secret|credentials/i.test(part));
}

const isSpace = char => char === ' ' || char === '\t';
const WORD_END = new Set([' ', '\t', '\n', ';', '&', '|', '(', ')', '<', '>', '`']);

// Reads one shell word starting at i; returns { value (unquoted), end, quoted }.
function readWord(command, i) {
  let value = '', quoted = false;
  while (i < command.length) {
    const char = command[i];
    if (char === '\\') { if (command[i + 1] === '\n') { i += 2; continue; } value += command[i + 1] ?? ''; i += 2; quoted = true; continue; }
    if (char === "'") {
      const close = command.indexOf("'", i + 1);
      const stop = close < 0 ? command.length : close;
      value += command.slice(i + 1, stop); i = stop + 1; quoted = true; continue;
    }
    if (char === '$' && command[i + 1] === "'") {
      let j = i + 2;
      while (j < command.length && command[j] !== "'") { if (command[j] === '\\') j++; value += command[j] ?? ''; j++; }
      i = j + 1; quoted = true; continue;
    }
    if (char === '"') {
      let j = i + 1;
      while (j < command.length && command[j] !== '"') { if (command[j] === '\\' && '"\\$`\n'.includes(command[j + 1])) j++; value += command[j] ?? ''; j++; }
      i = j + 1; quoted = true; continue;
    }
    if (char === '$' && command[i + 1] === '(') {
      // Keep command substitutions inside the word; their contents are scanned separately.
      let depth = 0, j = i + 1;
      for (; j < command.length; j++) { if (command[j] === '(') depth++; else if (command[j] === ')' && --depth === 0) break; }
      value += command.slice(i, j + 1); i = j + 1; continue;
    }
    if (WORD_END.has(char)) break;
    value += char; i++;
  }
  return { value, end: i, quoted };
}

// Splits a raw command into segments with their own redirects. Heredoc bodies are
// excluded from segment text; quoted operators never split or redirect.
export function scanShell(command) {
  const segments = [];
  const heredocs = [];
  let current;
  // prevSep: the operator that started this segment ('' at the start); sub: inside (...), `...`,
  // <(...) or $(...), so a cd there does not change the outer shell's directory.
  let prevSep = '', depth = 0, backtick = false;
  const open = start => { current = { start, parts: [], words: [], redirects: [], prevSep, sub: depth > 0 || backtick }; };
  const close = () => {
    if (current && (current.words.length || current.redirects.length)) {
      segments.push({ text: current.parts.join(' ').trim(), words: current.words, redirects: current.redirects,
        hasCommand: current.words.some(word => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)), prevSep: current.prevSep, sub: current.sub });
    }
    current = undefined;
  };
  open(0);
  let i = 0, nested = false;
  while (i < command.length) {
    const char = command[i];
    if (isSpace(char)) { i++; continue; }
    if (char === '\n') {
      close();
      prevSep = '\n';
      i++;
      // Consume pending heredoc bodies after the line that introduced them.
      while (heredocs.length) {
        const { delimiter, stripTabs, redirect } = heredocs.shift();
        const body = [];
        for (;;) {
          if (i >= command.length) break;
          const lineEnd = command.indexOf('\n', i);
          const stop = lineEnd < 0 ? command.length : lineEnd;
          let line = command.slice(i, stop);
          if (stripTabs) line = line.replace(/^\t+/, '');
          i = stop + 1;
          if (line === delimiter) break;
          body.push(line);
        }
        // Kept for checks that must see what a shell or ssh reads from the heredoc (full-auto).
        if (redirect) redirect.body = body.join('\n');
      }
      open(i); continue;
    }
    if (char === '#' ) { const lineEnd = command.indexOf('\n', i); i = lineEnd < 0 ? command.length : lineEnd; continue; }
    if (char === ';' || char === '(' || char === ')' || char === '`') {
      close(); if (char !== ';') nested = true;
      if (char === '(') depth++; else if (char === ')') depth = Math.max(0, depth - 1); else if (char === '`') backtick = !backtick;
      prevSep = char; i++; open(i); continue;
    }
    if (char === '|' ) { close(); const op = command[i + 1] === '|' || command[i + 1] === '&' ? command.slice(i, i + 2) : '|'; prevSep = op; i += op.length; open(i); continue; }
    if (char === '&' && command[i + 1] !== '>') { close(); const op = command[i + 1] === '&' ? '&&' : '&'; prevSep = op; i += op.length; open(i); continue; }
    // Redirect operators, optionally prefixed by a file-descriptor number.
    const redirect = command.slice(i).match(/^(\d*)(&>>|&>|>>|>\||>&|<<<|<<-|<<|<>|<&|>|<)/);
    if (redirect) {
      const op = redirect[2];
      let j = i + redirect[0].length;
      if ((op === '>' || op === '<') && command[j] === '(') { // process substitution
        close(); nested = true; depth++; prevSep = `${op}(`; i = j + 1; open(i); continue;
      }
      while (j < command.length && isSpace(command[j])) j++;
      const word = readWord(command, j);
      const raw = command.slice(i, word.end);
      current.parts.push(raw);
      if (op === '<<' || op === '<<-') {
        const heredoc = { op, target: undefined, heredoc: true };
        heredocs.push({ delimiter: word.value, stripTabs: op === '<<-', redirect: heredoc });
        current.redirects.push(heredoc);
      } else if (op === '<<<') {
        current.redirects.push({ op, target: undefined, herestring: true, body: word.value });
      } else if ((op === '>&' || op === '<&') && /^(\d+-?|-)$/.test(word.value)) {
        current.redirects.push({ op, target: undefined, fd: word.value });
      } else {
        current.redirects.push({ op, target: word.value, file: true });
      }
      i = word.end; continue;
    }
    const word = readWord(command, i);
    if (word.end === i) { i++; continue; }
    current.parts.push(command.slice(i, word.end));
    current.words.push(word.value);
    // Scan command substitutions inside a word as nested commands.
    for (const match of command.slice(i, word.end).matchAll(/\$\((.*)\)/gs)) {
      nested = true;
      for (const inner of scanShell(match[1]).segments) segments.push({ ...inner, sub: true });
    }
    i = word.end;
  }
  close();
  return { segments, compound: segments.length > 1 || nested };
}

export function wildcardMatch(input, pattern) {
  const normalized = String(input).replaceAll('\\', '/');
  let escaped = String(pattern).replaceAll('\\', '/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  if (escaped.endsWith(' .*')) escaped = escaped.slice(0, -3) + '( .*)?';
  return new RegExp('^' + escaped + '$', 's').test(normalized);
}

// Last explicit `shell` rule wins, as in native Permission.evaluate. Catch-all
// action rules (`*`) are ignored: they are the default, not a configured ask.
export function explicitShellEffect(resource, rules = []) {
  const rule = rules.findLast(entry => entry && entry.action === 'shell' && wildcardMatch(resource, entry.resource));
  return rule ? { effect: rule.effect, pattern: rule.resource } : undefined;
}

// Git global options that take a separate argument word.
const GIT_GLOBAL_WITH_ARG = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix', '--exec-path', '--list-cmds']);
// Inline config that can turn a plain push into a forced/deleting one, or define an alias.
const RISKY_GIT_CONFIG = /^(alias\.|push\.|remote\..*\.(push|mirror|receivepack)(=|$))/i;
const GIT_CONFIG_ENV = /^GIT_CONFIG_(PARAMETERS|COUNT|KEY_\d+|VALUE_\d+|GLOBAL|SYSTEM)=/;
const CONFIG_READ = new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l', 'get', 'list']);

const PUSH_DANGER_LONG = ['force', 'force-with-lease', 'force-if-includes', 'mirror', 'delete', 'prune', 'receive-pack', 'exec'];

function pushArgsDanger(args) {
  let positional = false;
  for (const arg of args) {
    if (!positional && arg === '--') { positional = true; continue; }
    if (!positional && arg.startsWith('--')) {
      // git accepts unique abbreviations of long options (--del, --mir), so a prefix counts too.
      const name = arg.slice(2).split('=')[0];
      if (/^--(force|mirror|delete|prune|receive-pack|exec)/.test(arg) || (name && PUSH_DANGER_LONG.some(option => option.startsWith(name))))
        return `git push ${arg}`;
      continue;
    }
    if (!positional && /^-[^-]/.test(arg)) {
      // Short option cluster (-f, -uf, -fd); -o/--push-option values never start with '-'.
      if (/[fd]/.test(arg.slice(1).split(/[o]/)[0])) return `git push ${arg}`;
      continue;
    }
    if (arg.startsWith('+')) return `git push forced refspec ${arg}`;
    if (arg.startsWith(':')) return `git push deleting refspec ${arg}`;
  }
  return undefined;
}

// Returns why one git invocation (words after `git`) can force/delete a remote ref, else undefined.
function gitInvocationDanger(args) {
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) break;
    const [name, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const value = inline ?? (GIT_GLOBAL_WITH_ARG.has(name) ? args[++i] : undefined);
    if ((name === '-c' || name === '--config-env') && RISKY_GIT_CONFIG.test(value ?? ''))
      return `git ${name} ${value} can redefine what git push does`;
  }
  const sub = args[i];
  if (sub === 'push') return pushArgsDanger(args.slice(i + 1));
  if (sub === 'branch') {
    // -d/-D (also in clusters like -dr) and --delete or its abbreviations delete branches.
    for (const arg of args.slice(i + 1)) {
      if (arg === '--') break;
      if (/^-[a-zA-Z]*[dD]/.test(arg) && !arg.startsWith('--')) return `git branch ${arg} deletes a branch`;
      if (/^--d/.test(arg) && 'delete'.startsWith(arg.slice(2).split('=')[0])) return `git branch ${arg} deletes a branch`;
    }
  }
  if (sub === 'config') {
    const rest = args.slice(i + 1);
    if (!rest.some(word => CONFIG_READ.has(word)) && rest.some(word => RISKY_GIT_CONFIG.test(word)))
      return `git config ${rest.find(word => RISKY_GIT_CONFIG.test(word))} can redefine what git push does`;
  }
  return undefined;
}

// Force/delete/mirror pushes ask even under permissive and behind any wrapper (env, timeout,
// xargs, find -exec, check_receipt.py --, ...): every `git` word in a segment starts a candidate
// invocation. Conservative: `echo git push -f` asks too.
export function gitPushDanger(words) {
  if (!Array.isArray(words)) return undefined;
  const env = words.find(word => GIT_CONFIG_ENV.test(word));
  if (env && words.some(word => /(^|\/)git$/.test(word))) return `${env.split('=')[0]} can redefine what git does`;
  for (let k = 0; k < words.length; k++) {
    if (!/(^|\/)git$/.test(words[k])) continue;
    const reason = gitInvocationDanger(words.slice(k + 1));
    if (reason) return reason;
  }
  return undefined;
}

// ---- Branch-gated git add/commit (permissive policy) ----------------------------------------
// configure.py asks for plain `git add*`, `git stage*` and `git commit*` (BRANCH_GATED_PATTERNS).
// Static wildcards cannot see the branch, so the guard resolves it before the shell runs: when every
// add/commit in the command targets a repo whose current branch is not main/master, the native ask
// for those gated patterns is downgraded to allow (installShellGuard's evaluate hook). Anything the
// guard cannot resolve keeps asking, and if the guard is not loaded the static ask stands
// (fail closed). Amend, wrapped commits and every other configured ask are never downgraded.
export const BRANCH_GATED_PATTERNS = new Set(['git add*', 'git stage*', 'git commit*']);
export const PROTECTED_BRANCH = /^(main|master)$/i;
const COMMIT_SUBCOMMANDS = new Set(['commit', 'add', 'stage']);
// Global options that cannot change which repository or branch git acts on.
const BENIGN_GIT_GLOBAL = new Set(['--no-pager', '-P', '-p', '--paginate', '--no-optional-locks', '--literal-pathspecs',
  '--no-replace-objects', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--no-advice', '--no-lazy-fetch']);
// `-c key=value` that only affects identity, signing or output.
const SAFE_GIT_CONFIG = /^(user\.(name|email|signingkey)|author\.(name|email)|committer\.(name|email)|commit\.gpgsign|tag\.gpgsign|gpg\.format|core\.quotepath|core\.pager|color\.[a-z.]+|advice\.[a-z.]+|i18n\.commitencoding)(=|$)/i;
// Environment that only affects identity, prompts, editors or tracing (not GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, ...).
const SAFE_GIT_ENV = /^GIT_(TERMINAL_PROMPT|EDITOR|SEQUENCE_EDITOR|PAGER|AUTHOR_(NAME|EMAIL|DATE)|COMMITTER_(NAME|EMAIL|DATE)|TRACE[A-Z0-9_]*|OPTIONAL_LOCKS|ASKPASS|SSH_COMMAND|SSH|PROGRESS_DELAY|MERGE_AUTOEDIT)=/;
// Wrappers that run their argument in the same directory. env -C/--chdir and -S/--split-string are excluded below.
const SAME_DIR_WRAPPERS = new Set(['env', 'timeout', 'nice', 'nohup', 'command', 'time', 'stdbuf', 'setsid', 'xargs']);
const BRANCH_CHANGING = new Set(['checkout', 'switch', 'symbolic-ref', 'worktree', 'bisect', 'init', 'clone', 'rebase', 'update-ref']);
export const isGitWord = word => /(^|\/)git$/.test(word);
export const literalPath = value => typeof value === 'string' && value !== '' && !/[$`*?[\]{}]/.test(value) && !/^~[^/]/.test(value);

// Parses one git invocation (words after `git`): -C dirs, anything that makes the target repo unknown,
// the subcommand and its arguments.
export function parseGitInvocation(args) {
  const chdirs = [];
  let unsafe;
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) break;
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    const value = eq > 0 ? arg.slice(eq + 1) : GIT_GLOBAL_WITH_ARG.has(name) ? args[++i] : undefined;
    if (name === '-C') chdirs.push(value);
    else if (name === '-c') { if (!SAFE_GIT_CONFIG.test(value ?? '')) unsafe ??= `git -c ${value}`; }
    else if (!BENIGN_GIT_GLOBAL.has(name)) unsafe ??= `git ${name}`;
  }
  return { chdirs, unsafe, sub: args[i], rest: args.slice(i + 1) };
}

// True when the words before a git word only run it in the same directory (timeout 60, env A=1, nice -n 5, ...).
function sameDirPrefix(prefix) {
  let wrapped = false;
  for (const word of prefix) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
    if (SAME_DIR_WRAPPERS.has(word)) { wrapped = true; continue; }
    if (!wrapped) return false;
    if (/^-/.test(word)) { if (/^(-[A-Za-z]*[CS]|--ch|--sp|--dir|--work)/.test(word)) return false; continue; }
    if (/^\d+(\.\d+)?[smhd]?$/.test(word)) continue;
    return false;
  }
  return true;
}

export function cdTarget(cwd, words, home) {
  const args = words.slice(1).filter(word => !/^-[LPe@]+$/.test(word) && word !== '--');
  if (args.length > 1) return undefined;
  const target = args[0] ?? '~';
  if (target === '-' || !literalPath(target)) return undefined;
  if (target === '~' || target.startsWith('~/')) return home ? path.join(home, target.slice(2)) : undefined;
  if (process.env.CDPATH && !/^(\/|\.\/|\.\.\/|\.$|\.\.$)/.test(target)) return undefined;
  return path.resolve(cwd, target);
}

// Resolves where each git add/commit in a raw command runs. Returns
// { targets: [{ segment, cwd, gated, amend }], unknown } where `unknown` names the first reason the
// directory or branch cannot be trusted (then every target asks). Lexical and conservative.
export function gitCommitPlan(command, baseCwd, { home = process.env.HOME || os.homedir() } = {}) {
  const { segments } = scanShell(command);
  const targets = [];
  let unknown;
  const flag = reason => { unknown ??= reason; };
  for (const segment of segments) {
    const { words } = segment;
    for (let k = 0; k < words.length; k++) {
      if (/(^|\/)git-(commit|add)$/.test(words[k])) { targets.push({ segment, k, parsed: { chdirs: [], rest: [] } }); flag(`${words[k]} runs outside the git wrapper`); continue; }
      if (!isGitWord(words[k])) continue;
      const parsed = parseGitInvocation(words.slice(k + 1));
      if (COMMIT_SUBCOMMANDS.has(parsed.sub)) targets.push({ segment, k, parsed });
    }
  }
  if (!targets.length) return { targets: [], unknown: undefined, segments };
  if (!baseCwd) flag('the working directory is unknown');
  // Anything in the same command that can switch branch, repo or directory makes the target unknown.
  for (const segment of segments) {
    const { words } = segment;
    for (let k = 0; k < words.length; k++) {
      const word = words[k];
      if (isGitWord(word)) {
        const { sub, rest } = parseGitInvocation(words.slice(k + 1));
        if (BRANCH_CHANGING.has(sub)) flag(`git ${sub} in the same command can change the branch`);
        if (sub === 'branch' && rest.some(arg => /^-[a-zA-Z]*[mMcCf]/.test(arg) || /^--(m|co|f)/.test(arg))) flag('git branch in the same command can rename or move a branch');
        if (sub === 'config' && !rest.some(arg => CONFIG_READ.has(arg))) flag('git config in the same command can change what git does');
      }
      if (word === 'gh' && words.slice(k + 1).some(arg => arg === 'checkout' || arg === 'clone' || arg === 'co')) flag('gh checkout/clone in the same command can change the branch');
      if (/^GIT_[A-Z0-9_]+(=|$)/.test(word) && !SAFE_GIT_ENV.test(word)) flag(`${word.split('=')[0]} can point git at another repository`);
      if (/^CDPATH(=|$)/.test(word)) flag('CDPATH changes where cd goes');
      if (/(^|\/)\.git(\/|$)/.test(word)) flag(`${JSON.stringify(word)} touches git metadata directly`);
      if ((word === 'cd' || word === 'pushd' || word === 'popd' || word === 'chdir') && !(k === 0 && word === 'cd' && !segment.sub))
        flag(`${word} inside a subshell, function or compound statement`);
    }
    if (['source', '.', 'eval', 'exec'].includes(words[0])) flag(`${words[0]} can change the directory or branch`);
    for (const redirect of segment.redirects) if (redirect.file && /(^|\/)\.git(\/|$)/.test(redirect.target ?? '')) flag('a redirect writes git metadata');
  }
  const top = segments.filter(segment => !segment.sub);
  const hasCd = top.some(segment => segment.words[0] === 'cd');
  const out = [];
  for (const { segment, k, parsed } of targets) {
    let cwd = baseCwd;
    if (parsed.unsafe) flag(`${parsed.unsafe} can point git at another repository or branch`);
    if (!sameDirPrefix(segment.words.slice(0, k))) flag(`${JSON.stringify(segment.words.slice(0, k).join(' '))} may run git elsewhere`);
    if (hasCd && cwd) {
      // Only `cd dir && ... && git commit` is trusted: the chain must start the list (or follow ; / newline)
      // and be joined by && only, so the commit never runs unless every cd in the chain succeeded.
      const c = top.indexOf(segment);
      if (c < 0) flag('a commit inside a subshell or substitution follows a cd');
      else {
        let h = c;
        while (h > 0 && top[h].prevSep === '&&') h--;
        if (!['', ';', '\n'].includes(top[h].prevSep)) flag(`a cd before ${JSON.stringify(segment.text.slice(0, 80))} may not run`);
        if (top.slice(0, h).some(prior => prior.words[0] === 'cd')) flag('a cd outside the && chain may not have run');
        for (const step of top.slice(h, c)) {
          if (step.words[0] !== 'cd' || !cwd) continue;
          cwd = cdTarget(cwd, step.words, home);
          if (!cwd) flag(`${JSON.stringify(step.text)} has no literal target`);
        }
      }
    }
    for (const dir of parsed.chdirs) {
      if (!cwd) break;
      if (!literalPath(dir)) { flag(`git -C ${dir ?? ''} has no literal directory`); cwd = undefined; break; }
      cwd = path.resolve(cwd, dir === '~' || dir.startsWith('~/') ? path.join(home, dir.slice(2)) : dir);
    }
    const args = [];
    for (const arg of parsed.rest) { if (arg === '--') break; args.push(arg); }
    out.push({
      segment, cwd,
      // Native resources start with the command itself; only those can match a gated pattern.
      gated: k === 0 && segment.words[0] === 'git' && segment.words[1] === parsed.sub,
      amend: parsed.sub === 'commit' && args.some(arg => /^--am/.test(arg)),
    });
  }
  return { targets: out, unknown, segments };
}

// Reads the current branch of the repository containing cwd; undefined when detached, not a repo or on error.
export function gitBranchAt(cwd, { run = execFile, timeout = 2000 } = {}) {
  return new Promise(resolve => {
    try {
      run('git', ['symbolic-ref', '-q', 'HEAD'], { cwd, timeout, maxBuffer: 1 << 16,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } },
      (error, stdout) => {
        const ref = String(stdout ?? '').trim();
        resolve(!error && ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : undefined);
      });
    } catch { resolve(undefined); }
  });
}

// True only when HEAD of the repository containing cwd is on no remote-tracking branch
// (`git branch -r --contains HEAD` succeeds with empty output). Errors and timeouts count as pushed.
export function gitHeadUnpushed(cwd, { run = execFile, timeout = 5000 } = {}) {
  return new Promise(resolve => {
    try {
      run('git', ['branch', '-r', '--contains', 'HEAD'], { cwd, timeout, maxBuffer: 1 << 20,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } },
      (error, stdout) => resolve(!error && String(stdout ?? '').trim() === ''));
    } catch { resolve(false); }
  });
}

// Full-auto: `git commit --amend` is allowed when every amend in the command is a top-level git
// commit (gitCommitPlan resolves its repo; same-directory wrappers only, no branch/repo changes in
// the command) in a repo inside the project whose current branch is not main/master and whose HEAD
// is on no remote-tracking branch. Returns { ok, reasons }; ok is false when there is no amend.
export async function checkFullAutoAmends(command, baseCwd, project, { branchAt = gitBranchAt, headUnpushed = gitHeadUnpushed, home } = {}) {
  const plan = gitCommitPlan(command, baseCwd, home ? { home } : undefined);
  const amends = plan.targets.filter(target => target.amend);
  if (!amends.length) return { ok: false, reasons: [] };
  if (plan.unknown) return { ok: false, reasons: [`commit --amend cannot be checked (${plan.unknown})`] };
  // A push/fetch/pull (or gh) that may run before an amend can make HEAD pushed after the check:
  // only allow those after the last amend, at top level (`git commit --amend && git push`).
  const lastAmend = Math.max(...amends.map(target => plan.segments.indexOf(target.segment)));
  const remoteStep = plan.segments.findIndex((segment, index) => segment.words.some((word, k) =>
    (isGitWord(word) && ['push', 'fetch', 'pull', 'remote', 'submodule'].includes(parseGitInvocation(segment.words.slice(k + 1)).sub))
    || /(^|\/)gh$/.test(word)) && (index < lastAmend || segment.sub));
  if (remoteStep >= 0) return { ok: false, reasons: [`${JSON.stringify(plan.segments[remoteStep].text.slice(0, 80))} may push or fetch before commit --amend runs`] };
  const inside = dir => (project?.roots ?? []).some(root => [dir, realish(dir)].every(target => target === root || target.startsWith(root.endsWith('/') ? root : root + '/')));
  const reasons = [];
  for (const cwd of new Set(amends.map(target => target.cwd))) {
    if (!cwd) { reasons.push('commit --amend runs in an unknown directory'); continue; }
    if (!inside(cwd)) { reasons.push(`commit --amend runs outside the project (${cwd})`); continue; }
    const [branch, unpushed] = await Promise.all([branchAt(cwd), headUnpushed(cwd)]);
    if (branch === undefined) reasons.push(`commit --amend: cannot resolve the branch of ${cwd} (detached, not a repository or error)`);
    else if (PROTECTED_BRANCH.test(branch)) reasons.push(`commit --amend on protected branch ${branch} in ${cwd}`);
    if (!unpushed) reasons.push(`commit --amend: HEAD in ${cwd} is on a remote-tracking branch (pushed) or could not be checked`);
  }
  return { ok: !reasons.length, reasons };
}

// Async half of the guard for git add/commit. Returns { reasons, verified }: reasons force an ask (only
// for segments the configured rules would otherwise allow); verified counts gated add/commit segments
// that are safe to downgrade (all targets resolved to a non-main/master branch).
export async function checkCommitBranches(command, baseCwd, rules = [], { branchAt = gitBranchAt, home } = {}) {
  const plan = gitCommitPlan(command, baseCwd, home ? { home } : undefined);
  if (!plan.targets.length) return { reasons: [], verified: 0 };
  const branches = new Map();
  for (const target of plan.targets) {
    if (target.cwd && !plan.unknown && !branches.has(target.cwd)) branches.set(target.cwd, branchAt(target.cwd));
  }
  const reasons = [];
  let verified = 0, blocked = false;
  for (const target of plan.targets) {
    const branch = target.cwd && !plan.unknown ? await branches.get(target.cwd) : undefined;
    const why = target.amend ? 'amends a commit'
      : plan.unknown ? `cannot be checked (${plan.unknown})`
      : branch === undefined ? `cannot resolve the branch of ${target.cwd} (detached, not a repository or error)`
      : PROTECTED_BRANCH.test(branch) ? `runs on protected branch ${branch} in ${target.cwd}` : undefined;
    if (why) blocked = true;
    const effect = explicitShellEffect(target.segment.text, rules);
    if (why && (effect?.effect === 'allow' || !rules.length))
      reasons.push(`segment ${JSON.stringify(target.segment.text.slice(0, 200))} ${why}`);
    if (!why && target.gated) verified++;
  }
  return { reasons: [...new Set(reasons)], verified: blocked ? 0 : verified };
}

// fullAuto: keep secret, env-template and push checks plus deny rules, but drop re-checks of ask
// rules (full-auto projects allow those; full-auto.mjs decides what still asks).
export function analyzeShellCommand(command, rules = [], { fullAuto = false } = {}) {
  if (typeof command !== 'string' || !command.trim()) return { action: 'allow', reasons: [] };
  const { segments, compound } = scanShell(command);
  const reasons = [];
  let action = 'allow';
  for (const segment of segments) {
    for (const redirect of segment.redirects) {
      if (redirect.file && isSecretPath(redirect.target))
        reasons.push(`redirect ${redirect.op} targets secret-looking path ${JSON.stringify(redirect.target)}`);
    }
    // Configured shell rules may allow env templates after the secret asks. A template must
    // not carry another secret word through that exception (e.g. `cp .env.example .env`):
    // when the rules would allow the segment, re-evaluate it without its template words.
    if (segment.words.some(isEnvTemplatePath) && explicitShellEffect(segment.text, rules)?.effect === 'allow') {
      const rest = segment.words.filter(word => !isEnvTemplatePath(word));
      const matched = explicitShellEffect(rest.join(' '), rules);
      const secretWord = rest.find(isSecretPath);
      if (matched && matched.effect !== 'allow') {
        reasons.push(`segment ${JSON.stringify(segment.text.slice(0, 200))} names an env template together with input matching shell ${matched.effect} rule ${JSON.stringify(matched.pattern)}`);
        if (matched.effect === 'deny') action = 'deny';
      } else if (secretWord !== undefined) {
        reasons.push(`segment ${JSON.stringify(segment.text.slice(0, 200))} names an env template together with secret-looking path ${JSON.stringify(secretWord)}`);
      }
    }
    // Native wildcards miss -uf, quoted refspecs and `git -C d push -f`; ask whenever the
    // configured rules would allow (or nothing is configured) a force/delete push.
    const pushDanger = gitPushDanger(segment.words);
    if (pushDanger) {
      const effect = explicitShellEffect(segment.text, rules)?.effect;
      if (effect === 'allow' || !rules.length) reasons.push(`segment ${JSON.stringify(segment.text.slice(0, 200))} is a force/delete push or branch delete (${pushDanger})`);
    }
    // `git -C d reset --hard`, `timeout 5 git -c x=y stash` and other wrapped/global-option forms
    // slip past wildcards written for `git <sub> ...`: evaluate the canonical form too. Branch-gated
    // add/commit are left to checkCommitBranches.
    if (rules.length && !fullAuto && explicitShellEffect(segment.text, rules)?.effect === 'allow') {
      for (let k = 0; k < segment.words.length; k++) {
        if (!isGitWord(segment.words[k])) continue;
        const { sub, rest } = parseGitInvocation(segment.words.slice(k + 1));
        if (!sub || (k === 0 && segment.words[0] === 'git' && segment.words[1] === sub)) continue;
        const canonical = ['git', sub, ...rest].join(' ');
        const matched = explicitShellEffect(canonical, rules);
        if (matched && matched.effect !== 'allow' && !BRANCH_GATED_PATTERNS.has(matched.pattern)) {
          reasons.push(`segment ${JSON.stringify(segment.text.slice(0, 200))} runs ${JSON.stringify(canonical.slice(0, 120))}, which matches shell ${matched.effect} rule ${JSON.stringify(matched.pattern)}`);
          if (matched.effect === 'deny') action = 'deny';
        }
      }
    }
    if (!fullAuto && !segment.hasCommand && segment.redirects.some(redirect => redirect.file))
      reasons.push(`bare redirection ${JSON.stringify(segment.text)} has no command, so OpenCode would not check it`);
    if (compound && segment.redirects.length) {
      const matched = explicitShellEffect(segment.text, rules);
      if (matched && (fullAuto ? matched.effect === 'deny' : matched.effect !== 'allow')) {
        reasons.push(`segment ${JSON.stringify(segment.text.slice(0, 200))} matches shell ${matched.effect} rule ${JSON.stringify(matched.pattern)} that the native parser drops`);
        if (matched.effect === 'deny') action = 'deny';
      }
    }
  }
  if (reasons.length && action !== 'deny') action = 'ask';
  return { action, reasons: [...new Set(reasons)] };
}

const resolveWorkdir = (directory, workdir) => path.resolve(directory,
  workdir === '~' || workdir.startsWith('~/') ? path.join(process.env.HOME || os.homedir(), workdir.slice(2)) : workdir);

// Shell calls whose gated add/commit segments were verified on a feature branch, keyed by session and
// tool call. Module-level so per-directory plugin instances share it; entries are single use and expire.
const VERIFIED_COMMITS = new Map();
const VERIFIED_TTL_MS = 120_000;
const callKey = (sessionID, callID) => `${sessionID}\u0000${callID}`;

function rememberVerifiedCommit(event, rules, count) {
  if (!event?.sessionID || !event?.id) return;
  const now = Date.now();
  for (const [key, entry] of VERIFIED_COMMITS) if (entry.expires <= now) VERIFIED_COMMITS.delete(key);
  VERIFIED_COMMITS.set(callKey(event.sessionID, event.id), { rules, count, expires: now + VERIFIED_TTL_MS,
    ungated: rules.filter(rule => !(rule?.action === 'shell' && BRANCH_GATED_PATTERNS.has(rule.resource))) });
}

// Downgrades the native ask for a verified call only when every resource is allowed by the agent's
// rules or asks solely because of a branch-gated pattern, and there are no more gated resources than
// verified segments. Any other ask (amend, wrapped commit, secrets, rm -r, ...) stands.
export function downgradeVerifiedCommit(event) {
  const key = callKey(event.sessionID, event.source?.id);
  const entry = VERIFIED_COMMITS.get(key);
  if (!entry) return false;
  VERIFIED_COMMITS.delete(key);
  if (entry.expires <= Date.now() || !Array.isArray(event.resources)) return false;
  let gated = 0;
  for (const resource of event.resources) {
    const matched = explicitShellEffect(resource, entry.rules);
    if (matched?.effect === 'allow') continue;
    // The gated pattern must be the only reason to ask: without it the resource must be allowed, so
    // e.g. `git add .env` still hits the secret ask that `git add*` shadows (last match wins).
    if (matched?.effect === 'ask' && BRANCH_GATED_PATTERNS.has(matched.pattern)
        && explicitShellEffect(resource, entry.ungated)?.effect === 'allow') { gated++; continue; }
    return false;
  }
  if (!gated || gated > entry.count) return false;
  event.effect = 'allow';
  return true;
}

const listData = value => Array.isArray(value) ? value : Array.isArray(value?.data) ? value.data : [];

export async function installShellGuard(ctx, { tools = ['shell', 'bash'], fullAutoProjects, ...options } = {}) {
  if (typeof ctx?.tool?.hook !== 'function') return;
  const fullAutoProject = directory => fullAutoProjectFor(directory, ...(fullAutoProjects ? [fullAutoProjects()] : []));
  const permission = ctx.permission;
  const canAsk = typeof permission?.assert === 'function' && typeof permission?.hook === 'function';
  if (canAsk) {
    await permission.hook('evaluate', event => {
      const metadata = event?.metadata;
      // A guarded request must reach a human even under a permissive `shell *` allow.
      if (metadata?.[GUARD_MARKER] && event.effect === 'allow') {
        event.effect = 'ask';
        event.message = `Harness shell guard: ${metadata[GUARD_MARKER]}`;
        return;
      }
      if (event?.effect !== 'ask' || metadata?.[GUARD_MARKER]) return;
      if (event.action === 'shell' && downgradeVerifiedCommit(event)) return;
      // Full-auto projects (configure.py --full-auto-project). Reevaluation probes are left alone,
      // so asks already pending when the profile changes stay with a human.
      if (metadata?.[PROBE_MARKER]) return;
      const project = fullAutoProject(ctx.location?.directory);
      if (!project) return;
      if (event.action === 'shell') downgradeFullAutoShell(event, project);
      else if (PATH_ACTIONS.has(event.action) && pathResourcesInside(event.resources, project, ctx.location?.directory)) event.effect = 'allow';
    });
  }
  const rulesFor = async agentID => {
    try {
      const agent = listData(await ctx.agent.list()).find(entry => entry?.id === agentID);
      return Array.isArray(agent?.permissions) ? agent.permissions : [];
    } catch { return []; }
  };
  await ctx.tool.hook('execute.before', async event => {
    if (!tools.includes(event?.tool)) return;
    const command = event.input?.command;
    if (typeof command !== 'string') return;
    const rules = await rulesFor(event.agent);
    const directory = ctx.location?.directory;
    const workdir = event.input?.workdir;
    const base = typeof directory === 'string' && directory
      ? (typeof workdir === 'string' && workdir ? resolveWorkdir(directory, workdir) : directory) : undefined;
    const project = fullAutoProject(directory);
    if (project) {
      // Full-auto: no branch gating and no ask-rule re-checks; only the still-dangerous forms ask.
      const fullAuto = analyzeShellCommand(command, rules, { fullAuto: true });
      let reasons = [...fullAuto.reasons, ...fullAutoShellCheck(command, base, project)];
      if (fullAuto.action === 'deny') throw new Error(`Harness shell guard denied this command: ${reasons.join('; ')}. Split it into separate commands or use the edit/write tools.`);
      let amendOk = false;
      if (reasons.length) {
        // The only remaining asks are top-level amends: allow them on unpushed feature-branch HEADs.
        const withoutAmend = [...fullAuto.reasons, ...fullAutoShellCheck(command, base, project, { amendOk: true })];
        if (!withoutAmend.length) {
          const amend = await checkFullAutoAmends(command, base, project, options);
          if (amend.ok) { reasons = withoutAmend; amendOk = true; } else reasons.push(...amend.reasons);
        }
      }
      if (!reasons.length) { if (canAsk) rememberFullAuto(event, { amendOk }); return; }
      const reason = `full-auto project ${project.directory}: ${reasons.join('; ')}`;
      if (!canAsk) throw new Error(`Harness shell guard blocked this command because approval cannot be requested here: ${reason}.`);
      await permission.assert({
        sessionID: event.sessionID, agent: event.agent, action: 'shell', resources: [command], save: [],
        metadata: { [GUARD_MARKER]: reason }, source: { type: 'tool', messageID: event.messageID, id: event.id },
      });
      return;
    }
    const result = analyzeShellCommand(command, rules);
    if (result.action !== 'deny') {
      const branch = await checkCommitBranches(command, base, rules, options);
      if (branch.reasons.length) { result.action = 'ask'; result.reasons.push(...branch.reasons); }
      else if (result.action === 'allow' && branch.verified && canAsk) rememberVerifiedCommit(event, rules, branch.verified);
    }
    if (result.action === 'allow') return;
    const reason = result.reasons.join('; ');
    if (result.action === 'deny') throw new Error(`Harness shell guard denied this command: ${reason}. Split it into separate commands or use the edit/write tools.`);
    if (!canAsk) throw new Error(`Harness shell guard blocked this command because approval cannot be requested here: ${reason}. Use the edit/write tools for files, or run commands without redirects to secret-looking paths.`);
    await permission.assert({
      sessionID: event.sessionID, agent: event.agent, action: 'shell', resources: [command], save: [],
      metadata: { [GUARD_MARKER]: reason }, source: { type: 'tool', messageID: event.messageID, id: event.id },
    });
  });
}

export const markers = { GUARD_MARKER, PROBE_MARKER };
