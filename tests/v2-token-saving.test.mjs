import test from 'node:test';
import assert from 'node:assert/strict';
import { selectDispatchModel, justCompacted, childCacheState, effortTarget } from '../plugins/v2/dispatch-routing.mjs';
import { mergeTokenSavingConfig, loadTokenSavingConfig, TOKEN_SAVING_DEFAULTS, resetTokenSavingState, setTokenSavingSink } from '../plugins/v2/token-saving.mjs';

const cfg = (over = {}) => ({ ...mergeTokenSavingConfig({}, {}), ...over });
const catalog = [
  { providerID: 'anthropic', id: 'sonnet', variants: ['low', 'medium', 'high'] },
  { providerID: 'anthropic', id: 'haiku', variants: ['low', 'medium'] },
  { providerID: 'anthropic', id: 'opus', variants: ['medium', 'high'] },
];
const ahead = { checked_at: new Date().toISOString(), pools: { anthropic: { checked_at: new Date().toISOString(), windows: [{ scope: 'account', pace_delta: 60, remaining_percent: 30 }] } }, catalog };
const builder = { id: 'builder', model: 'anthropic/sonnet#medium' };
const agents = [builder, { id: 'quick-builder', model: 'anthropic/haiku#low' }, { id: 'scout', model: 'anthropic/haiku#medium' }, { id: 'reviewer', model: 'anthropic/opus#medium' }];
const routine = { complexity: 'routine', risk: 'normal' };
const now = 1_800_000_000_000;

// ---- config ----
test('config: defaults, file merge, invalid sections and env kill switches', () => {
  const d = mergeTokenSavingConfig(undefined, {});
  assert.equal(d.cacheKeep.enabled, true); assert.equal(d.parentCacheTtl.ttlSeconds, 3600);
  assert.equal(d.observationMasking.triggerTokens, 80000); assert.equal(d.effort.roles.scout, 'low');
  const m = mergeTokenSavingConfig({ observationMasking: { triggerTokens: 60000 }, effort: { complexity: { standard: 'high' } }, parentCacheTtl: { ttlSeconds: 7 } }, {});
  assert.equal(m.observationMasking.triggerTokens, 60000); assert.equal(m.observationMasking.keepRecentTurns, 8);
  assert.equal(m.effort.complexity.standard, 'high'); assert.equal(m.effort.complexity.routine, 'low');
  assert.equal(m.parentCacheTtl.ttlSeconds, 3600); assert.deepEqual(m.invalid, ['parentCacheTtl']);
  assert.equal(mergeTokenSavingConfig({}, { HARNESS_TOKEN_SAVING: 'off' }).effort.enabled, false);
  const one = mergeTokenSavingConfig({}, { HARNESS_OBSERVATION_MASKING: 'off' });
  assert.equal(one.observationMasking.enabled, false); assert.equal(one.cacheKeep.enabled, true);
});
test('config: file is hot-reloaded by mtime and unreadable JSON falls back to defaults', () => {
  resetTokenSavingState(); const logs = []; const prev = setTokenSavingSink(r => logs.push(r));
  try {
    let content = '{"cacheKeep":{"warmMs":1000}}', mtime = 1;
    const io = { file: '/x/token-saving.json', env: {}, stat: () => ({ mtimeMs: mtime, size: content.length }), readFile: () => content };
    assert.equal(loadTokenSavingConfig(io).cacheKeep.warmMs, 1000);
    content = '{"cacheKeep":{"warmMs":2000}}'; mtime = 2;
    assert.equal(loadTokenSavingConfig(io).cacheKeep.warmMs, 2000);
    content = 'not json'; mtime = 3;
    assert.equal(loadTokenSavingConfig(io).cacheKeep.warmMs, TOKEN_SAVING_DEFAULTS.cacheKeep.warmMs);
    assert.ok(logs.some(r => r.event === 'config_invalid'));
    assert.equal(loadTokenSavingConfig({ ...io, stat: () => { throw Object.assign(new Error(), { code: 'ENOENT' }); } }).effort.enabled, true);
  } finally { setTokenSavingSink(prev); resetTokenSavingState(); }
});

// ---- K: cache-aware continuations ----
test('K: a warm child is not switched to a paced-down model; the suppression is logged and recorded', () => {
  const logs = [];
  const child = { id: 'ses_c', active: false, model: 'anthropic/sonnet#medium', contextObservedAt: now - 60_000 };
  // Legacy record (no routing) would otherwise adopt the demoted quick-builder model.
  const r = selectDispatchModel({ input: { agent: 'builder', routing: routine }, agent: builder, agents, record: {}, child, quota: ahead, now, tokenSaving: cfg(), log: x => logs.push(x) });
  assert.equal(r.selected, 'anthropic/sonnet#medium'); assert.equal(r.source, 'cache_keep');
  assert.equal(r.cacheKeep.suppressed, 'anthropic/haiku#low'); assert.equal(r.cacheKeep.reason, 'child_warm');
  assert.equal(logs[0].event, 'model_switch_suppressed');
});
test('K: a running child is kept; a cold child, explicit model, reset or disabled switch may change', () => {
  const base = { input: { agent: 'builder', routing: routine }, agent: builder, agents, record: {}, quota: ahead, now, log: () => {} };
  const running = selectDispatchModel({ ...base, child: { active: true, model: 'anthropic/sonnet#medium' }, tokenSaving: cfg() });
  assert.equal(running.cacheKeep.reason, 'child_running');
  const cold = selectDispatchModel({ ...base, child: { active: false, model: 'anthropic/sonnet#medium', contextObservedAt: now - 6 * 60_000 }, tokenSaving: cfg() });
  assert.equal(cold.selected, 'anthropic/haiku#low'); assert.equal(cold.cacheKeep, undefined);
  const warm = { active: false, model: 'anthropic/sonnet#medium', contextObservedAt: now - 1000 };
  assert.equal(selectDispatchModel({ ...base, input: { ...base.input, model: 'anthropic/opus#high' }, child: warm, tokenSaving: cfg() }).selected, 'anthropic/opus#high');
  assert.equal(selectDispatchModel({ ...base, input: { ...base.input, resetModel: true }, child: warm, tokenSaving: cfg() }).source, 'pace_routine');
  const disabled = mergeTokenSavingConfig({}, { HARNESS_CACHE_KEEP: 'off', HARNESS_EFFORT_MAP: 'off' });
  assert.equal(selectDispatchModel({ ...base, child: warm, tokenSaving: disabled }).selected, 'anthropic/haiku#low');
});
test('K: parent roles use the 1h warm window', () => {
  const coord = { id: 'coordinator', model: 'anthropic/sonnet#medium' };
  const child = { active: false, model: 'anthropic/opus#high', contextObservedAt: now - 30 * 60_000 };
  const r = selectDispatchModel({ input: { agent: 'coordinator' }, agent: coord, agents: [coord], record: {}, child, quota: ahead, now, tokenSaving: cfg(), log: () => {} });
  assert.equal(r.selected, 'anthropic/opus#high'); assert.equal(r.source, 'cache_keep');
  const b = selectDispatchModel({ input: { agent: 'builder' }, agent: builder, agents, record: {}, child, quota: ahead, now, tokenSaving: cfg(), log: () => {} });
  assert.equal(b.selected, 'anthropic/sonnet#medium');
});
test('K: right after a compaction pacing applies again to the same child', () => {
  const record = { state: 'awaiting_continuation', compactionID: 'msg_1', compactionOutcome: { id: 'msg_1', status: 'completed' }, routing: { selected: 'anthropic/sonnet#medium' } };
  const child = { active: false, model: 'anthropic/sonnet#medium', contextObservedAt: now - 1000 };
  assert.equal(justCompacted(record, child), true);
  const r = selectDispatchModel({ input: { agent: 'builder', routing: routine }, agent: builder, agents, record, child, quota: ahead, now, tokenSaving: cfg(), log: () => {} });
  assert.equal(r.selected, 'anthropic/haiku#low'); assert.deepEqual(r.postCompactionReroute, { from: 'anthropic/sonnet#medium', to: 'anthropic/haiku#low' });
  // Without the compaction the admitted route is kept (continuation affinity).
  const kept = selectDispatchModel({ input: { agent: 'builder', routing: routine }, agent: builder, agents, record: { routing: record.routing }, child, quota: ahead, now, tokenSaving: cfg(), log: () => {} });
  assert.equal(kept.selected, 'anthropic/sonnet#medium');
  assert.equal(justCompacted({ ...record, state: 'running' }, child), false);
  assert.equal(childCacheState({ active: false, contextObservedAt: (now - 1000) / 1000 }, { now, windowMs: 5000 }).state, 'warm');
});

// ---- C: effort from routing complexity ----
test('C: new dispatches map complexity to effort on the same model', () => {
  const base = { agent: builder, agents, record: {}, quota: { ...ahead, pools: {} }, now, tokenSaving: cfg(), log: () => {} };
  const r = selectDispatchModel({ ...base, input: { agent: 'builder', routing: { complexity: 'complex', risk: 'normal' } } });
  assert.equal(r.selected, 'anthropic/sonnet#high'); assert.equal(r.effortMap.applied, true); assert.equal(r.effortMap.basis, 'complexity');
  assert.equal(selectDispatchModel({ ...base, input: { agent: 'builder', routing: routine } }).selected, 'anthropic/sonnet#low');
  assert.equal(selectDispatchModel({ ...base, input: { agent: 'builder', routing: { complexity: 'standard', risk: 'normal' } } }).selected, 'anthropic/sonnet#medium');
  const risky = selectDispatchModel({ ...base, input: { agent: 'builder', routing: { complexity: 'routine', risk: 'high' } } });
  assert.equal(risky.selected, 'anthropic/sonnet#medium'); assert.equal(risky.effortMap.reason, 'high_risk_keeps_effort');
  assert.equal(selectDispatchModel({ ...base, input: { agent: 'builder', routing: routine, model: 'anthropic/sonnet#high' } }).selected, 'anthropic/sonnet#high');
});
test('C: role and tier mapping (scout low, STRONG high); unavailable variants and continuations unchanged', () => {
  const base = { agents, record: {}, quota: { ...ahead, pools: {} }, now, tokenSaving: cfg(), log: () => {} };
  assert.equal(selectDispatchModel({ ...base, agent: agents[2], input: { agent: 'scout', routing: { complexity: 'complex', risk: 'normal' } } }).selected, 'anthropic/haiku#low');
  assert.equal(selectDispatchModel({ ...base, agent: agents[3], input: { agent: 'reviewer', routing: routine } }).selected, 'anthropic/opus#high');
  assert.equal(effortTarget({ input: { agent: 'harness-maximum' }, config: cfg().effort }).effort, 'high');
  const noLow = selectDispatchModel({ ...base, agent: agents[3], input: { agent: 'reviewer' }, tokenSaving: mergeTokenSavingConfig({ effort: { tiers: { STRONG: 'low' } } }, {}) });
  assert.equal(noLow.selected, 'anthropic/opus#medium'); assert.equal(noLow.effortMap.reason, 'variant_unavailable');
  const cont = selectDispatchModel({ ...base, agent: builder, input: { agent: 'builder', routing: { complexity: 'complex', risk: 'normal' } }, record: { routing: { selected: 'anthropic/sonnet#medium' } }, child: { active: false } });
  assert.equal(cont.selected, 'anthropic/sonnet#medium'); assert.equal(cont.effortMap, undefined);
  assert.equal(selectDispatchModel({ ...base, agent: builder, input: { agent: 'builder', routing: routine }, tokenSaving: mergeTokenSavingConfig({}, { HARNESS_EFFORT_MAP: 'off' }) }).selected, 'anthropic/sonnet#medium');
  assert.equal(selectDispatchModel({ ...base, agent: builder, quota: { pools: {} }, input: { agent: 'builder', routing: routine } }).selected, 'anthropic/sonnet#medium');
});

// ---- B: 1h TTL for parent sessions ----
import { rewriteCacheTtl, parentTtlApplies, installParentCacheTtl } from '../plugins/v2/parent-cache-ttl.mjs';
const anthropicBody = () => ({ model: 'claude-opus-5-5', tools: [{ name: 'a' }, { name: 'b', cache_control: { type: 'ephemeral' } }],
  system: [{ type: 'text', text: 'base', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'proj', cache_control: { type: 'ephemeral' } }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }, { role: 'assistant', content: [{ type: 'text', text: 'ok', cache_control: { type: 'ephemeral' } }] }] });
function hookCtx() {
  const hooks = {};
  return { hooks, session: { hook: async (name, fn) => { (hooks[name] ??= []).push(fn); } } };
}
const ttlConfig = (over = {}) => () => ({ parentCacheTtl: { ...mergeTokenSavingConfig({}, {}).parentCacheTtl, ...over } });
test('B: rewrites only the existing breakpoints to ttl 1h, never adds one', () => {
  const body = anthropicBody();
  assert.deepEqual(rewriteCacheTtl(body), { changed: 4, present: 4 });
  const all = [body.tools[1], ...body.system, body.messages[1].content[0]].map(x => x.cache_control);
  assert.ok(all.every(cc => cc.type === 'ephemeral' && cc.ttl === '1h'));
  assert.equal(body.tools[0].cache_control, undefined); assert.equal(body.cache_control, undefined);
  assert.equal(rewriteCacheTtl(body).changed, 0);
  const adapted = anthropicBody(); adapted.system.unshift({ type: 'text', text: 'x-anthropic-billing-header: cc_version=1' });
  assert.equal(rewriteCacheTtl(adapted).unsupported, 'after_subscription_adapter');
  assert.equal(rewriteCacheTtl({}).unsupported, 'not_messages_body');
});
test('B: applies to router/coordinator primary Anthropic requests only', () => {
  const config = mergeTokenSavingConfig({}, {}).parentCacheTtl;
  const event = { model: { providerID: 'anthropic' }, agent: 'harness-router', kind: 'primary' };
  assert.equal(parentTtlApplies(event, config), true);
  assert.equal(parentTtlApplies({ ...event, agent: 'coordinator' }, config), true);
  assert.equal(parentTtlApplies({ ...event, agent: 'harness-builder' }, config), false);
  assert.equal(parentTtlApplies({ ...event, kind: 'compaction' }, config), false);
  assert.equal(parentTtlApplies({ ...event, model: { providerID: 'openai' } }, config), false);
  assert.equal(parentTtlApplies(event, { ...config, enabled: false }), false);
  assert.equal(parentTtlApplies(event, { ...config, ttlSeconds: 300 }), false);
});
test('B: the http.request hook replaces the body for parents; workers and adapted requests are untouched', async () => {
  const ctx = hookCtx(), logs = [];
  await installParentCacheTtl(ctx, { loadConfig: ttlConfig(), log: r => logs.push(r), once: (k, r) => logs.push(r) });
  const make = body => new Request('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '5' }, body: JSON.stringify(body) });
  const parent = { sessionID: 'ses_p', agent: 'harness-router', kind: 'primary', model: { providerID: 'anthropic' }, request: make(anthropicBody()) };
  const original = parent.request;
  await ctx.hooks['http.request'][0](parent);
  assert.notEqual(parent.request, original);
  const sent = JSON.parse(await parent.request.text());
  assert.equal(sent.system[0].cache_control.ttl, '1h'); assert.equal(parent.request.headers.get('content-length'), null);
  assert.equal(parent.request.headers.get('content-type'), 'application/json');
  assert.ok(logs.some(r => r.event === 'parent_cache_ttl_applied'));
  const worker = { ...parent, agent: 'harness-builder', request: make(anthropicBody()) }, workerRequest = worker.request;
  await ctx.hooks['http.request'][0](worker); assert.equal(worker.request, workerRequest);
  const adapted = anthropicBody(); adapted.system.unshift({ type: 'text', text: 'x-anthropic-billing-header: v' });
  const late = { ...parent, request: make(adapted) }, lateRequest = late.request;
  await ctx.hooks['http.request'][0](late); assert.equal(late.request, lateRequest);
  assert.ok(logs.some(r => r.reason === 'after_subscription_adapter'));
  const bad = { ...parent, request: new Request('https://api.anthropic.com/v1/messages', { method: 'POST', body: 'nope' }) }, badRequest = bad.request;
  await ctx.hooks['http.request'][0](bad); assert.equal(bad.request, badRequest);
});
test('B: a 400 naming the TTL disables the rewrite (circuit breaker); a missing hook API is a no-op', async () => {
  const ctx = hookCtx(), logs = [];
  const handle = await installParentCacheTtl(ctx, { loadConfig: ttlConfig(), log: r => logs.push(r), once: () => {} });
  const request = () => new Request('https://api.anthropic.com/v1/messages', { method: 'POST', body: JSON.stringify(anthropicBody()) });
  const event = { sessionID: 'ses_p', agent: 'router', kind: 'primary', model: { providerID: 'anthropic' }, request: request() };
  await ctx.hooks['http.request'][0](event);
  await ctx.hooks['http.response'][0]({ sessionID: 'ses_p', response: new Response('{"error":{"message":"cache_control.ttl: invalid"}}', { status: 400 }) });
  assert.equal(handle.state().disabled, 'provider_rejected_ttl');
  const next = { ...event, request: request() }, before = next.request;
  await ctx.hooks['http.request'][0](next); assert.equal(next.request, before);
  const none = await installParentCacheTtl({}, { once: (k, r) => logs.push(r) });
  assert.equal(none.state().disabled, 'unsupported'); assert.ok(logs.some(r => r.reason === 'http_request_hook_unavailable'));
});

// ---- A: batched observation masking ----
import { installObservationMasking, planBatch, protectionBoundary, applyMasks, estimateTokens, resultText } from '../plugins/v2/observation-masking.mjs';
import { createCacheDriftObserver } from '../plugins/v2/cache-drift.mjs';
class Msg { constructor(v) { Object.assign(this, v); } }
function conversation(turns, size = 20_000, tool = 'read') {
  const messages = [new Msg({ role: 'user', content: [{ type: 'text', text: 'task' }] })];
  for (let i = 0; i < turns; i++) {
    messages.push(new Msg({ role: 'assistant', content: [{ type: 'tool-call', id: `c${i}`, name: tool, input: { path: `f${i}` } }] }));
    messages.push(new Msg({ role: 'tool', content: [{ type: 'tool-result', id: `c${i}`, name: tool, result: { type: 'text', value: `${i}:`.padEnd(size, 'x') } }] }));
  }
  return messages;
}
const maskConfig = (over = {}) => () => ({ observationMasking: { ...mergeTokenSavingConfig({}, {}).observationMasking, ...over } });
function memoryState() { const data = new Map(); return { data, load: async id => new Map(data.get(id) ?? []), save: async (id, m) => { data.set(id, [...m]); } }; }
test('A: helpers: boundary, result text, token estimate, protected tools', () => {
  const messages = conversation(10);
  assert.equal(protectionBoundary(messages, 8), 5); // assistant messages at 1,3,5,...; 8th from the end is index 5
  assert.equal(protectionBoundary(messages, 50), 0);
  assert.equal(resultText({ type: 'json', value: { a: 1 } }), '{"a":1}');
  assert.equal(resultText({ type: 'error', value: 'x' }), undefined);
  assert.equal(resultText({ type: 'content', value: [{ type: 'file' }] }), undefined);
  assert.ok(estimateTokens({ system: [], messages }) > 49_000);
  const control = conversation(10, 20_000, 'task_dispatch');
  assert.equal(planBatch(control, new Map(), { keepRecentTurns: 8, minResultChars: 1200 }).length, 0);
  assert.equal(planBatch(messages, new Map(), { keepRecentTurns: 8, minResultChars: 1200 }).length, 2);
});
test('A: below the trigger nothing changes; above it a large batch is masked with recoverable originals', async () => {
  const ctx = hookCtx(), logs = [], saved = new Map(), state = memoryState(), drift = createCacheDriftObserver();
  const saveOriginal = async ({ id, text }) => { saved.set(id, text); return `/store/masked/${id}/chunks.jsonl`; };
  await installObservationMasking(ctx, { loadConfig: maskConfig(), log: r => logs.push(r), saveOriginal, state, onBatch: id => drift.masking(id) });
  const hook = ctx.hooks.context[0];
  const small = { sessionID: 'ses_a', agent: 'harness-builder', system: [], messages: conversation(12, 4000) };
  const before = JSON.stringify(small.messages); await hook(small); assert.equal(JSON.stringify(small.messages), before);
  const event = { sessionID: 'ses_a', agent: 'harness-builder', system: [], messages: conversation(30, 20_000) };
  const calls = JSON.stringify(event.messages.filter(m => m.role === 'assistant'));
  await hook(event);
  const results = event.messages.filter(m => m.role === 'tool').map(m => m.content[0]);
  const cleared = results.filter(p => p.result.value.startsWith('[harness cleared old tool result'));
  assert.equal(cleared.length, 30 - 8); // last 8 turns kept
  assert.ok(results.slice(-8).every(p => p.result.value.length === 20_000));
  assert.equal(JSON.stringify(event.messages.filter(m => m.role === 'assistant')), calls); // tool calls untouched
  assert.ok(event.messages.every(m => m instanceof Msg)); // runtime message class preserved
  assert.match(cleared[0].result.value, /read call [0-9a-f]{12}; 20000 chars\. Original: native read \/store\/masked\/c0\/chunks\.jsonl offset=1 limit=3/);
  assert.equal(saved.get('c0'), '0:'.padEnd(20_000, 'x'));
  assert.equal(logs.at(-1).event, 'observation_mask_batch'); assert.equal(logs.at(-1).results, 22);
  assert.deepEqual(state.data.get('ses_a').map(([id]) => id).slice(0, 2), ['c0', 'c1']);
  assert.equal(drift.observe({ sessionID: 'ses_a', system: [], messages: event.messages, tools: {}, model: {} }).reason, 'baseline');
  drift.masking('ses_a');
  assert.equal(drift.observe({ sessionID: 'ses_a', system: [], messages: event.messages.slice(0, 3), tools: {}, model: {} }).reason, 'masking_boundary');
});
test('A: later requests re-apply the same masks byte-identically and batch again only past the minimum', async () => {
  const ctx = hookCtx(), logs = [], state = memoryState();
  await installObservationMasking(ctx, { loadConfig: maskConfig(), log: r => logs.push(r), saveOriginal: async ({ id }) => `/s/${id}/chunks.jsonl`, state });
  const hook = ctx.hooks.context[0];
  const first = { sessionID: 'ses_b', agent: 'builder', system: [], messages: conversation(30) };
  await hook(first);
  const masked = JSON.stringify(first.messages);
  // Next step: fresh history from the runtime (unmasked) plus one new turn.
  const next = { sessionID: 'ses_b', agent: 'builder', system: [], messages: conversation(31) };
  await hook(next);
  assert.equal(JSON.stringify(next.messages.slice(0, first.messages.length - 16)), JSON.stringify(JSON.parse(masked).slice(0, first.messages.length - 16)));
  assert.equal(logs.filter(r => r.event === 'observation_mask_batch').length, 1); // 1 new eligible result < 30k tokens
  // A restart reloads the persisted set.
  const ctx2 = hookCtx();
  await installObservationMasking(ctx2, { loadConfig: maskConfig(), log: () => {}, saveOriginal: async () => undefined, state });
  const again = { sessionID: 'ses_b', agent: 'builder', system: [], messages: conversation(31) };
  await ctx2.hooks.context[0](again);
  assert.equal(JSON.stringify(again.messages), JSON.stringify(next.messages));
});
test('A: unrecoverable originals stay verbatim; disabled, native agents and small batches are untouched', async () => {
  for (const [over, agent, save] of [[{}, 'builder', async () => undefined], [{ enabled: false }, 'builder', async ({ id }) => `/s/${id}`], [{}, 'build', async ({ id }) => `/s/${id}`], [{ minBatchTokens: 900_000 }, 'builder', async ({ id }) => `/s/${id}`]]) {
    const ctx = hookCtx();
    await installObservationMasking(ctx, { loadConfig: maskConfig(over), log: () => {}, saveOriginal: save, state: memoryState() });
    const event = { sessionID: 'ses_c', agent, system: [], messages: conversation(30) };
    const before = JSON.stringify(event.messages); await ctx.hooks.context[0](event);
    assert.equal(JSON.stringify(event.messages), before);
  }
  const messages = conversation(3); assert.equal(applyMasks(messages, new Map([['c0', 'X']])), 1); assert.equal(messages[2].content[0].result.value, 'X');
  assert.equal(applyMasks(messages, new Map([['c0', 'X']])), 0);
});
test('A: the file store writes chunked originals readable by native read', async () => {
  const { createMaskStore } = await import('../plugins/v2/observation-masking.mjs');
  const fsp = await import('node:fs/promises'); const os = await import('node:os'); const p = await import('node:path');
  const dir = await fsp.mkdtemp(p.join(os.tmpdir(), 'mask-'));
  try {
    const store = createMaskStore(p.join(dir, 'masked'));
    const text = 'é"\\'.repeat(2000);
    const chunks = await store({ sessionID: 's', id: 'c1', text });
    assert.equal(await store({ sessionID: 's', id: 'c1', text }), chunks);
    const lines = (await fsp.readFile(chunks, 'utf8')).trim().split('\n');
    assert.ok(lines.every(l => l.length <= 1800)); assert.equal(lines.map(l => JSON.parse(l)).join(''), text);
    assert.equal((await fsp.stat(p.dirname(chunks))).mode & 0o777, 0o700);
    assert.equal(await createMaskStore(p.join(dir, 'tiny'), { maxBytes: 10 })({ sessionID: 's', id: 'c2', text }), undefined);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});
