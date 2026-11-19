import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeShellCommand, scanShell, isSecretPath, isEnvTemplatePath, explicitShellEffect, installShellGuard, markers } from '../plugins/v2/shell-guard.mjs';

const PERMISSIVE = [
  { action: '*', resource: '*', effect: 'ask' },
  { action: 'shell', resource: '*', effect: 'allow' },
  { action: 'shell', resource: 'rm -rf *', effect: 'ask' },
  { action: 'shell', resource: 'git push*', effect: 'ask' },
  { action: 'shell', resource: '*.env*', effect: 'ask' },
  { action: 'shell', resource: 'tee *', effect: 'ask' },
  { action: 'shell', resource: 'mkfs*', effect: 'deny' },
];
const ALLOWLIST = [
  { action: '*', resource: '*', effect: 'ask' },
  { action: 'shell', resource: 'pwd', effect: 'allow' },
  { action: 'shell', resource: 'git status*', effect: 'allow' },
  { action: 'shell', resource: 'pytest*', effect: 'allow' },
];

const asks = [
  ['echo KEY=1 > .env', 'secret redirect'],
  ['echo KEY=1 >> .env.local', 'append to .env.*'],
  ['cd apps/api && cat >> .env <<EOF\nA=1\nEOF', 'list + heredoc to .env'],
  ['printf x >config/credentials.json', 'no space before target'],
  ['echo x > "secrets/token.txt"', 'quoted target, secret dir'],
  ['echo x 2> server.pem', 'fd redirect to pem'],
  ['cat id.key &> out', 'secret only in argument? no: &> out not secret'],
  ['ls &> ~/.config/auth.json', 'combined redirect'],
  ['ls >| my-secret.txt', 'clobber redirect'],
  ['cat < .env', 'input redirect from secret'],
  ['echo x >anthropic-financial-policy.json', 'financial policy'],
  ['echo x > state/external-write-grants.json', 'grants'],
  ['> notes.txt', 'bare redirect'],
  ['true; >> log.txt', 'bare redirect after ;'],
  ['(echo a; echo b) > .env', 'subshell redirect'],
  ['echo $(cat x > .env)', 'redirect inside command substitution'],
  ["echo 'a' > .env", 'quoted content, unquoted redirect'],
];

test('raw-command guard asks for secret and bare redirects', () => {
  for (const [command, label] of asks) {
    const result = analyzeShellCommand(command, ALLOWLIST);
    if (label.startsWith('secret only')) { assert.equal(result.action, 'allow', label); continue; }
    assert.equal(result.action, 'ask', `${label}: ${command}`);
    assert.ok(result.reasons.length > 0, label);
  }
});

const allows = [
  'echo "a > .env"',
  "echo 'x >> secrets.txt'",
  'echo a\\>.env',
  'grep -n ">" .env.example',
  'pytest -q 2>&1 | tail -5',
  'ls 2>/dev/null',
  'git status >&2',
  'cmd 1>&2 2>&-',
  'python -m pytest > out.log',
  'cd apps/api && pytest -q > ../report.txt',
  'cat <<\'EOF\' > notes.md\nwrite to .env > secrets\nEOF',
  'cat <<-EOF > notes.md\n\techo > .env\n\tEOF',
  'grep -c x <<< "> .env"',
  'diff <(sort a) <(sort b)',
  'echo hi # > .env',
  'echo "$(date)" > build.log',
  'FOO=1 make > build.log',
  '',
];

test('quoted operators, heredoc bodies, fd duplication and safe targets do not trigger', () => {
  for (const command of allows) {
    assert.deepEqual(analyzeShellCommand(command, ALLOWLIST), { action: 'allow', reasons: [] }, command);
    assert.equal(analyzeShellCommand(command, PERMISSIVE).action, 'allow', command);
  }
});

test('compound redirect segments are checked against explicit shell ask/deny rules', () => {
  const ask = analyzeShellCommand('cd x && git push origin main > push.log', PERMISSIVE);
  assert.equal(ask.action, 'ask');
  assert.match(ask.reasons[0], /git push\*/);
  assert.equal(analyzeShellCommand('ls | tee out.txt > copy.txt', PERMISSIVE).action, 'ask');
  const deny = analyzeShellCommand('true && mkfs.ext4 /dev/sdz > log', PERMISSIVE);
  assert.equal(deny.action, 'deny');
  // Simple (non-compound) commands keep their redirects natively; no duplicate ask.
  assert.equal(analyzeShellCommand('git push > push.log', PERMISSIVE).action, 'allow');
  // Without redirects the native parser already sees each command.
  assert.equal(analyzeShellCommand('cd x && git push', PERMISSIVE).action, 'allow');
  // Catch-all `*` action asks are defaults, not configured shell asks.
  assert.equal(analyzeShellCommand('cd x && make > build.log', ALLOWLIST).action, 'allow');
});

test('scanner keeps redirects with their own list segment and skips heredoc bodies', () => {
  const { segments, compound } = scanShell("cd apps/api && cat >> tests/t.py <<'EOF'\nx = '>' \nEOF\npytest -q");
  assert.equal(compound, true);
  assert.deepEqual(segments.map(s => s.text), ['cd apps/api', "cat >> tests/t.py <<'EOF'", 'pytest -q']);
  assert.deepEqual(segments[1].redirects.map(r => r.target), ['tests/t.py', undefined]);
});

test('secret path classifier', () => {
  for (const path of ['.env', 'a/.env.prod', 'id_rsa.key', 'cert.pem', 'auth.json', 'MY_SECRET', 'aws/credentials'])
    assert.equal(isSecretPath(path), true, path);
  for (const path of ['env.txt', 'environment.md', 'keys.txt', 'report.json', '/dev/null', 'authors.json'])
    assert.equal(isSecretPath(path), false, path);
});

test('env templates are not secret paths, real env files are', () => {
  for (const path of ['.env.example', 'apps/api/.env.sample', '/w/.ENV.Template', 'C:\\repo\\.env.example'])
    assert.equal(isSecretPath(path), false, path);
  for (const path of ['.env', '.env.local', '.env.production', '.env.development.local', '.env.example.bak', 'secrets/.env.example'])
    assert.equal(isSecretPath(path), true, path);
  assert.equal(isEnvTemplatePath('x.env.example'), false);
});

// Mirrors configure.py's permissive order: secret asks, env-template allows, command asks.
const TEMPLATE_RULES = ['.env.example', '.env.sample', '.env.template'].flatMap(name =>
  [`* ${name}`, `* ${name} *`, `* */${name}`, `* */${name} *`].map(resource => ({ action: 'shell', resource, effect: 'allow' })));
const PERMISSIVE_TEMPLATES = [
  { action: '*', resource: '*', effect: 'ask' },
  { action: 'shell', resource: '*', effect: 'allow' },
  ...['*.env*', '*.pem*', '*secret*'].map(resource => ({ action: 'shell', resource, effect: 'ask' })),
  ...TEMPLATE_RULES,
  { action: 'shell', resource: 'rm -rf *', effect: 'ask' },
  { action: 'shell', resource: 'mkfs*', effect: 'deny' },
];

test('env templates pass under permissive rules, other secrets beside them still ask', () => {
  for (const command of ['cat .env.example', 'cp apps/api/.env.sample notes.txt', 'grep -n KEY .env.template',
    'echo A=1 >> .env.example', 'cd apps && cat config/.env.example'])
    assert.equal(analyzeShellCommand(command, PERMISSIVE_TEMPLATES).action, 'allow', command);
  for (const command of ['cp .env.example .env', 'diff .env.example .env.local', 'cat .env.example cert.pem',
    'cat .env.example > .env', 'grep secret .env.example', 'cat .env.example .env.production'])
    assert.equal(analyzeShellCommand(command, PERMISSIVE_TEMPLATES).action, 'ask', command);
  assert.equal(analyzeShellCommand('mkfs .env.example', PERMISSIVE_TEMPLATES).action, 'allow', 'native deny still applies');
  // Native evaluation (last match wins) of single commands under these rules.
  const native = command => explicitShellEffect(command, PERMISSIVE_TEMPLATES)?.effect;
  assert.equal(native('cat .env.example'), 'allow');
  assert.equal(native('cat sub/.env.sample'), 'allow');
  assert.equal(native('cat .env'), 'ask');
  assert.equal(native('cat .env.local'), 'ask');
  assert.equal(native('cat .env.example.bak'), 'ask');
  assert.equal(native('rm -rf .env.example'), 'ask');
  // Without template exceptions (allowlist policy) the guard adds no extra prompt.
  assert.equal(analyzeShellCommand('diff .env.example .env', ALLOWLIST).action, 'allow');
});

function fakeContext({ permissions = PERMISSIVE, assertImpl, permissionApi = true } = {}) {
  const hooks = {}, evaluateHooks = [], asserts = [];
  const ctx = {
    tool: { hook: async (name, callback) => { hooks[name] = callback; } },
    agent: { list: async () => ({ data: [{ id: 'harness-builder', permissions }] }) },
  };
  if (permissionApi) ctx.permission = {
    hook: async (name, callback) => { assert.equal(name, 'evaluate'); evaluateHooks.push(callback); },
    assert: async input => {
      asserts.push(input);
      const event = { ...input, effect: 'allow' };
      for (const hook of evaluateHooks) await hook(event);
      if (assertImpl) return assertImpl(event);
    },
  };
  return { ctx, hooks, evaluateHooks, asserts };
}

test('plugin hook forces a native ask on the raw command even when shell * allows', async () => {
  const { ctx, hooks, asserts } = fakeContext({ assertImpl: event => assert.equal(event.effect, 'ask') });
  await installShellGuard(ctx);
  const call = { tool: 'shell', sessionID: 'ses_1', agent: 'harness-builder', messageID: 'msg_1', id: 'call_1' };
  await hooks['execute.before']({ ...call, input: { command: 'cd apps && cat >> .env <<EOF\nA=1\nEOF' } });
  assert.equal(asserts.length, 1);
  assert.deepEqual(asserts[0].resources, ['cd apps && cat >> .env <<EOF\nA=1\nEOF']);
  assert.deepEqual(asserts[0].save, []);
  assert.ok(asserts[0].metadata[markers.GUARD_MARKER]);
  assert.deepEqual(asserts[0].source, { type: 'tool', messageID: 'msg_1', id: 'call_1' });
  await hooks['execute.before']({ ...call, input: { command: 'echo "> .env"' } });
  await hooks['execute.before']({ ...call, tool: 'read', input: { command: '> .env' } });
  assert.equal(asserts.length, 1);
});

test('declined guard ask rejects the call; deny rules and missing permission API block', async () => {
  const declined = fakeContext({ assertImpl: () => { throw new Error('declined'); } });
  await installShellGuard(declined.ctx);
  await assert.rejects(declined.hooks['execute.before']({ tool: 'shell', agent: 'harness-builder', input: { command: '> x' } }), /declined/);
  const denied = fakeContext();
  await installShellGuard(denied.ctx);
  await assert.rejects(denied.hooks['execute.before']({ tool: 'shell', agent: 'harness-builder', input: { command: 'a && mkfs /dev/x > l' } }), /denied/);
  assert.equal(denied.asserts.length, 0);
  const noApi = fakeContext({ permissionApi: false });
  await installShellGuard(noApi.ctx);
  await assert.rejects(noApi.hooks['execute.before']({ tool: 'shell', agent: 'harness-builder', input: { command: 'echo x > .env' } }), /blocked/);
  await noApi.hooks['execute.before']({ tool: 'shell', agent: 'harness-builder', input: { command: 'ls > out.txt' } });
});

test('evaluate hook only upgrades guarded requests', async () => {
  const { ctx, evaluateHooks } = fakeContext();
  await installShellGuard(ctx);
  const plain = { action: 'shell', effect: 'allow', metadata: undefined };
  await evaluateHooks[0](plain);
  assert.equal(plain.effect, 'allow');
  const guarded = { action: 'shell', effect: 'allow', metadata: { [markers.GUARD_MARKER]: 'x' } };
  await evaluateHooks[0](guarded);
  assert.equal(guarded.effect, 'ask');
  const denied = { action: 'shell', effect: 'deny', metadata: { [markers.GUARD_MARKER]: 'x' } };
  await evaluateHooks[0](denied);
  assert.equal(denied.effect, 'deny');
});
