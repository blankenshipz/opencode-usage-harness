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
// It is lexical and quoting-aware for common cases, not a shell interpreter.

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
  const open = start => { current = { start, parts: [], words: [], redirects: [] }; };
  const close = () => {
    if (current && (current.words.length || current.redirects.length)) {
      segments.push({ text: current.parts.join(' ').trim(), words: current.words, redirects: current.redirects,
        hasCommand: current.words.some(word => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) });
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
      i++;
      // Consume pending heredoc bodies after the line that introduced them.
      while (heredocs.length) {
        const { delimiter, stripTabs } = heredocs.shift();
        for (;;) {
          if (i >= command.length) break;
          const lineEnd = command.indexOf('\n', i);
          const stop = lineEnd < 0 ? command.length : lineEnd;
          let line = command.slice(i, stop);
          if (stripTabs) line = line.replace(/^\t+/, '');
          i = stop + 1;
          if (line === delimiter) break;
        }
      }
      open(i); continue;
    }
    if (char === '#' ) { const lineEnd = command.indexOf('\n', i); i = lineEnd < 0 ? command.length : lineEnd; continue; }
    if (char === ';' || char === '(' || char === ')' || char === '`') { close(); if (char !== ';') nested = true; i++; open(i); continue; }
    if (char === '|' ) { close(); i += command[i + 1] === '|' || command[i + 1] === '&' ? 2 : 1; open(i); continue; }
    if (char === '&' && command[i + 1] !== '>') { close(); i += command[i + 1] === '&' ? 2 : 1; open(i); continue; }
    // Redirect operators, optionally prefixed by a file-descriptor number.
    const redirect = command.slice(i).match(/^(\d*)(&>>|&>|>>|>\||>&|<<<|<<-|<<|<>|<&|>|<)/);
    if (redirect) {
      const op = redirect[2];
      let j = i + redirect[0].length;
      if ((op === '>' || op === '<') && command[j] === '(') { // process substitution
        close(); nested = true; i = j + 1; open(i); continue;
      }
      while (j < command.length && isSpace(command[j])) j++;
      const word = readWord(command, j);
      const raw = command.slice(i, word.end);
      current.parts.push(raw);
      if (op === '<<' || op === '<<-') {
        heredocs.push({ delimiter: word.value, stripTabs: op === '<<-' });
        current.redirects.push({ op, target: undefined, heredoc: true });
      } else if (op === '<<<') {
        current.redirects.push({ op, target: undefined, herestring: true });
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
      for (const inner of scanShell(match[1]).segments) segments.push(inner);
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

function pushArgsDanger(args) {
  let positional = false;
  for (const arg of args) {
    if (!positional && arg === '--') { positional = true; continue; }
    if (!positional && arg.startsWith('--')) {
      if (/^--(force|mirror|delete|prune|receive-pack|exec)/.test(arg)) return `git push ${arg}`;
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

export function analyzeShellCommand(command, rules = []) {
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
      if (effect === 'allow' || !rules.length) reasons.push(`segment ${JSON.stringify(segment.text.slice(0, 200))} is a force/delete push (${pushDanger})`);
    }
    if (!segment.hasCommand && segment.redirects.some(redirect => redirect.file))
      reasons.push(`bare redirection ${JSON.stringify(segment.text)} has no command, so OpenCode would not check it`);
    if (compound && segment.redirects.length) {
      const matched = explicitShellEffect(segment.text, rules);
      if (matched && matched.effect !== 'allow') {
        reasons.push(`segment ${JSON.stringify(segment.text.slice(0, 200))} matches shell ${matched.effect} rule ${JSON.stringify(matched.pattern)} that the native parser drops`);
        if (matched.effect === 'deny') action = 'deny';
      }
    }
  }
  if (reasons.length && action !== 'deny') action = 'ask';
  return { action, reasons: [...new Set(reasons)] };
}

const listData = value => Array.isArray(value) ? value : Array.isArray(value?.data) ? value.data : [];

export async function installShellGuard(ctx, { tools = ['shell', 'bash'] } = {}) {
  if (typeof ctx?.tool?.hook !== 'function') return;
  const permission = ctx.permission;
  const canAsk = typeof permission?.assert === 'function' && typeof permission?.hook === 'function';
  if (canAsk) {
    await permission.hook('evaluate', event => {
      const metadata = event?.metadata;
      // A guarded request must reach a human even under a permissive `shell *` allow.
      if (metadata?.[GUARD_MARKER] && event.effect === 'allow') {
        event.effect = 'ask';
        event.message = `Harness shell guard: ${metadata[GUARD_MARKER]}`;
      }
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
    const result = analyzeShellCommand(command, await rulesFor(event.agent));
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
