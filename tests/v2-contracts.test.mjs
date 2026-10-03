import test from 'node:test';
import assert from 'node:assert/strict';
import { createV2Guard } from '../plugins/v2/subscription-guard.mjs';
import ModelStatus from '../plugins/v2/model-status.mjs';
import { createV2TaskOutcomes } from '../plugins/v2/task-outcomes.mjs';

function harness(plugin, connection = { type: 'credential', method: 'oauth' },
  credential = { type: 'oauth', methodID: 'chatgpt-headless', metadata: { accountID: 'same-account' } }, events = [],
  inventory = { provider: { package: '@opencode/ai/providers/openai', settings: { baseURL: 'https://chatgpt.com/backend-api/codex' } }, models: [] }) {
  const tools = new Map(), hooks = new Map(), transforms = [];
  const ctx = {
    provider: { transform: async callback => transforms.push(callback) },
    agent: { list: async () => ({ data: inventory.agents ?? [{ id: 'router', name: 'router', mode: 'primary', model: { providerID: 'openai', id: 'gpt-6-luna', variant: 'low' } }] }) },
    model: { list: async () => ({ data: inventory.models }) },
    tool: { transform: async callback => callback({ get: name => name === "subagent" ? { execute: async () => { throw new Error("unused native subagent"); } } : tools.get(name), update: () => {}, add: tool => tools.set(tool.name, tool) }) },
    session: { hook: async (name, callback) => hooks.set(name, callback) },
    integration: { connection: { active: async () => connection, resolve: async () => credential } },
    event: { subscribe: ({ signal }) => ({ async *[Symbol.asyncIterator]() {
      for (const event of events) { if (signal.aborted) break; yield event; }
    } }) },
  };
  ctx.provider.get = async () => ({ data: inventory.provider });
  return plugin.setup(ctx).then(cleanup => ({ tools, hooks, transforms, cleanup }));
}

const event = (providerID = 'openai', kind = 'primary') => ({
  sessionID: 's1', agent: 'builder', kind, model: { providerID, id: 'gpt-6-sol', variant: 'high' },
  headers: {}, baseURL: 'https://chatgpt.com/backend-api/codex',
});
const good = { auth_mode: 'chatgpt', tokens: { account_id: 'same-account' } };
function guard({ codex = good, financial = { auto_top_up_off: true, automatic_reload_off: true, purchased_credit_balance_ui: 0, verified_at: '2026-09-08' },
  env = {}, quota = () => 'ok', recordCompletion } = {}) {
  const writes = [], runs = [], reads = [];
  const plugin = createV2Guard({ readJSON: file => {
    reads.push(file); return file.includes('.codex/auth.json') ? codex : financial;
  }, env, runQuota: (args, options) => { runs.push({ args, options }); return quota(args, options); },
  append: (name, value) => writes.push({ name, value }), recordCompletion: recordCompletion ?? (value => writes.push({ name: 'completions', value })) });
  return { plugin, writes, runs, reads };
}

test('V2 guard registers all model request kinds, both transports and read-only quota tool', async () => {
  const g = guard(); const h = await harness(g.plugin);
  assert.equal(g.plugin.id, 'subscription.guard');
  assert.equal(h.transforms.length, 1);
  const valid = { provider: { package: '@opencode/ai/providers/openai', settings: { baseURL: 'https://chatgpt.com/backend-api/codex' } } };
  assert.doesNotThrow(() => h.transforms[0]({ get: () => valid, remove: () => assert.fail('safe provider removed') }));
  assert.deepEqual([...h.hooks.keys()], ['model.request', 'http.request', 'experimental.ws.handshake']);
  for (const kind of ['primary', 'compaction', 'generate', 'title']) await h.hooks.get('model.request')(event('openai', kind));
  assert.equal(g.writes.length, 4);
  assert.ok(g.runs.every(r => r.args[0] === '--check' && r.options.timeout === 25000 && !('OPENAI_API_KEY' in r.options.env)));
  await h.hooks.get('http.request')({ model: event().model, request: { url: 'https://chatgpt.com/backend-api/codex/responses' } });
  await h.hooks.get('experimental.ws.handshake')({ model: event().model, url: 'wss://chatgpt.com/backend-api/codex/responses' });
  assert.deepEqual(h.tools.get('codex_quota').input.required, undefined);
  assert.match((await h.tools.get('codex_quota').execute({})).content, /ok/);
  assert.equal(g.runs.at(-1).args[0], '--json');
  h.cleanup();
});

test('V2 provider transform removes unsafe early providers without disabling request hooks', async () => {
  const h = await harness(guard().plugin);
  for (const provider of [
    { package: 'aisdk:@ai-sdk/openai', settings: {} },
    { package: '@opencode/ai/providers/openai', settings: { apiKey: 'placeholder' } },
    { package: '@opencode/ai/providers/openai', settings: { baseURL: 'https://api.openai.com/v1' } },
    { package: '@opencode/ai/providers/openai', settings: {}, headers: { Authorization: 'placeholder' } },
  ]) {
    let removed = false;
    assert.doesNotThrow(() => h.transforms[0]({ get: () => ({ provider }), remove: id => { assert.equal(id, 'openai'); removed = true; } }));
    assert.ok(removed);
  }
  h.cleanup();
});

test('V2 quota failures preserve secret-safe process diagnostics and never retry or emit request receipts', async () => {
  for (const [metadata, reason] of [
    [{ status: 1 }, 'policy_denied'],
    [{ status: 2 }, 'telemetry_unavailable'],
    [{ status: null, code: 'ETIMEDOUT', signal: 'SIGTERM' }, 'timeout'],
    [{ status: null, code: 'ENOENT' }, 'process_error'],
    [{ status: null, code: 'EACCES' }, 'process_error'],
    [{ status: null, signal: 'SIGKILL' }, 'terminated'],
    [{ status: 42 }, 'unknown_failure'],
    [{ status: 'private-sentinel', code: 'private-sentinel', signal: 'private-sentinel' }, 'unknown_failure'],
  ]) {
    const childError = Object.assign(new Error('private-sentinel'), metadata, {
      stdout: Buffer.from('private-sentinel'), stderr: Buffer.from('private-sentinel'),
      cause: new Error('private-sentinel'),
    });
    const g = guard({ quota: () => { throw childError; } });
    const h = await harness(g.plugin);
    const operations = [
      () => h.hooks.get('model.request')(event()),
      () => h.hooks.get('http.request')({ model: event().model, request: { url: event().baseURL } }),
      () => h.hooks.get('experimental.ws.handshake')({ model: event().model, url: 'wss://chatgpt.com/backend-api/codex' }),
    ];
    for (const invoke of operations) {
      const before = g.runs.length;
      await assert.rejects(invoke(), error => {
        assert.equal(error.code, 'SUBSCRIPTION_QUOTA_CHECK_FAILED');
        assert.equal(error.detail.reason, reason);
        assert.equal(error.detail.operation, 'check');
        assert.equal(error.detail.timeout_ms, 25000);
        assert.ok(error.detail.elapsed_ms >= 0);
        assert.equal(error.cause, undefined);
        assert.doesNotMatch(error.stack + JSON.stringify(error), /private-sentinel/);
        return true;
      });
      assert.equal(g.runs.length, before + 1, 'one bounded check; no retry/fallback');
    }
    assert.deepEqual(g.writes, []);
    h.cleanup();
  }
});

test('V2 accepts only exact closed-set telemetry diagnostics and still blocks', async () => {
  for (const [stderr, expected] of [
    ['quota unavailable: quota_rpc_failed\n', 'quota_rpc_failed'],
    [Buffer.from('quota unavailable: unexpected_eof\n'), 'unexpected_eof'],
    ['quota unavailable: private_sentinel\n', undefined],
    ['quota unavailable: timeout\nprivate-sentinel', undefined],
  ]) {
    const g = guard({ quota: () => { throw Object.assign(new Error('private-sentinel'), {status: 2, stderr}); } });
    const h = await harness(g.plugin);
    await assert.rejects(h.hooks.get('model.request')(event()), error => {
      assert.equal(error.detail.reason, 'telemetry_unavailable');
      assert.equal(error.detail.telemetry_reason, expected);
      assert.doesNotMatch(error.stack + JSON.stringify(error), /private[-_]sentinel/);
      return true;
    });
    assert.equal(g.runs.length, 1);
    assert.deepEqual(g.writes, []);
    h.cleanup();
  }
});

test('V2 awaits quota checks and rejects asynchronous failure before admission', async () => {
  let settle;
  const g = guard({ quota: () => new Promise((resolve, reject) => { settle = reject; }) });
  const h = await harness(g.plugin);
  let admitted = false;
  const pending = h.hooks.get('model.request')(event()).then(() => { admitted = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(admitted, false);
  assert.deepEqual(g.writes, []);
  settle(Object.assign(new Error('private-sentinel'), { status: 2 }));
  await assert.rejects(pending, /telemetry_unavailable/);
  assert.deepEqual(g.writes, []);
  h.cleanup();
});

test('V2 quota read failures are sanitized and do not claim policy denial', async () => {
  const g = guard({ quota: () => { throw Object.assign(new Error('private-sentinel'), { status: 1 }); } });
  const h = await harness(g.plugin);
  await assert.rejects(h.tools.get('codex_quota').execute({}), error => {
    assert.equal(error.detail.operation, 'read');
    assert.equal(error.detail.reason, 'unknown_failure');
    assert.doesNotMatch(error.stack + JSON.stringify(error), /private-sentinel/);
    return true;
  });
  assert.equal(g.runs.length, 1);
  assert.deepEqual(g.writes, []);
  h.cleanup();
});

test('V2 hooks reject unsafe effective registry even when a later config transform overwrites the early provider', async () => {
  for (const provider of [
    { package: '@opencode/ai/providers/openai', settings: { baseURL: 'https://api.openai.com/v1' } },
    { package: '@opencode/ai/providers/openai', settings: { apiKey: 'placeholder' } },
    { package: 'aisdk:@ai-sdk/openai', settings: {} },
    { package: '@opencode/ai/providers/openai', headers: { Authorization: 'placeholder' } },
  ]) {
    const g = guard(); const h = await harness(g.plugin, undefined, undefined, [], { provider, models: [] });
    await assert.rejects(h.hooks.get('model.request')(event()), /Subscription guard/);
    await assert.rejects(h.hooks.get('http.request')({ model: event().model, request: { url: event().baseURL } }), /Subscription guard/);
    assert.deepEqual(g.writes, []); assert.deepEqual(g.runs, []); h.cleanup();
  }
  for (const models of [
    [{ providerID: 'anthropic', id: 'not-allowed' }],
    [{ providerID: 'openai', id: 'override', settings: { apiKey: 'placeholder' } }],
    [{ providerID: 'openai', id: 'override', variants: [{ headers: { Authorization: 'placeholder' } }] }],
  ]) {
    const g = guard(); const h = await harness(g.plugin, undefined, undefined, [], { provider: { package: '@opencode/ai/providers/openai' }, models });
    await assert.rejects(h.hooks.get('model.request')(event()), /Subscription guard/);
    assert.deepEqual(g.writes, []); h.cleanup();
  }
});

test('V2 denies provider switching before reading credentials, quota, or telemetry', async () => {
  const g = guard(); const h = await harness(g.plugin);
  await assert.rejects(h.hooks.get('model.request')(event('anthropic')), /OpenAI only/);
  await assert.rejects(h.hooks.get('http.request')({ model: event('anthropic').model, request: { url: 'https://chatgpt.com/backend-api/codex' } }), /OpenAI only/);
  await assert.rejects(h.hooks.get('experimental.ws.handshake')({ model: event('anthropic').model, url: 'wss://chatgpt.com/backend-api/codex' }), /OpenAI only/);
  assert.deepEqual(g.reads, []); assert.deepEqual(g.writes, []); assert.deepEqual(g.runs, []);
  h.cleanup();
});

test('V2 transport refuses credential/financial/quota bypass when model-request hook is skipped', async () => {
  for (const [setup, connection] of [
    [guard(), { type: 'env', name: 'OPENAI_API_KEY' }],
    [guard({ financial: {} }), undefined],
    [guard({ quota: () => { throw new Error('no quota'); } }), undefined],
  ]) {
    const h = await harness(setup.plugin, connection);
    await assert.rejects(h.hooks.get('http.request')({ model: event().model, request: { url: 'https://chatgpt.com/backend-api/codex' } }), /Subscription guard/);
    await assert.rejects(h.hooks.get('experimental.ws.handshake')({ model: event().model, url: 'wss://chatgpt.com/backend-api/codex' }), /Subscription guard/);
    assert.equal(setup.writes.length, 0); h.cleanup();
  }
});

test('V2 denies API env and every non-ChatGPT connection including environmental fallback', async () => {
  for (const env of [{ OPENAI_API_KEY: 'placeholder' }, { OPENAI_BASE_URL: 'https://example.invalid' }]) {
    const g = guard({ env }); const h = await harness(g.plugin);
    await assert.rejects(h.hooks.get('model.request')(event()), /API key\/base URL/);
    assert.equal(g.runs.length, 0); h.cleanup();
  }
  for (const [conn, credential] of [
    [{ type: 'env', name: 'OPENAI_API_KEY' }, undefined],
    [{ type: 'credential', method: 'key' }, { type: 'key' }],
    [{ type: 'credential', method: 'oauth' }, { type: 'oauth', methodID: 'other', metadata: { accountID: 'same-account' } }],
    [{ type: 'credential', method: 'oauth' }, { type: 'oauth', methodID: 'chatgpt-browser' }],
  ]) {
    const g = guard(); const h = await harness(g.plugin, conn, credential);
    await assert.rejects(h.hooks.get('model.request')(event()), /OAuth|required|same ChatGPT account/);
    assert.equal(g.runs.length, 0); h.cleanup();
  }
});

test('V2 denies account mismatch, financial controls, and failed quota without emitting request telemetry', async () => {
  const variants = [
    { codex: { auth_mode: 'api_key', tokens: { account_id: 'same-account' } } },
    { codex: { auth_mode: 'chatgpt', tokens: { account_id: 'other' } } },
    { financial: { auto_top_up_off: false, automatic_reload_off: true, purchased_credit_balance_ui: 0, verified_at: 'x' } },
    { financial: { auto_top_up_off: true, automatic_reload_off: true, purchased_credit_balance_ui: 1, verified_at: 'x' } },
    { quota: () => { throw new Error('unavailable'); } },
  ];
  for (const args of variants) {
    const g = guard(args); const h = await harness(g.plugin);
    await assert.rejects(h.hooks.get('model.request')(event()), /Subscription guard/);
    assert.equal(g.writes.length, 0); h.cleanup();
  }
});

test('V2 blocks endpoint rewrite across model, HTTP and WebSocket hooks', async () => {
  const g = guard(); const h = await harness(g.plugin);
  for (const baseURL of ['https://api.openai.com/v1', 'https://chatgpt.com.evil.invalid/backend-api/codex', 'https://chatgpt.com/backend-api/codex?redirect=evil']) {
    await assert.rejects(h.hooks.get('model.request')({ ...event(), baseURL }), /endpoint/);
  await assert.rejects(h.hooks.get('http.request')({ model: event().model, request: { url: baseURL } }), /endpoint/);
  }
  await assert.rejects(h.hooks.get('experimental.ws.handshake')({ model: event().model, url: 'wss://other.invalid/backend-api/codex' }), /endpoint/);
  assert.equal(g.writes.length, 0); h.cleanup();
});

test('V2 transport rejects hostile schemes, URL credentials, fragments, and cross-origin redirects without telemetry', async () => {
  const g = guard(); const h = await harness(g.plugin);
  const http = h.hooks.get('http.request'), ws = h.hooks.get('experimental.ws.handshake');
  for (const url of [
    'http://chatgpt.com/backend-api/codex/responses',
    'https://user:password@chatgpt.com/backend-api/codex/responses',
    'https://chatgpt.com/backend-api/codex/responses#fragment',
    'https://chatgpt.com/backend-api/codex/../other',
    'https://chatgpt.com/backend-api/codex/responses?redirect=https://example.invalid',
  ]) await assert.rejects(http({ model: event().model, request: { url } }), /endpoint/);
  for (const url of [
    'ws://chatgpt.com/backend-api/codex/responses',
    'wss://user:password@chatgpt.com/backend-api/codex/responses',
    'wss://chatgpt.com/backend-api/codex/responses#fragment',
    'wss://example.invalid/backend-api/codex/responses',
  ]) await assert.rejects(ws({ model: event().model, url }), /endpoint/);
  assert.deepEqual(g.writes, []);
  h.cleanup();
});

test('V2 guard fails closed for each request kind on changed account, quota failure, or purchased-credit risk', async () => {
  for (const variant of [
    { codex: { auth_mode: 'chatgpt', tokens: { account_id: 'different-account' } } },
    { quota: () => { throw new Error('quota unavailable'); } },
    { financial: { auto_top_up_off: true, automatic_reload_off: true, purchased_credit_balance_ui: 1, verified_at: 'x' } },
  ]) {
    const g = guard(variant); const h = await harness(g.plugin);
    for (const kind of ['primary', 'compaction', 'generate', 'title'])
      await assert.rejects(h.hooks.get('model.request')(event('openai', kind)), /Subscription guard/);
    assert.deepEqual(g.writes, []);
    h.cleanup();
  }
});

test('V2 outcome and status tools expose V2 structured results without legacy SDK dependency', async () => {
  const rows = [], h = await harness(createV2TaskOutcomes({ append: async row => rows.push(row), now: () => 500 }));
  const output = await h.tools.get('task_outcome').execute({ taskId: 'port', scope: 'checkpoint', status: 'completed', selected: { model: 'openai/gpt-6-sol', effort: 'high' }, escalationReason: 'none' }, { sessionID: 's1', messageID: 'm1', agent: 'builder' });
  assert.match(output.content, /Recorded checkpoint outcome port/);
  assert.equal(rows[0].attribution.actualKnown, false);
  await assert.rejects(h.tools.get('task_outcome').execute({ taskId: 'bad\nid', scope: 'checkpoint', status: 'failed' }, { sessionID: 's1' }), /invalid taskId/);
  h.cleanup();
  const status = await harness(ModelStatus);
  assert.equal(typeof (await status.tools.get('model_status').execute({})).content, 'string');
});

test('V2 event envelope records completion and links actual actor by the exact step message', async () => {
  const started = { type: 'session.step.started', data: { sessionID: 's1', assistantMessageID: 'm1', agent: 'builder', model: { providerID: 'openai', id: 'gpt-6-sol', variant: 'high' } }, created: 100 };
  const ended = { type: 'session.step.ended', data: { sessionID: 's1', assistantMessageID: 'm1', tokens: { input: 12 } }, created: 200 };
  const g = guard(); const h = await harness(g.plugin, undefined, undefined, [started, ended, ended]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(g.writes.filter(row => row.name === 'completions').length, 1);
  assert.equal(g.writes[0].value.tokens.input, 12);
  assert.equal(g.writes[0].value.model, 'gpt-6-sol');
  h.cleanup();
  const rows = []; const outcomes = await harness(createV2TaskOutcomes({ append: async row => rows.push(row) }), undefined, undefined, [started]);
  await new Promise(resolve => setImmediate(resolve));
  await outcomes.tools.get('task_outcome').execute({ taskId: 'port', scope: 'checkpoint', status: 'completed' }, { sessionID: 's1', messageID: 'm1', agent: 'builder' });
  assert.equal(rows[0].attribution.recordingActor.model, 'openai/gpt-6-sol');
  assert.equal(rows[0].attribution.recordingActor.effort, 'high');
  outcomes.cleanup();
});

test('V2 completion telemetry retries once and a failed record does not stop later events', async () => {
  const step = message => ({ type: 'session.step.started', data: { sessionID: 's1', assistantMessageID: message, agent: 'builder', model: { providerID: 'openai', id: 'gpt-6-sol' } } });
  const ended = message => ({ type: 'session.step.ended', data: { sessionID: 's1', assistantMessageID: message, tokens: {} } });
  const calls = [], g = guard({ recordCompletion: async value => {
    calls.push(value.message_id); if (value.message_id === 'm1') throw new Error('private failure');
  } });
  const h = await harness(g.plugin, undefined, undefined, [step('m1'), ended('m1'), step('m2'), ended('m2')]);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['m1', 'm1', 'm2']);
  h.cleanup();
});
