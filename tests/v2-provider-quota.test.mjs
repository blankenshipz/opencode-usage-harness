import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeClaudeQuota, normalizeCodexQuota, readProviderQuotas, catalogProviders } from '../plugins/v2/provider-quota.mjs';

const now = Date.parse('2026-10-26T12:00:00.000Z');

test('normalizes Claude public fields, scoped weekly limits, inferred durations, and deduplicates', () => {
  const result = normalizeClaudeQuota({
    checked_at: new Date(now).toISOString(),
    five_hour: { utilization: 1, resets_at: new Date(now + 90_000).toISOString() },
    seven_day: { utilization: 42, resets_at: new Date(now + 2_000_000).toISOString() },
    limits: [
      { kind: 'weekly_scoped', scope: { model: { id: 'fable', display_name: 'Fable' } }, percent: 100, resets_at: now + 2_000_000 },
      { kind: 'weekly_scoped', scope: { model: { id: 'fable', display_name: 'Fable' } }, percent: 100, resets_at: now + 2_000_000 },
    ],
    extra_usage: { is_enabled: false },
  }, { now });
  assert.equal(result.availability, 'available');
  assert.equal(result.financial.extra_usage_enabled, false);
  assert.equal(result.windows.length, 3);
  assert.deepEqual(result.windows.map(w => w.duration_minutes), [300, 10080, 10080]);
  assert.ok(result.windows.every(w => w.duration_source === 'inferred'));
  assert.equal(result.windows[2].scope, 'model');
  assert.equal(result.windows[0].used_percent, 1);
  assert.equal(result.windows[2].model, 'Fable');
  assert.equal(result.windows[2].allowance_percent_of_weekly, null);
  assert.equal(result.availability, 'available', 'scoped exhaustion does not block account windows');
});

test('missing Claude fields remain unknown and inactive metadata is preserved', () => {
  const result = normalizeClaudeQuota({ checked_at: new Date(now).toISOString(), is_active: false, seven_day: {} }, { now });
  assert.equal(result.availability, 'unknown');
  assert.equal(result.windows.length, 0);
  assert.equal(result.financial.extra_usage_enabled, null);
});

test('a fresh zero-use Claude session without a reset is explicitly idle and does not veto weekly availability', () => {
  const payload = {
    checked_at: new Date(now).toISOString(), extra_usage: { is_enabled: false },
    five_hour: { utilization: 0, resets_at: null, locked_reason: null },
    seven_day: { utilization: 20, resets_at: new Date(now + 2_000_000).toISOString() },
  };
  const result = normalizeClaudeQuota(payload, { now });
  assert.equal(result.availability, 'available');
  assert.deepEqual(result.windows[0].reset_state, 'unstarted');
  assert.equal(result.windows[0].resets_at, null);
  assert.equal(result.windows[0].pace_delta, null);
  delete payload.five_hour.resets_at;
  assert.equal(normalizeClaudeQuota(payload, { now }).windows[0].reset_state, 'unstarted');
  payload.five_hour.scope = { account: 'selected' };
  assert.equal(normalizeClaudeQuota(payload, { now }).windows[0].reset_state, 'unstarted');
});

test('only a literal absent reset on an unlocked zero-use account session is idle', () => {
  const base = { checked_at: new Date(now).toISOString(), extra_usage: { is_enabled: false }, seven_day: { utilization: 20, resets_at: new Date(now + 2_000_000).toISOString() } };
  for (const five_hour of [
    { utilization: 1, resets_at: null },
    { utilization: -1, resets_at: null },
    { utilization: '0', resets_at: null },
    { utilization: '', resets_at: null },
    { utilization: false, resets_at: null },
    { utilization: 0, resets_at: new Date(now - 1).toISOString() },
    { utilization: 0, resets_at: 'invalid' },
    { utilization: 0, resets_at: null, locked_reason: 'locked' },
    { utilization: 0, resets_at: null, locked_reason: '' },
    { utilization: 0, resets_at: null, locked_reason: false },
    { utilization: 0, resets_at: null, locked_reason: {} },
  ]) {
    const result = normalizeClaudeQuota({ ...base, five_hour }, { now });
    const session = result.windows.find(window => window.kind === 'session');
    assert.notEqual(session?.reset_state, 'unstarted');
    // Existing normalization drops malformed usage with no reset; this test
    // only verifies that it cannot become the new idle-session exception.
    const recognizedLock = typeof five_hour.locked_reason === 'string' && five_hour.locked_reason.length > 0;
    assert.equal(result.availability, recognizedLock ? 'unavailable' : session ? 'unknown' : 'available');
  }
});

test('idle session evidence cannot hide scoped or conflicting session limits', () => {
  const base = {
    checked_at: new Date(now).toISOString(), extra_usage: { is_enabled: false },
    five_hour: { utilization: 0, resets_at: null, locked_reason: null },
    seven_day: { utilization: 20, resets_at: new Date(now + 2_000_000).toISOString() },
  };
  const scoped = normalizeClaudeQuota({ ...base, limits: [{ kind: 'session', scope: { model: { id: 'sonnet' } }, utilization: 0, resets_at: null }] }, { now });
  assert.equal(scoped.availability, 'unknown');
  assert.equal(scoped.windows.length, 3);
  assert.equal(scoped.windows.at(-1).reset_state, null);
  for (const limit of [
    { kind: 'session', utilization: 1, resets_at: null },
    { kind: 'session', utilization: 0, resets_at: 'bad-reset' },
    { kind: 'session', utilization: 0, resets_at: null, locked_reason: 'locked' },
  ]) {
    const result = normalizeClaudeQuota({ ...base, limits: [limit] }, { now });
    assert.equal(result.windows.length, 3);
    assert.equal(result.availability, limit.locked_reason ? 'unavailable' : 'unknown');
  }
});

test('idle-session provenance rejects malformed top-level scopes and display hints', () => {
  const base = {
    checked_at: new Date(now).toISOString(), extra_usage: { is_enabled: false },
    seven_day: { utilization: 20, resets_at: new Date(now + 2_000_000).toISOString() },
  };
  for (const scope of [{}, 17, [], { account: false, model: { id: 'sonnet' } }]) {
    const result = normalizeClaudeQuota({ ...base, five_hour: { utilization: 0, resets_at: null, scope } }, { now });
    assert.equal(result.availability, 'unknown');
    assert.notEqual(result.windows[0].reset_state, 'unstarted');
  }
  const displayHint = normalizeClaudeQuota({ ...base, five_hour: { utilization: 0, resets_at: null, display_name: 'Sonnet' } }, { now });
  assert.equal(displayHint.availability, 'unknown');
  assert.notEqual(displayHint.windows[0].reset_state, 'unstarted');
});

test('normalizes Codex windows and preserves separate pool failure', async () => {
  const codex = normalizeCodexQuota({
    checked_at: new Date(now).toISOString(), credit_risk: 'none',
    buckets: [{ windows: [{ name: 'primary', kind: 'short', duration_minutes: 300, used_percent: 20, remaining_percent: 80, resets_at: now + 100000 }] }],
  }, { now });
  assert.equal(codex.availability, 'available');
  assert.equal(codex.financial.payg, null);
  assert.equal(codex.credit_risk, 'none');
  assert.equal(codex.windows[0].duration_source, 'reported');
  const combined = await readProviderQuotas({ now, readCodex: async () => ({ checked_at: new Date(now).toISOString(), buckets: [] }), readClaude: async () => { throw new Error('network details must not escape'); } });
  assert.equal(combined.pools.openai.provider, 'openai');
  assert.equal(combined.pools.anthropic.reason, 'read_failed');
  assert.equal(JSON.stringify(combined).includes('network details'), false);
});

test('stale data is unknown rather than zero', () => {
  const result = normalizeCodexQuota({ checked_at: new Date(now - 300_000).toISOString(), buckets: [] }, { now });
  assert.equal(result.availability, 'unknown');
  assert.deepEqual(result.windows, []);
});

test('stale Claude recovery evidence remains stale for routing and exposes only its sanitized status', () => {
  const result = normalizeClaudeQuota({
    checked_at: new Date(now - 61_000).toISOString(), extra_usage: { is_enabled: false },
    quota_cache: { stale: true, verified_at: now - 61_000, cooldown_until: now + 1_000, error: 'http_error', http_status: 429 },
  }, { now });
  assert.equal(result.reason, 'stale_or_invalid');
  assert.equal(result.cache.stale, true);
  assert.equal(result.cache.http_status, 429);
});

test('live inactive limit metadata does not deny a valid paid account', () => {
  const result = normalizeClaudeQuota({
    checked_at: new Date(now).toISOString(),
    five_hour: { utilization: 0, resets_at: now + 100000, is_active: false },
    seven_day: { utilization: 0, resets_at: now + 200000, is_active: false },
    limits: [{ kind: 'weekly_all', percent: 0, resets_at: now + 200000, is_active: false },
      { kind: 'weekly_scoped', scope: { model: { id: 'fable', display_name: 'Fable' } }, percent: 100, resets_at: now + 200000, is_active: false }],
    extra_usage: { is_enabled: false },
  }, { now });
  assert.equal(result.availability, 'available');
  assert.equal(result.windows[0].is_active, false);
  assert.equal(result.windows.at(-1).used_percent, 100);
});

test('explicit account-window kind takes precedence over scope/display metadata',()=>{
 const result=normalizeClaudeQuota({checked_at:new Date().toISOString(),extra_usage:{is_enabled:false},limits:[{kind:'session',scope:{account:'selected'},display_name:'Current session',utilization:1,resets_at:new Date(Date.now()+3600000).toISOString()}]});
 assert.equal(result.windows[0].kind,'session');assert.equal(result.windows[0].scope,'account');assert.equal(result.availability,'available');assert.equal(result.windows[0].used_percent,1);
});

test('single-pool telemetry never invokes the absent provider reader',async()=>{
 for(const provider of ['openai','anthropic']) {
  const calls=[];const result=await readProviderQuotas({providers:[provider],readCodex:async()=>{calls.push('openai');if(provider!=='openai')throw new Error('absent CLI must not run');return {checked_at:new Date().toISOString(),buckets:[]};},readClaude:async()=>{calls.push('anthropic');if(provider!=='anthropic')throw new Error('absent OAuth must not resolve');return {extra_usage:{is_enabled:false}};}});
  assert.deepEqual(calls,[provider]);assert.deepEqual(Object.keys(result.pools),[provider]);
 }
});
test('unknown enabled pool never triggers another pool reader or fallback',async()=>{
 const result=await readProviderQuotas({providers:['anthropic'],readClaude:async()=>{throw new Error('private-error');},readCodex:async()=>{assert.fail('must not query Codex');}});
 assert.equal(result.pools.anthropic.availability,'unknown');assert.equal(result.pools.openai,undefined);assert.ok(!JSON.stringify(result).includes('private-error'));
});

test('catalog selection deduplicates enabled supported providers and rejects missing inventory',()=>{
 assert.deepEqual(catalogProviders([{providerID:'anthropic'},{providerID:'anthropic'},{providerID:'openai',enabled:false},{providerID:'other'},null]),['anthropic']);
 assert.throws(()=>catalogProviders(undefined),/catalog unavailable/);
});
