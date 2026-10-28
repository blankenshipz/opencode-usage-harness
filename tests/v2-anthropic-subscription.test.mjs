import test from 'node:test';
import assert from 'node:assert/strict';
import { createV2Guard } from '../plugins/v2/subscription-guard.mjs';
import { fetchAnthropicUsage } from '../plugins/v2/anthropic-subscription.mjs';

const codex = { auth_mode: 'chatgpt', tokens: { account_id: 'same-account' } };
const openaiFinancial = { auto_top_up_off: true, automatic_reload_off: true, purchased_credit_balance_ui: 0, verified_at: '2026-10-20' };
const anthropicConnection = { type: 'credential', method: 'oauth' };
const anthropicCredential = { type: 'oauth', methodID: 'claude-code', access: 'fake-access', metadata: { 'opencode-claude-auth/claude-code-oauth': 'v1' } };
const anthropicProvider = { package: '@opencode/ai/providers/anthropic', settings: { baseURL: 'https://api.anthropic.com/v1' } };

function event(providerID = 'anthropic') {
  return { sessionID: 's1', agent: 'builder', kind: 'primary', model: { providerID, id: 'claude-opus' },
    baseURL: providerID === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://chatgpt.com/backend-api/codex' };
}

async function setup({ env = {}, connection = anthropicConnection, credential = anthropicCredential,
  provider = anthropicProvider, models = [{ providerID: 'anthropic', id: 'claude-opus' }], quota = () => 'ok',
  usage = async () => ({ extra_usage: { is_enabled: false } }), openaiConnection, openaiCredential } = {}) {
  const hooks = new Map(), quotaCalls = [], reads = [], usageCalls = [];
  const plugin = createV2Guard({ now: () => '2026-10-26T00:00:00.000Z', env, append: () => {}, recordCompletion: () => {},
    readJSON: file => { reads.push(file); return file.includes('.codex/auth.json') ? codex : openaiFinancial; },
    runQuota: args => { quotaCalls.push(args); return quota(args); },
    readAnthropicUsage: async access => { usageCalls.push(access); return usage(access); } });
  const providers = { anthropic: provider, openai: { package: '@opencode/ai/providers/openai', settings: { baseURL: 'https://chatgpt.com/backend-api/codex' } } };
  const ctx = {
    location: { directory: process.cwd() }, provider: {
      get: async ({ providerID }) => ({ data: providers[providerID] }), transform: async () => {},
    }, model: { list: async () => ({ data: models }) }, tool: { transform: async callback => callback({ add: () => {} }) },
    session: { hook: async (name, callback) => hooks.set(name, callback) },
    integration: { connection: { active: async providerID => providerID === 'anthropic' ? connection : openaiConnection,
      resolve: async value => value === openaiConnection ? openaiCredential : credential } }, event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
  };
  const cleanup = await plugin.setup(ctx);
  return { hooks, quotaCalls, reads, usageCalls, cleanup };
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
  try {
    const cases = [
      { access: 'http-401', fetch: async () => ({ ok: false, status: 401, headers: { get: () => 'private-header' }, json: async () => ({ error: 'private body' }) }), reason: 'http_error', status: 401 },
      { access: 'rate-limited', fetch: async () => ({ ok: false, status: 429, headers: { get: () => '99999' }, json: async () => ({ error: 'private body' }) }), reason: 'http_error', status: 429, retry: 600 },
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
  } finally { globalThis.fetch = originalFetch; }
});

test('Anthropic coalesces concurrent same-account telemetry reads and only caches a verified response', async () => {
  const originalFetch = globalThis.fetch;
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
    await new Promise(resolve => setImmediate(resolve));
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
  } finally { globalThis.fetch = originalFetch; }
});

test('Anthropic guard sanitizes usage diagnostics and coalesces concurrent selected-account checks', async () => {
  let resolveUsage;
  const h = await setup({ usage: async () => new Promise(resolve => { resolveUsage = resolve; }) });
  const first = h.hooks.get('model.request')(event());
  const second = h.hooks.get('http.request')({ model: event().model, request: { url: 'https://api.anthropic.com/v1/messages' } });
  await new Promise(resolve => setImmediate(resolve));
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

test('OpenAI continues through its existing Codex quota path when Anthropic is present in the inventory', async () => {
  const h = await setup({ models: [{ providerID: 'openai', id: 'gpt' }, { providerID: 'anthropic', id: 'claude-opus' }],
    openaiConnection: { type: 'credential', method: 'oauth' },
    openaiCredential: { type: 'oauth', methodID: 'chatgpt-headless', metadata: { accountID: 'same-account' } } });
  await h.hooks.get('model.request')(event('openai'));
  assert.deepEqual(h.quotaCalls, [['--check']]);
  assert.ok(h.reads.some(file => file.endsWith('financial-verification.json') && !file.includes('anthropic-')));
  h.cleanup();
});
