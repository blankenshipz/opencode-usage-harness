import test from 'node:test';
import assert from 'node:assert/strict';
import { createV2Guard } from '../plugins/v2/subscription-guard.mjs';
import { createAnthropicUsageReader } from '../plugins/v2/anthropic-subscription.mjs';
import { CLAUDE_DISABLED_OVERAGE_VERIFICATION_MS, createQuotaCache } from '../plugins/v2/quota-cache.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const codex = { auth_mode: 'chatgpt', tokens: { account_id: 'same-account' } };
const openaiFinancial = { auto_top_up_off: true, automatic_reload_off: true, purchased_credit_balance_ui: 0, verified_at: '2026-10-20' };
const anthropicConnection = { type: 'credential', method: 'oauth' };
const anthropicCredential = { type: 'oauth', methodID: 'claude-code', access: 'fake-access', metadata: { 'opencode-claude-auth/claude-code-oauth': 'v1' } };
const anthropicProvider = { package: '@opencode/ai/providers/anthropic', settings: { baseURL: 'https://api.anthropic.com/v1' } };

function event(providerID = 'anthropic', modelID = 'claude-opus') {
  return { sessionID: 's1', agent: 'builder', kind: 'primary', model: { providerID, id: modelID },
    baseURL: providerID === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://chatgpt.com/backend-api/codex' };
}

async function setup({ env = {}, connection = anthropicConnection, credential = anthropicCredential,
  provider = anthropicProvider, models = [{ providerID: 'anthropic', id: 'claude-opus' }], quota = () => 'ok',
  usage = async () => ({ extra_usage: { is_enabled: false } }), openaiConnection, openaiCredential,
  financialPolicy = () => ({ mode: 'subscription_only' }), clock = { now: Date.parse('2026-10-26T00:00:00.000Z') } } = {}) {
  const hooks = new Map(), quotaCalls = [], reads = [], usageCalls = [];
  const cacheDirectory = await mkdtemp(join(tmpdir(), 'anthropic-guard-cache-'));
  const plugin = createV2Guard({ now: () => new Date(clock.now).toISOString(), env, append: () => {}, recordCompletion: () => {},
    readJSON: file => { reads.push(file); return file.includes('.codex/auth.json') ? codex : openaiFinancial; },
    runQuota: args => { quotaCalls.push(args); return quota(args); },
    readAnthropicUsage: async access => { usageCalls.push(access); return usage(access); },
    readAnthropicPolicy: financialPolicy,
    anthropicQuotaCache: createQuotaCache({ directory: cacheDirectory, now: () => clock.now }) });
  const providers = { anthropic: provider, openai: { package: '@opencode/ai/providers/openai', settings: { baseURL: 'https://chatgpt.com/backend-api/codex' } } };
  const ctx = {
    location: { directory: process.cwd() }, provider: {
      get: async ({ providerID }) => ({ data: providers[providerID] }), transform: async () => {},
    }, model: { list: async () => ({ data: models }) }, tool: { transform: async callback => callback({ add: () => {} }) },
    session: { hook: async (name, callback) => hooks.set(name, callback) },
    integration: { connection: { active: async providerID => providerID === 'anthropic' ? connection : openaiConnection,
      resolve: async value => value === openaiConnection ? openaiCredential : credential } }, event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
  };
  const stop = await plugin.setup(ctx);
  const cleanup = () => { stop(); return rm(cacheDirectory, { recursive: true, force: true }); };
  return { hooks, quotaCalls, reads, usageCalls, cleanup, clock };
}

async function readerFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'anthropic-reader-cache-'));
  return { reader: createAnthropicUsageReader({ cache: createQuotaCache({ directory }) }), cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('Anthropic Claude Code OAuth admits only the Messages API and skips Codex quota checks', async () => {
  const h = await setup();
  await h.hooks.get('model.request')(event());
  await h.hooks.get('http.request')({ model: event().model, request: { url: 'https://api.anthropic.com/v1/messages?beta=true' } });
  assert.equal(h.quotaCalls.length, 0);
  assert.deepEqual(h.usageCalls, ['fake-access']);
  await assert.rejects(h.hooks.get('experimental.ws.handshake')({ model: event().model, url: 'wss://api.anthropic.com/v1/messages' }), /WebSocket/);
  h.cleanup();
});

test('Anthropic accepts only the native root or /v1 base URL', async () => {
  for (const baseURL of ['https://api.anthropic.com', 'https://api.anthropic.com/v1']) {
    const h = await setup({ provider: { ...anthropicProvider, settings: { baseURL } } });
    await h.hooks.get('model.request')({ ...event(), baseURL });
    h.cleanup();
  }
});

test('Anthropic rejects API billing paths, enabled or unavailable usage, unsafe overrides, and other providers', async () => {
  for (const options of [
    { env: { ANTHROPIC_API_KEY: 'fake' } },
    { usage: async () => ({ extra_usage: { is_enabled: true } }) },
    { usage: async () => { throw new Error('private token'); } },
    { connection: { type: 'credential', method: 'key' } },
    { credential: { ...anthropicCredential, metadata: {} } },
    { provider: { ...anthropicProvider, settings: { apiKey: 'fake' } } },
    { models: [{ providerID: 'anthropic', id: 'claude-opus', settings: { authToken: 'fake' } }] },
  ]) {
    const h = await setup(options);
    await assert.rejects(h.hooks.get('model.request')(event()), /Subscription guard/);
    assert.equal(h.quotaCalls.length, 0);
    h.cleanup();
  }
  const h = await setup();
  await assert.rejects(h.hooks.get('http.request')({ model: event().model, request: { url: 'https://api.anthropic.com/v1/complete' } }), /endpoint/);
  await assert.rejects(h.hooks.get('model.request')(event('other')), /supported providers/);
  h.cleanup();
});

test('Anthropic usage telemetry emits safe typed HTTP, timeout, network, and invalid-response diagnostics', async () => {
  const originalFetch = globalThis.fetch;
  const fixtureReader = await readerFixture(); const fetchAnthropicUsage = fixtureReader.reader;
  try {
    const cases = [
      { access: 'http-401', fetch: async () => ({ ok: false, status: 401, headers: { get: () => 'private-header' }, json: async () => ({ error: 'private body' }) }), reason: 'http_error', status: 401 },
      { access: 'rate-limited', fetch: async () => ({ ok: false, status: 429, headers: { get: () => '99999' }, json: async () => ({ error: 'private body' }) }), reason: 'http_error', status: 429, retry: 86400 },
      { access: 'timeout', fetch: async () => { const error = new Error('private token'); error.name = 'TimeoutError'; throw error; }, reason: 'timeout' },
      { access: 'network', fetch: async () => { throw new TypeError('private token'); }, reason: 'network_error' },
      { access: 'invalid', fetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => { throw new Error('private body'); } }), reason: 'invalid_response' },
    ];
    for (const fixture of cases) {
      globalThis.fetch = fixture.fetch;
      await assert.rejects(fetchAnthropicUsage(fixture.access), error => {
        assert.equal(error.code, 'SUBSCRIPTION_ANTHROPIC_USAGE_CHECK_FAILED');
        assert.equal(error.detail.reason, fixture.reason);
        assert.equal(error.detail.http_status, fixture.status);
        assert.equal(error.detail.retry_after_seconds, fixture.retry);
        assert.doesNotMatch(error.stack + JSON.stringify(error), /private/);
        assert.match(error.message, /Admission remains blocked/);
        return true;
      });
    }
  } finally { globalThis.fetch = originalFetch; await fixtureReader.cleanup(); }
});

test('Anthropic coalesces concurrent same-account telemetry reads and only caches a verified response', async () => {
  const originalFetch = globalThis.fetch;
  const fixtureReader = await readerFixture(); const fetchAnthropicUsage = fixtureReader.reader;
  let calls = 0;
  let release;
  try {
    globalThis.fetch = async () => {
      calls++;
      await new Promise(resolve => { release = resolve; });
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ extra_usage: { is_enabled: false } }) };
    };
    const first = fetchAnthropicUsage('coalesced-access');
    const second = fetchAnthropicUsage('coalesced-access');
    while (calls !== 1) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(calls, 1);
    release();
    const [one, two] = await Promise.all([first, second]);
    assert.deepEqual(one, two);
    await fetchAnthropicUsage('coalesced-access');
    assert.equal(calls, 1);

    let invalidCalls = 0;
    globalThis.fetch = async () => {
      invalidCalls++;
      return invalidCalls === 1
        ? { ok: true, status: 200, headers: { get: () => null }, json: async () => { throw new Error('invalid'); } }
        : { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ extra_usage: { is_enabled: false } }) };
    };
    await assert.rejects(fetchAnthropicUsage('retry-after-invalid'), error => error.detail.reason === 'invalid_response');
    await fetchAnthropicUsage('retry-after-invalid');
    assert.equal(invalidCalls, 2, 'a failed response never becomes a cached admission');
  } finally { globalThis.fetch = originalFetch; await fixtureReader.cleanup(); }
});

test('Anthropic guard sanitizes usage diagnostics and coalesces concurrent selected-account checks', async () => {
  let resolveUsage;
  const h = await setup({ usage: async () => new Promise(resolve => { resolveUsage = resolve; }) });
  const first = h.hooks.get('model.request')(event());
  const second = h.hooks.get('http.request')({ model: event().model, request: { url: 'https://api.anthropic.com/v1/messages' } });
  while (h.usageCalls.length !== 1) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(h.usageCalls, ['fake-access']);
  resolveUsage({ extra_usage: { is_enabled: false } });
  await Promise.all([first, second]);
  h.cleanup();

  const typed = Object.assign(new Error('SECRET provider body'), { code: 'SUBSCRIPTION_ANTHROPIC_USAGE_CHECK_FAILED',
    cause: new Error('SECRET provider cause'),
    detail: { operation: 'usage_check', reason: 'http_error', http_status: 401, retry_after_seconds: 99999, extra: 'SECRET provider detail' } });
  const failed = await setup({ usage: async () => { throw typed; } });
  await assert.rejects(failed.hooks.get('model.request')(event()), error => {
    assert.notEqual(error, typed);
    assert.equal(error.detail.http_status, 401);
    assert.equal(error.detail.retry_after_seconds, undefined);
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(error.stack + JSON.stringify(error), /SECRET/);
    return true;
  });
  failed.cleanup();
});

test('Anthropic hook admits stale disabled financial evidence through the 24-hour verification bound and blocks enabled, auth, and applicable exhaustion', async () => {
  const clock = { now: Date.parse('2026-10-26T00:00:00.000Z') }; let calls = 0;
  const failure = transient => Object.assign(new Error('network'), { code: 'SUBSCRIPTION_ANTHROPIC_USAGE_CHECK_FAILED', detail: { reason: 'http_error', http_status: transient } });
  const h = await setup({ clock, usage: async () => ++calls === 1 ? { extra_usage: { is_enabled: false } } : Promise.reject(failure(429)) });
  await h.hooks.get('model.request')(event());
  clock.now += 61_000;
  await h.hooks.get('model.request')(event());
  clock.now = Date.parse('2026-10-26T00:00:00.000Z') + CLAUDE_DISABLED_OVERAGE_VERIFICATION_MS - 1;
  await h.hooks.get('model.request')(event());
  clock.now++;
  await assert.rejects(h.hooks.get('model.request')(event()), /usage verification failed/); h.cleanup();
  for (const usage of [
    async () => ({ extra_usage: { is_enabled: true } }),
    async () => { throw failure(401); },
    async () => ({ extra_usage: { is_enabled: false }, five_hour: { utilization: 100 } }),
    async () => ({ extra_usage: { is_enabled: false }, seven_day: { used_percent: 100 } }),
    async () => ({ extra_usage: { is_enabled: false }, limits: [{ kind: 'weekly_scoped', scope: { model: { family: 'opus' } }, utilization: 100 }] }),
  ]) {
    const current = await setup({ usage });
    await assert.rejects(current.hooks.get('model.request')(event()), /Subscription guard/); current.cleanup();
  }
  const unrelated = await setup({ usage: async () => ({ extra_usage: { is_enabled: false }, limits: [{ kind: 'weekly_scoped', scope: { model: { family: 'sonnet' } }, utilization: 100 }] }) });
  await unrelated.hooks.get('model.request')(event()); unrelated.cleanup();
  const fable = await setup({ usage: async () => ({ extra_usage: { is_enabled: false }, limits: [{ kind: 'weekly_scoped', scope: { model: { family: 'fable' } }, utilization: 100 }] }) });
  await assert.rejects(fable.hooks.get('model.request')(event('anthropic', 'claude-fable-5-1')), /exhausted/); fable.cleanup();
  const scopeFamily = await setup({ usage: async () => ({ extra_usage: { is_enabled: false }, limits: [{ kind: 'weekly_scoped', scope: { model_family: 'fable' }, usedPercent: 100 }] }) });
  await assert.rejects(scopeFamily.hooks.get('model.request')(event('anthropic', 'claude-fable-5-1')), /exhausted/); scopeFamily.cleanup();
  const displayFamily = await setup({ usage: async () => ({ extra_usage: { is_enabled: false }, limits: [{ kind: 'weekly_scoped', display_name: 'Fable', used_percent: 100 }] }) });
  await assert.rejects(displayFamily.hooks.get('model.request')(event('anthropic', 'claude-fable-5-1')), /exhausted/); displayFamily.cleanup();
  const otherVersion = await setup({ usage: async () => ({ extra_usage: { is_enabled: false }, limits: [{ kind: 'weekly_scoped', model: 'claude-fable-4', used_percent: 100 }] }) });
  await otherVersion.hooks.get('model.request')(event('anthropic', 'claude-fable-5-1')); otherVersion.cleanup();
});

test('explicit app-managed Claude credits rely on the provider app cap without a telemetry read', async () => {
  const credits = () => ({ mode: 'app_managed_credits' });
  const h = await setup({ financialPolicy: credits, usage: async () => { throw new Error('telemetry must not gate credits'); } });
  await h.hooks.get('model.request')(event());
  assert.equal(h.quotaCalls.length, 0);
  assert.deepEqual(h.usageCalls, []);
  await h.cleanup();
});

test('app-managed credit mode preserves OAuth and provider validation', async () => {
  const h = await setup({ financialPolicy: () => ({ mode: 'app_managed_credits' }),
    credential: { ...anthropicCredential, metadata: {} } });
  await assert.rejects(h.hooks.get('model.request')(event()), /Claude Code OAuth is required/);
  await h.cleanup();
});

test('Anthropic guard rejects a slow transient refresh that crosses the exact 24-hour verification boundary', async () => {
  const started = Date.parse('2026-10-26T00:00:00.000Z');
  const clock = { now: started }; let calls = 0;
  const h = await setup({ clock, usage: async () => {
    if (++calls === 1) return { extra_usage: { is_enabled: false } };
    clock.now = started + CLAUDE_DISABLED_OVERAGE_VERIFICATION_MS;
    throw Object.assign(new Error('network'), { code: 'SUBSCRIPTION_ANTHROPIC_USAGE_CHECK_FAILED', detail: { reason: 'http_error', http_status: 503 } });
  } });
  try {
    await h.hooks.get('model.request')(event());
    clock.now = started + CLAUDE_DISABLED_OVERAGE_VERIFICATION_MS - 1;
    await assert.rejects(h.hooks.get('model.request')(event()), /usage verification failed/);
  } finally { h.cleanup(); }
});

test('OpenAI continues through its existing Codex quota path when Anthropic is present in the inventory', async () => {
  const h = await setup({ models: [{ providerID: 'openai', id: 'gpt' }, { providerID: 'anthropic', id: 'claude-opus' }],
    openaiConnection: { type: 'credential', method: 'oauth' },
    openaiCredential: { type: 'oauth', methodID: 'chatgpt-headless', metadata: { accountID: 'same-account' } } });
  await h.hooks.get('model.request')(event('openai'));
  assert.deepEqual(h.quotaCalls, [['--check']]);
  assert.ok(h.reads.some(file => file.endsWith('financial-verification.json') && !file.includes('anthropic-')));
  h.cleanup();
});
