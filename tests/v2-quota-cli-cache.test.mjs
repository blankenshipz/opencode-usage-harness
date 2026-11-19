import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readCachedClaudeQuota } from '../plugins/v2/provider-quota.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const key = c => c.repeat(64);
const snapshot = checked => ({ checked_at: new Date(checked).toISOString(), extra_usage: { is_enabled: false },
  seven_day: { utilization: 25, resets_at: new Date(checked + 3 * 86400_000).toISOString(), locked_reason: null },
  limits: [{ percent: 25, resets_at: new Date(checked + 3 * 86400_000).toISOString(), kind: 'weekly_all', scope: null, is_active: true }] });
function fixture(entries) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-cli-'));
  const dir = path.join(state, 'quota-cache'); fs.mkdirSync(dir, { mode: 0o700 });
  for (const [name, value, mode = 0o600] of entries) fs.writeFileSync(path.join(dir, name), typeof value === 'string' ? value : JSON.stringify(value), { mode });
  return { state, dir };
}

test('cached Claude snapshot: newest anthropic entry, age and staleness, unsafe files ignored', async () => {
  const now = Date.parse('2026-11-19T20:00:00Z');
  const { dir } = fixture([
    [`${key('a')}.json`, { version: 1, provider: 'anthropic', verified_at: now - 30_000, snapshot: snapshot(now - 30_000) }],
    [`${key('b')}.json`, { version: 1, provider: 'anthropic', verified_at: now - 3600_000, snapshot: snapshot(now - 3600_000) }],
    [`${key('c')}.json`, { version: 1, provider: 'anthropic', verified_at: now - 1000, snapshot: snapshot(now - 1000) }, 0o644],
    [`${key('d')}.json`, { version: 1, provider: 'anthropic', invalidated_at: now }],
    [`${key('e')}.json`, '{corrupt'],
    [`${key('a')}.flock`, ''],
  ]);
  const fresh = await readCachedClaudeQuota({ directory: dir, now });
  assert.equal(fresh.source, 'quota_cache');
  assert.deepEqual(fresh.cache, { verified_at: new Date(now - 30_000).toISOString(), age_seconds: 30, stale: false });
  assert.equal(fresh.reason, 'cached_snapshot');
  assert.equal(fresh.availability, 'available');
  assert.equal(fresh.windows[0].used_percent, 25);
  const stale = await readCachedClaudeQuota({ directory: dir, now: now + 600_000 });
  assert.equal(stale.cache.stale, true); assert.equal(stale.reason, 'cached_snapshot_stale');
  assert.equal(await readCachedClaudeQuota({ directory: path.join(dir, 'missing'), now }), null);
});

test('subscription-quota CLI reports the cache when the adapter is unavailable, never secrets', () => {
  const verified = Date.now() - 45_000;
  const { state } = fixture([[`${key('f')}.json`, { version: 1, provider: 'anthropic', verified_at: verified, snapshot: { ...snapshot(verified), access_token: 'sk-ant-oat-SECRET' } }]]);
  // A failing fake Codex binary: no real CLI or network call.
  const env = { PATH: process.env.PATH, HOME: state, HARNESS_STATE_DIR: state, HARNESS_CODEX_BIN: '/bin/false', CODEX_HOME: state };
  const text = execFileSync(process.execPath, [path.join(root, 'bin/subscription-quota.mjs')], { env, encoding: 'utf8' });
  const line = text.split('\n').find(l => l.startsWith('anthropic:'));
  assert.match(line, /^anthropic: available \(1 windows, pace \w+\) \[quota_cache 4\ds old; verified .*; weekly_all 25%\]$/);
  assert.doesNotMatch(text, /SECRET|adapter_unavailable|f{64}/);
  const json = JSON.parse(execFileSync(process.execPath, [path.join(root, 'bin/subscription-quota.mjs'), '--json'], { env, encoding: 'utf8' }));
  assert.equal(json.pools.anthropic.source, 'quota_cache');
  assert.equal(json.pools.anthropic.cache.stale, false);
  assert.doesNotMatch(JSON.stringify(json), /SECRET/);
  // Empty cache: the original adapter_unavailable report remains.
  const empty = fixture([]).state;
  const none = execFileSync(process.execPath, [path.join(root, 'bin/subscription-quota.mjs')], { env: { ...env, HARNESS_STATE_DIR: empty }, encoding: 'utf8' });
  assert.match(none, /anthropic: unknown .*\[adapter_unavailable\]/);
});
