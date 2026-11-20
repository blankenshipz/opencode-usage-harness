import test from 'node:test';
import assert from 'node:assert/strict';
import { readScopeAllows, installReadScope, shellOutputDir, PROBE_TOOL } from '../plugins/v2/read-scope.mjs';
import { markers } from '../plugins/v2/shell-guard.mjs';

const env = { XDG_DATA_HOME: '/data' };
const own = 'a5e9269e3a06caa615cd9f2a208adedb880edb37', other = '29e65981713d19a0ac8d91bae6536ab2e16f674c';
const realpath = p => p; // no symlinks in the fake tree
const opts = extra => ({ env, realpath, projectID: own, ...extra });

test('own shell output is readable; other projects and tools outside the dir are not', () => {
  assert.equal(shellOutputDir(own, env), `/data/opencode/shell/${own}`);
  assert.equal(readScopeAllows([`/data/opencode/shell/${own}/*`], opts({ action: 'external_directory', tool: 'read' })), true);
  assert.equal(readScopeAllows([`/data/opencode/shell/${own}/sh_1f77abc.out`], opts({ action: 'read', tool: 'read' })), true);
  // The directory gate also fronts edit/write/bash: own dir needs a read-only tool too.
  assert.equal(readScopeAllows([`/data/opencode/shell/${own}/*`], opts({ action: 'external_directory' })), false);
  for (const tool of ['edit', 'write', 'bash', 'shell'])
    assert.equal(readScopeAllows([`/data/opencode/shell/${own}/*`], opts({ action: 'external_directory', tool })), false, tool);
  assert.equal(shellOutputDir('global', env), undefined, 'shared non-git id is never own');
  assert.equal(readScopeAllows(['/data/opencode/shell/global/*'], opts({ action: 'external_directory', tool: 'read', projectID: 'global' })), false);
  assert.equal(readScopeAllows([`/data/opencode/shell/${other}/*`], opts({ action: 'external_directory', tool: 'read' })), false);
  assert.equal(readScopeAllows([`/data/opencode/shell/*`], opts({ action: 'external_directory', tool: 'read' })), false);
  assert.equal(readScopeAllows([`/data/opencode/shell/${own}/../${other}/*`], opts({ action: 'external_directory', tool: 'read' })), false);
  assert.equal(readScopeAllows([`/data/opencode/shell/${own}/*`], opts({ action: 'external_directory', tool: 'read', projectID: undefined })), false);
  assert.equal(readScopeAllows([`/data/opencode/shell/${own}/*`], opts({ action: 'edit', tool: 'edit' })), false);
  assert.equal(readScopeAllows([`/data/opencode/shell/${own}/*`, '/etc/*'], opts({ action: 'external_directory', tool: 'read' })), false);
});

test('/usr only for read-only tools, never secrets, never edits', () => {
  for (const tool of ['read', 'glob', 'grep', 'list'])
    assert.equal(readScopeAllows(['/usr/lib/postgresql/*'], opts({ action: 'external_directory', tool })), true, tool);
  assert.equal(readScopeAllows(['/usr/local/*'], opts({ action: 'external_directory', tool: 'glob' })), true);
  assert.equal(readScopeAllows(['/usr/lib/postgresql/*'], opts({ action: 'external_directory', tool: 'edit' })), false);
  assert.equal(readScopeAllows(['/usr/lib/postgresql/*'], opts({ action: 'external_directory', tool: 'write' })), false);
  assert.equal(readScopeAllows(['/usr/lib/postgresql/*'], opts({ action: 'external_directory' })), false);
  assert.equal(readScopeAllows(['/usrx/*'], opts({ action: 'external_directory', tool: 'read' })), false);
  assert.equal(readScopeAllows(['/usr/local/app/.env'], opts({ action: 'read', tool: 'read' })), false);
  assert.equal(readScopeAllows(['/usr/local/secrets/*'], opts({ action: 'external_directory', tool: 'read' })), false);
  assert.equal(readScopeAllows(['/usr/local/my-secrets/token'], opts({ action: 'read', tool: 'read' })), false);
  assert.equal(readScopeAllows(['/usr/local/.ssh/deploykey'], opts({ action: 'read', tool: 'read' })), false);
  assert.equal(readScopeAllows(['/usr/local/link2/*'], { ...opts({ action: 'external_directory', tool: 'read' }), realpath: p => p.replace('/usr/local/link2', '/usr/local/secrets') }), false, 'resolved secret dir');
  assert.equal(readScopeAllows(['/usr/*/x'], opts({ action: 'external_directory', tool: 'read' })), false);
  assert.equal(readScopeAllows(['usr/lib'], opts({ action: 'read', tool: 'read' })), false);
  // A symlink out of /usr does not count.
  assert.equal(readScopeAllows(['/usr/local/link/*'], { ...opts({ action: 'external_directory', tool: 'read' }), realpath: p => p.startsWith('/usr/local/link') ? p.replace('/usr/local/link', '/home/u') : p }), false);
});

test('evaluate hook downgrades only ask, keeps deny and guard asks, uses the call tool', async () => {
  const hooks = [], toolHooks = {};
  const ctx = { location: { directory: '/w/p', project: { id: own } },
    tool: { hook: async (name, cb) => { toolHooks[name] = cb; } },
    permission: { hook: async (name, cb) => { hooks.push(cb); } } };
  await installReadScope(ctx, { env });
  const run = async event => { for (const hook of hooks) await hook(event); return event.effect; };
  await toolHooks['execute.before']({ sessionID: 's', id: 'c1', tool: 'glob' });
  assert.equal(await run({ sessionID: 's', action: 'external_directory', resources: ['/usr/lib/postgresql/*'], effect: 'ask', source: { id: 'c1' } }), 'allow');
  assert.equal(await run({ sessionID: 's', action: 'external_directory', resources: ['/usr/lib/postgresql/*'], effect: 'deny', source: { id: 'c1' } }), 'deny');
  assert.equal(await run({ sessionID: 's', action: 'external_directory', resources: ['/usr/lib/postgresql/*'], effect: 'ask', source: { id: 'c2' } }), 'ask');
  assert.equal(await run({ sessionID: 's', action: 'external_directory', resources: ['/usr/lib/*'], effect: 'ask', source: { id: 'c1' }, metadata: { [markers.GUARD_MARKER]: 'x' } }), 'ask');
  assert.equal(await run({ sessionID: 's', action: 'read', resources: [`/data/opencode/shell/${own}/sh_1.out`], effect: 'ask', metadata: { [markers.PROBE_MARKER]: true } }), 'allow');
  // Reload probes carry the persisted tool; without it the directory gate stays asked.
  assert.equal(await run({ sessionID: 's', action: 'external_directory', resources: ['/usr/lib/postgresql/*'], effect: 'ask', metadata: { [markers.PROBE_MARKER]: true, [PROBE_TOOL]: 'glob' } }), 'allow');
  assert.equal(await run({ sessionID: 's', action: 'external_directory', resources: ['/usr/lib/postgresql/*'], effect: 'ask', metadata: { [markers.PROBE_MARKER]: true } }), 'ask');
  assert.equal(await run({ sessionID: 's', action: 'external_directory', resources: ['/usr/lib/postgresql/*'], effect: 'ask', metadata: { [PROBE_TOOL]: 'glob' } }), 'ask', 'tool metadata counts only on probes');
  await toolHooks['execute.after']({ sessionID: 's', id: 'c1' });
  assert.equal(await run({ sessionID: 's', action: 'external_directory', resources: ['/usr/lib/postgresql/*'], effect: 'ask', source: { id: 'c1' } }), 'ask');
});
