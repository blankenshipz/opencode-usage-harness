import test from 'node:test';
import assert from 'node:assert/strict';
import { createV2Guard } from '../plugins/v2/subscription-guard.mjs';

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

test('OpenAI continues through its existing Codex quota path when Anthropic is present in the inventory', async () => {
  const h = await setup({ models: [{ providerID: 'openai', id: 'gpt' }, { providerID: 'anthropic', id: 'claude-opus' }],
    openaiConnection: { type: 'credential', method: 'oauth' },
    openaiCredential: { type: 'oauth', methodID: 'chatgpt-headless', metadata: { accountID: 'same-account' } } });
  await h.hooks.get('model.request')(event('openai'));
  assert.deepEqual(h.quotaCalls, [['--check']]);
  assert.ok(h.reads.some(file => file.endsWith('financial-verification.json') && !file.includes('anthropic-')));
  h.cleanup();
});
