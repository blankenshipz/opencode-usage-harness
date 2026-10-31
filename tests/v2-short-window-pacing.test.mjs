import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createShortWindowPacingStore, SHORT_WINDOW_PACING_IDENTITY } from '../plugins/v2/short-window-pacing.mjs';
import { readProviderQuotas } from '../plugins/v2/provider-quota.mjs';
import { readSelectedClaudeUsage } from '../plugins/v2/anthropic-subscription.mjs';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'short-window-pacing-'));
  const clock = { now: Date.parse('2026-10-30T12:00:00.000Z') };
  return { directory, clock, store: createShortWindowPacingStore({ directory, now: () => clock.now }), cleanup: () => rm(directory, { recursive: true, force: true }) };
}
function pool(clock, used = 20, reset = clock.now + 300 * 60_000) {
  return { provider: 'anthropic', checked_at: new Date(clock.now).toISOString(), windows: [
    { kind: 'session', scope: 'account', duration_minutes: 300, used_percent: used, resets_at: new Date(reset).toISOString() },
  ] };
}

test('short-window pacing estimates only from two fresh samples of one selected credential', async () => {
  const f = await fixture();
  try {
    const first = await f.store.observe(pool(f.clock), { identity: 'selected-credential-a' });
    assert.equal(first.status, 'unknown');
    assert.equal(first.reason, 'insufficient_fresh_samples');
    f.clock.now += 10 * 60_000;
    const second = await f.store.observe(pool(f.clock, 30, Date.parse('2026-10-30T17:00:00.000Z')), { identity: 'selected-credential-a' });
    assert.equal(second.status, 'estimated');
    assert.equal(second.windows[0].usage_change_percent, 10);
    assert.equal(second.windows[0].usage_rate_percent_per_hour, 60);
    assert.equal(second.windows[0].estimated_minutes_to_exhaustion, 70);
    assert.equal(second.windows[0].estimated_exhaustion_at, '2026-10-30T13:20:00.000Z');
    const payload = await readFile(join(f.directory, 'history.json'), 'utf8');
    assert.doesNotMatch(payload, /selected-credential-a/);
    assert.ok((await readdir(f.directory)).every(name => !name.includes('selected-credential-a')));
  } finally { await f.cleanup(); }
});

test('identity gaps, reset windows, and counter decreases remain unknown', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.store.observe(pool(f.clock))).reason, 'account_identity_unavailable');
    await f.store.observe(pool(f.clock, 50), { identity: 'a' });
    f.clock.now += 5 * 60_000;
    const decreased = await f.store.observe(pool(f.clock, 40, Date.parse('2026-10-30T17:00:00.000Z')), { identity: 'a' });
    assert.equal(decreased.status, 'unknown');
    assert.equal(decreased.reason, 'counter_reset_or_decrease');
    f.clock.now += 5 * 60_000;
    const differentAccount = await f.store.observe(pool(f.clock, 80, Date.parse('2026-10-30T17:00:00.000Z')), { identity: 'b' });
    assert.equal(differentAccount.reason, 'insufficient_fresh_samples');
    f.clock.now += 5 * 60_000;
    const nextReset = await f.store.observe(pool(f.clock, 5, Date.parse('2026-10-30T22:00:00.000Z')), { identity: 'a' });
    assert.equal(nextReset.reason, 'insufficient_fresh_samples');
  } finally { await f.cleanup(); }
});

test('provider quota output exposes advisory data but never the private identity sidechannel', async () => {
  const f = await fixture();
  try {
    const raw = { checked_at: new Date(f.clock.now).toISOString(), five_hour: { utilization: 10, resets_at: f.clock.now + 300 * 60_000 } };
    Object.defineProperty(raw, SHORT_WINDOW_PACING_IDENTITY, { value: 'credential-fingerprint' });
    const first = await readProviderQuotas({ providers: ['anthropic'], now: f.clock.now, readClaude: async () => raw, pacingStore: f.store });
    assert.equal(first.pools.anthropic.advisory.short_window_pacing.reason, 'insufficient_fresh_samples');
    f.clock.now += 10 * 60_000;
    const later = { checked_at: new Date(f.clock.now).toISOString(), five_hour: { utilization: 20, resets_at: Date.parse('2026-10-30T17:00:00.000Z') } };
    Object.defineProperty(later, SHORT_WINDOW_PACING_IDENTITY, { value: 'credential-fingerprint' });
    const second = await readProviderQuotas({ providers: ['anthropic'], now: f.clock.now, readClaude: async () => later, pacingStore: f.store });
    assert.equal(second.pools.anthropic.advisory.short_window_pacing.status, 'estimated');
    assert.equal(JSON.stringify(second).includes('credential-fingerprint'), false);
  } finally { await f.cleanup(); }
});

test('selected Claude usage keeps its credential fingerprint off the enumerable response', async () => {
  const ctx = { integration: { connection: {
    active: async () => ({ type: 'credential', method: 'oauth' }),
    resolve: async () => ({ type: 'oauth', methodID: 'claude-code', access: 'private-selected-access', metadata: { 'opencode-claude-auth/claude-code-oauth': 'v1' } }),
  } } };
  const usage = await readSelectedClaudeUsage(ctx, async () => ({ checked_at: '2026-10-30T12:00:00.000Z' }));
  assert.equal(typeof usage[SHORT_WINDOW_PACING_IDENTITY], 'string');
  assert.equal(Object.keys(usage).includes(String(SHORT_WINDOW_PACING_IDENTITY)), false);
  assert.equal(JSON.stringify(usage).includes('private-selected-access'), false);
});

test('separate store instances serialize one shared history without losing a concurrent sample', async () => {
  const f = await fixture();
  try {
    const secondStore = createShortWindowPacingStore({ directory: f.directory, now: () => f.clock.now });
    const reset = Date.parse('2026-10-30T17:00:00.000Z');
    await f.store.observe(pool(f.clock, 10, reset), { identity: 'shared' });
    f.clock.now += 10 * 60_000;
    await Promise.all([
      f.store.observe(pool(f.clock, 20, reset), { identity: 'shared' }),
      secondStore.observe(pool(f.clock, 20, reset), { identity: 'shared' }),
    ]);
    f.clock.now += 10 * 60_000;
    const estimate = await secondStore.observe(pool(f.clock, 30, reset), { identity: 'shared' });
    assert.equal(estimate.status, 'estimated');
    assert.equal(estimate.windows[0].usage_change_percent, 10);
  } finally { await f.cleanup(); }
});

test('stale, expired, and too-close observations never produce pacing advice', async () => {
  const f = await fixture();
  try {
    const stale = pool(f.clock, 10);
    stale.checked_at = new Date(f.clock.now - 2 * 60_001).toISOString();
    assert.equal((await f.store.observe(stale, { identity: 'a' })).reason, 'stale_or_invalid');
    const expired = pool(f.clock, 10, f.clock.now - 1);
    assert.equal((await f.store.observe(expired, { identity: 'a' })).reason, 'short_window_unavailable');
    const reset = f.clock.now + 300 * 60_000;
    await f.store.observe(pool(f.clock, 10, reset), { identity: 'a' });
    f.clock.now += 30_000;
    const close = await f.store.observe(pool(f.clock, 20, reset), { identity: 'a' });
    assert.equal(close.status, 'unknown');
    assert.equal(close.windows[0].reason, 'samples_too_close');
  } finally { await f.cleanup(); }
});

test('a projected exhaustion after reset has no misleading exhaustion timestamp', async () => {
  const f = await fixture();
  try {
    const reset = f.clock.now + 30 * 60_000;
    await f.store.observe(pool(f.clock, 10, reset), { identity: 'a' });
    f.clock.now += 10 * 60_000;
    const result = await f.store.observe(pool(f.clock, 11, reset), { identity: 'a' });
    const window = result.windows[0];
    assert.equal(window.status, 'estimated');
    assert.equal(window.reset_before_estimated_exhaustion, true);
    assert.equal(window.estimated_minutes_to_exhaustion, null);
    assert.equal(window.estimated_exhaustion_at, null);
  } finally { await f.cleanup(); }
});

test('history bounds retain no more than 32 account namespaces and eight windows each', async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 33; index++) await f.store.observe(pool(f.clock, 10, f.clock.now + (index + 1) * 60_000), { identity: `account-${index}` });
    f.clock.now += 1;
    for (let index = 0; index < 9; index++) await f.store.observe(pool(f.clock, 10, f.clock.now + (100 + index) * 60_000), { identity: 'window-bound' });
    const history = JSON.parse(await readFile(join(f.directory, 'history.json'), 'utf8'));
    assert.ok(Object.keys(history.accounts).length <= 32);
    const bounded = Object.values(history.accounts).find(account => Object.keys(account.windows).length === 8);
    assert.ok(bounded, 'the namespace with nine distinct windows is trimmed to eight');
  } finally { await f.cleanup(); }
});
