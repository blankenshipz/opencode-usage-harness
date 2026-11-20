import test from 'node:test';
import assert from 'node:assert/strict';
import { decideAutoPermission, installAutoPermission } from '../plugins/v2/auto-permission.mjs';
import { markers } from '../plugins/v2/shell-guard.mjs';

const links = { '/repo/.review/escape': '/home/box/.ssh' };
const realpath = p => {
  for (const [from, to] of Object.entries(links)) if (p === from || p.startsWith(from + '/')) return to + p.slice(from.length);
  if (p.startsWith('/repo') || ['/opt', '/bin', '/usr/bin', '/home/box'].includes(p)) return p;
  throw new Error('ENOENT');
};
const d = extra => decideAutoPermission({ directory: '/repo', home: '/home/box', realpath, action: 'external_directory', ...extra }).decision;

test('names-only listing of system binary dirs is allowed; recursion, contents and other dirs are not', () => {
  assert.equal(d({ tool: 'glob', resources: ['/opt/*'], input: { pattern: '*', path: '/opt' } }), 'allow');
  assert.equal(d({ tool: 'glob', resources: ['/snap/bin/*'], input: { pattern: '/snap/bin/*' } }), 'allow');
  assert.equal(d({ tool: 'glob', resources: ['/opt/*'], input: { pattern: '**/*', path: '/opt' } }), 'ask');
  assert.equal(d({ tool: 'glob', resources: ['/etc/*'], input: { pattern: '*', path: '/etc' } }), 'ask');
  assert.equal(d({ tool: 'read', resources: ['/usr/bin/*'] }), 'ask');
  for (const command of ['ls /usr/local/bin', 'ls -1 /opt', 'ls -a /bin/', 'ls -1ad /sbin'])
    assert.equal(d({ tool: 'bash', resources: [command.split(' ').at(-1).replace(/\/$/, '') + '/*'], input: { command } }), 'allow', command);
  for (const command of ['ls -R /opt', 'ls -l /opt', 'ls /etc', 'ls /opt; cat /etc/passwd', 'ls /opt/*', 'cat /opt/x', 'ls /opt /home/box', 'ls /opt &', 'nohup ls /opt', 'ls /opt && echo $!'])
    assert.equal(d({ tool: 'bash', resources: ['/opt/*'], input: { command } }), 'ask', command);
});

test('.review scratch file operations are allowed only when the realpath stays inside', () => {
  assert.equal(d({ action: 'edit', tool: 'write', resources: ['.review/notes.txt'] }), 'allow');
  assert.equal(d({ action: 'edit', tool: 'edit', resources: ['/repo/.review/a/b.json'] }), 'allow');
  assert.equal(d({ action: 'edit', tool: 'write', resources: ['/repo/.review/escape/id_rsa'] }), 'ask');
  assert.equal(d({ action: 'edit', tool: 'write', resources: ['/repo/.review/../src/x.js'] }), 'ask');
  assert.equal(d({ action: 'edit', tool: 'write', resources: ['/repo/src/x.js'] }), 'ask');
  assert.equal(d({ action: 'bash', tool: 'bash', resources: ['/repo/.review/*'], input: { command: 'rm -rf .review/x' } }), 'ask');
  assert.equal(d({ tool: 'read', resources: ['/home/box/notes/*'] }), 'ask');
  assert.equal(d({ tool: 'glob', resources: ['/home/box/.aws/*'], input: { pattern: '*' } }), 'ask');
  assert.equal(d({ tool: 'read', resources: ['/srv/gateway/secrets/*'] }), 'ask');
});

test('evaluate hook allows covered asks, never rejects, skips guard asks, logs every auto decision', async () => {
  const hooks = {}, logs = [];
  const ctx = { location: { directory: '/repo' }, permission: { hook: async (n, fn) => { hooks[n] = fn; } }, tool: { hook: async (n, fn) => { hooks[n] = fn; } } };
  await installAutoPermission(ctx, { log: r => logs.push(r), realpath, home: '/home/box', now: () => 0 });
  hooks['execute.before']({ sessionID: 's', id: 'c1', tool: 'bash', input: { command: 'ls /opt' } });
  hooks['execute.before']({ sessionID: 's', id: 'c2', tool: 'bash', input: { command: 'cat ~/.ssh/id_rsa' } });
  const a = { effect: 'ask', sessionID: 's', source: { id: 'c1' }, action: 'external_directory', resources: ['/opt/*'] };
  const b = { effect: 'ask', sessionID: 's', source: { id: 'c2' }, action: 'bash', resources: ['cat ~/.ssh/id_rsa'] };
  const g = { effect: 'ask', sessionID: 's', source: { id: 'c1' }, action: 'external_directory', resources: ['/opt/*'], metadata: { [markers.GUARD_MARKER]: true } };
  hooks.evaluate(a); hooks.evaluate(b); hooks.evaluate(g);
  assert.equal(a.effect, 'allow'); assert.equal(b.effect, 'ask'); assert.equal(g.effect, 'ask');
  assert.deepEqual(logs.map(l => [l.tool, l.decision]), [['bash', 'allow'], ['bash', 'decline_to_auto']]);
  assert.deepEqual(Object.keys(logs[0]).sort(), ['decision', 'pattern', 'reason', 'sessionID', 'time', 'tool']);
});

test('r26 fable: shell tool and relative secret paths never auto-allow', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { decideAutoPermission } = await import('../plugins/v2/auto-permission.mjs');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-')); fs.mkdirSync(path.join(repo, '.review'));
  const real = fs.realpathSync(repo);
  for (const tool of ['shell', 'bash']) assert.equal(decideAutoPermission({ tool, resources: ['.review/x.sh'], input: { command: '.review/x.sh /home/box/.ssh/id_rsa' }, directory: real, home: '/home/box' }).decision, 'ask');
  assert.equal(decideAutoPermission({ tool: 'write', action: 'shell', resources: ['.review/x'], input: {}, directory: real, home: '/home/box' }).decision, 'ask');
  assert.equal(decideAutoPermission({ tool: 'read', resources: ['.review/.env'], input: {}, directory: real, home: '/home/box' }).decision, 'ask');
  assert.equal(decideAutoPermission({ tool: 'read', resources: ['.review/notes.txt'], input: {}, directory: real, home: '/home/box' }).decision, 'allow');
});
