import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probeEnvironment, renderCard, ensureScratchDir, createEnvCardCache, installEnvCard, CARD_RULE } from '../plugins/v2/env-card.mjs';

const tmpRepo = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'envcard-'))); fs.mkdirSync(path.join(d, '.git', 'info'), { recursive: true }); return d; };

test('probe uses PATH lookups, sockets and DNS; card is short and carries the rule', async () => {
  const repo = tmpRepo();
  const exec = { env: { PATH: '/fake/bin:relative' }, executable: p => ['/fake/bin/node', '/fake/bin/git'].includes(p),
    exists: p => p === '/tmp/.s.PGSQL.5432', dnsLookup: async () => false };
  const probe = await probeEnvironment(repo, { exec });
  assert.equal(probe.binaries.node, true); assert.equal(probe.binaries.psql, false);
  assert.equal(probe.postgresRunning, true); assert.equal(probe.dockerSocket, false); assert.equal(probe.network, false);
  assert.equal(probe.scratch, path.join(repo, '.review'));
  assert.equal(fs.statSync(probe.scratch).mode & 0o777, 0o700);
  const card = renderCard(probe);
  assert.ok(card.length < 900, card.length);
  assert.ok(card.includes(CARD_RULE)); assert.match(card, /missing: .*psql/); assert.match(card, /unreachable/);
  assert.match(card, /\/home\/box/);
});

test('scratch dir is git-excluded once, never via .gitignore, and rejects escaping symlinks', () => {
  const repo = tmpRepo();
  ensureScratchDir(repo); ensureScratchDir(repo);
  assert.equal(fs.readFileSync(path.join(repo, '.git/info/exclude'), 'utf8'), '.review/\n');
  assert.equal(fs.existsSync(path.join(repo, '.gitignore')), false);
  const other = tmpRepo(), outside = fs.mkdtempSync(path.join(os.tmpdir(), 'out-'));
  fs.symlinkSync(outside, path.join(other, '.review'));
  assert.throws(() => ensureScratchDir(other), /escapes/);
});

test('card is cached, refreshed on root session.created, injected only for router/coordinator/builder', async () => {
  let probes = 0;
  const written = [];
  const cache = createEnvCardCache({ probe: async dir => ({ directory: dir, binaries: { node: true }, scratch: dir + '/.review', n: ++probes }), write: async (_d, r) => { written.push(r); } });
  const hooks = {};
  let push;
  const events = { [Symbol.asyncIterator]() { return { next: () => new Promise(r => { push = r; }) }; } };
  const ctx = { location: { directory: '/repo' }, session: { hook: async (name, fn) => { hooks[name] = fn; } }, event: { subscribe: () => events } };
  const installed = await installEnvCard(ctx, { cache, autoPermission: async () => ({ stop() {} }) });
  for (const agent of ['router', 'harness-coordinator', 'builder', 'scout', 'reviewer']) {
    const event = { agent, system: [] };
    await hooks.context(event);
    assert.equal(event.system.length, ['scout', 'reviewer'].includes(agent) ? 0 : 1, agent);
  }
  assert.equal(probes, 1); assert.equal(written.length, 1); assert.ok(written[0].card.includes(CARD_RULE));
  push({ value: { type: 'session.created', data: { info: { id: 'c', parentID: 'p' } } }, done: false });
  await new Promise(r => setImmediate(r));
  assert.equal(probes, 1, 'child sessions do not refresh');
  push({ value: { type: 'session.created', data: { info: { id: 'r' } } }, done: false });
  await new Promise(r => setImmediate(r)); await cache.get('/repo');
  assert.equal(probes, 2);
  installed.stop();
});
