// r32 item 1: observation-masking telemetry, stop events, store pruning and the summary report.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installObservationMasking, createMaskStore, createStateStore, pruneMaskStore, sessionStateName,
  resetMaskPruneSchedule, MAX_MASKED_PER_SESSION, PRUNE_DEFAULTS, placeholderText } from '../plugins/v2/observation-masking.mjs';
import { mergeTokenSavingConfig } from '../plugins/v2/token-saving.mjs';
import { summarizeTokenSaving, formatTokenSaving } from '../bin/harness-token-saving-report.mjs';

class Msg { constructor(v) { Object.assign(this, v); } }
function conversation(turns, size = 20_000) {
  const messages = [new Msg({ role: 'user', content: [{ type: 'text', text: 'task' }] })];
  for (let i = 0; i < turns; i++) {
    messages.push(new Msg({ role: 'assistant', content: [{ type: 'tool-call', id: `c${i}`, name: 'read', input: { path: `f${i}` } }] }));
    messages.push(new Msg({ role: 'tool', content: [{ type: 'tool-result', id: `c${i}`, name: 'read', result: { type: 'text', value: `${i}:`.padEnd(size, 'x') } }] }));
  }
  return messages;
}
const hookCtx = () => { const hooks = {}; return { hooks, session: { hook: async (name, fn) => { (hooks[name] ??= []).push(fn); } } }; };
const maskConfig = (over = {}) => () => ({ observationMasking: { ...mergeTokenSavingConfig({}, {}).observationMasking, ...over } });
function memoryState(initial = []) { const data = new Map(initial); return { data, load: async id => new Map(data.get(id) ?? []), save: async (id, m) => { data.set(id, [...m]); } }; }
const onceFn = () => { const seen = new Set(), logs = []; return { logs, once: (key, record) => { if (seen.has(key)) return false; seen.add(key); logs.push(record); return true; } }; };
const noTimer = () => ({ unref() {} });

test('r32 #1: a batch event records session, agent, results, chars/tokens removed and the trigger threshold', async () => {
  const ctx = hookCtx(), logs = [];
  await installObservationMasking(ctx, { loadConfig: maskConfig(), log: r => logs.push(r), saveOriginal: async ({ id }) => `/s/${id}/chunks.jsonl`, state: memoryState(), setTimer: noTimer });
  await ctx.hooks.context[0]({ sessionID: 'ses_t', agent: 'harness-builder', system: [], messages: conversation(30) });
  const batch = logs.find(r => r.event === 'observation_mask_batch');
  assert.ok(batch);
  assert.equal(batch.session, 'ses_t'); assert.equal(batch.agent, 'harness-builder'); assert.equal(batch.results, 22);
  assert.equal(batch.triggerTokens, 80_000); assert.equal(batch.minBatchTokens, 30_000); assert.equal(batch.keepRecentTurns, 8);
  assert.ok(batch.charsRemoved > 22 * 19_000 && batch.charsRemoved < 22 * 20_000);
  assert.equal(batch.tokensRemoved, Math.round(batch.charsRemoved / 4));
  assert.equal(batch.tokensCleared, batch.tokensRemoved, '0.3.0 field kept for older readers');
  assert.ok(batch.tokensBefore >= 80_000);
  assert.doesNotMatch(JSON.stringify(batch), /xxxx/, 'no tool output in telemetry');
});

test('r32 #1: the id cap logs one observation_mask_stopped per session, not every turn', async () => {
  const full = Array.from({ length: MAX_MASKED_PER_SESSION }, (_, i) => [`old${i}`, 'P']);
  const ctx = hookCtx(), logs = [], o = onceFn();
  let saves = 0;
  await installObservationMasking(ctx, { loadConfig: maskConfig(), log: r => logs.push(r), once: o.once, saveOriginal: async ({ id }) => { saves++; return `/s/${id}`; },
    state: memoryState([['ses_cap', full], ['ses_cap2', full]]), setTimer: noTimer });
  for (let i = 0; i < 3; i++) await ctx.hooks.context[0]({ sessionID: 'ses_cap', agent: 'builder', system: [], messages: conversation(30) });
  await ctx.hooks.context[0]({ sessionID: 'ses_cap2', agent: 'builder', system: [], messages: conversation(30) });
  assert.equal(saves, 0);
  const stops = o.logs.filter(r => r.event === 'observation_mask_stopped');
  assert.deepEqual(stops.map(r => [r.session, r.reason]), [['ses_cap', 'id_cap'], ['ses_cap2', 'id_cap']]);
  assert.equal(stops[0].cap, MAX_MASKED_PER_SESSION);
  assert.equal(logs.filter(r => r.event === 'observation_mask_batch').length, 0);
});

test('r32 #1: a full store logs store_cap once per session and asks for an early prune', async () => {
  resetMaskPruneSchedule();
  const ctx = hookCtx(), o = onceFn(), prunes = [];
  const fullStore = async () => { const e = new Error('full'); e.code = 'MASK_STORE_FULL'; throw e; };
  fullStore.directory = '/x/masked';
  const state = memoryState(); state.directory = '/x/state';
  let now = 1_000_000_000;
  await installObservationMasking(ctx, { loadConfig: maskConfig(), log: () => {}, once: o.once, saveOriginal: fullStore, state, setTimer: noTimer,
    now: () => now, prune: async opts => { prunes.push(opts); return { sessions: 0, originals: 0, pending: 0 }; } });
  await new Promise(r => setImmediate(r));
  assert.equal(prunes.length, 1, 'startup prune');
  now += 11 * 60_000;
  for (let i = 0; i < 3; i++) await ctx.hooks.context[0]({ sessionID: 'ses_full', agent: 'builder', system: [], messages: conversation(30) });
  await new Promise(r => setImmediate(r));
  assert.deepEqual(o.logs.map(r => [r.event, r.reason, r.session]), [['observation_mask_stopped', 'store_cap', 'ses_full']]);
  assert.equal(prunes.length, 2, 'one forced prune, throttled across turns');
  assert.equal(prunes[1].maskDir, '/x/masked'); assert.equal(prunes[1].stateDir, '/x/state');
});

async function seedStore(root, { sessions, now }) {
  const maskDir = path.join(root, 'masked'), stateDir = path.join(root, 'state');
  const store = createMaskStore(maskDir), state = createStateStore(stateDir);
  for (const [sessionID, { ageMs, results = 2, size = 5000 }] of Object.entries(sessions)) {
    const masked = new Map();
    for (let i = 0; i < results; i++) masked.set(`c${i}`, await store({ sessionID, id: `c${i}`, text: `${sessionID}:${i}`.padEnd(size, 'y') }));
    await state.save(sessionID, masked);
    const at = new Date(now - ageMs);
    await fsp.utimes(path.join(stateDir, sessionStateName(sessionID)), at, at);
  }
  return { maskDir, stateDir, store, state };
}
const ownedBy = async (maskDir, sessionID) => {
  let n = 0;
  for (const name of await fsp.readdir(maskDir)) {
    try { if (JSON.parse(await fsp.readFile(path.join(maskDir, name, 'metadata.json'), 'utf8')).session_id === sessionID) n++; } catch {}
  }
  return n;
};

test('r32 #1: prune evicts idle sessions (state + originals), orphans and stale temp dirs; keeps active ones', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mask-prune-'));
  const now = Date.now(), day = 24 * 3600_000;
  try {
    const { maskDir, stateDir } = await seedStore(root, { now, sessions: { ses_old: { ageMs: 8 * day }, ses_new: { ageMs: 1000 } } });
    // Orphan: an original whose session has no state file, written 9 days ago.
    const orphanStore = createMaskStore(maskDir);
    const orphan = path.dirname(await orphanStore({ sessionID: 'ses_gone', id: 'z', text: 'q'.repeat(3000) }));
    const meta = JSON.parse(await fsp.readFile(path.join(orphan, 'metadata.json'), 'utf8'));
    await fsp.writeFile(path.join(orphan, 'metadata.json'), JSON.stringify({ ...meta, created_ms: now - 9 * day }));
    const pending = path.join(maskDir, '.pending-abc');
    await fsp.mkdir(pending); const old = new Date(now - 2 * 3600_000); await fsp.utimes(pending, old, old);
    const result = await pruneMaskStore({ maskDir, stateDir, now });
    assert.equal(await ownedBy(maskDir, 'ses_old'), 0);
    assert.equal(await ownedBy(maskDir, 'ses_gone'), 0);
    assert.equal(await ownedBy(maskDir, 'ses_new'), 2);
    assert.equal(fs.existsSync(path.join(stateDir, sessionStateName('ses_old'))), false);
    assert.equal(fs.existsSync(path.join(stateDir, sessionStateName('ses_new'))), true);
    assert.equal(fs.existsSync(pending), false);
    assert.equal(result.originals, 3); assert.equal(result.pending, 1);
    assert.deepEqual(result.reasons, { pending: 1, idle: 1, orphan: 1 });
    assert.ok(result.freedBytes > 10_000 && result.remainingBytes > 10_000);
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
});

test('r32 #1: size pressure evicts the least recently active idle sessions down to the low-water mark, never recent ones', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mask-prune-'));
  const now = Date.now(), hour = 3600_000;
  try {
    const { maskDir, stateDir } = await seedStore(root, { now, sessions: {
      ses_a: { ageMs: 30 * hour }, ses_b: { ageMs: 20 * hour }, ses_c: { ageMs: 10 * hour }, ses_live: { ageMs: hour } } });
    // Each session holds ~2 x (2*5000 + chunks) bytes; pick marks so two evictions are needed.
    const total = (await pruneMaskStore({ maskDir, stateDir, now, limits: { highWaterBytes: 1e12 } })).remainingBytes;
    const per = total / 4;
    const result = await pruneMaskStore({ maskDir, stateDir, now, limits: { highWaterBytes: Math.floor(per * 3.5), lowWaterBytes: Math.floor(per * 2.5) } });
    assert.deepEqual(result.reasons, { size: 2 });
    assert.equal(await ownedBy(maskDir, 'ses_a'), 0); assert.equal(await ownedBy(maskDir, 'ses_b'), 0);
    assert.equal(await ownedBy(maskDir, 'ses_c'), 2); assert.equal(await ownedBy(maskDir, 'ses_live'), 2);
    // Under extreme pressure a session active within minIdleMs is still never evicted.
    const hard = await pruneMaskStore({ maskDir, stateDir, now, limits: { highWaterBytes: 1, lowWaterBytes: 0 } });
    assert.deepEqual(hard.reasons, { size: 1 });
    assert.equal(await ownedBy(maskDir, 'ses_live'), 2);
    assert.equal(PRUNE_DEFAULTS.minIdleMs, 6 * hour);
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
});

test('r32 #1: the startup prune is logged, frees store space, and evicted sessions reload their (empty) mask set', async () => {
  resetMaskPruneSchedule();
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mask-prune-'));
  const now = Date.now(), day = 24 * 3600_000;
  try {
    const { maskDir, stateDir } = await seedStore(root, { now, sessions: { ses_idle: { ageMs: 8 * day } } });
    const ctx = hookCtx(), logs = [];
    const stop = await installObservationMasking(ctx, { loadConfig: maskConfig(), log: r => logs.push(r), saveOriginal: createMaskStore(maskDir),
      state: createStateStore(stateDir), setTimer: noTimer });
    await stop.startup;
    const pruned = logs.find(r => r.event === 'observation_mask_pruned');
    assert.ok(pruned); assert.equal(pruned.trigger, 'startup'); assert.equal(pruned.sessions, 1); assert.equal(pruned.originals, 2);
    assert.equal(await ownedBy(maskDir, 'ses_idle'), 0);
    // A new batch for a live session writes originals and touches its state file.
    await ctx.hooks.context[0]({ sessionID: 'ses_live', agent: 'builder', system: [], messages: conversation(30) });
    assert.equal(await ownedBy(maskDir, 'ses_live'), 22);
    assert.ok(fs.existsSync(path.join(stateDir, sessionStateName('ses_live'))));
    stop();
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
});

test('r32 #1: summary totals masking savings and 1h-TTL events per day; the CLI and daily rollup print them', () => {
  const at = (d, h) => new Date(2026, 10, d, h).toISOString();
  const records = [
    { at: at(20, 9), event: 'observation_mask_batch', session: 's1', results: 10, charsRemoved: 400_000, tokensRemoved: 100_000 },
    { at: at(20, 10), event: 'observation_mask_batch', session: 's1', results: 5, tokensCleared: 50_000 },
    { at: at(20, 11), event: 'observation_mask_stopped', session: 's2', reason: 'store_cap' },
    { at: at(20, 12), event: 'observation_mask_pruned', sessions: 2, originals: 7, freedBytes: 9000 },
    { at: at(20, 13), event: 'parent_cache_ttl_applied', session: 'r1', breakpoints: 4 },
    { at: at(20, 14), event: 'parent_cache_ttl_disabled', reason: 'provider_rejected_ttl' },
    { at: at(20, 14), event: 'parent_cache_ttl_fallback', reason: 'provider_rejected_ttl' },
    { at: at(21, 1), event: 'parent_cache_ttl_unsupported', reason: 'after_subscription_adapter' },
    { at: at(21, 2), event: 'claude_auth_recovery', outcome: 'retried' },
  ];
  const s = summarizeTokenSaving(records);
  assert.deepEqual(Object.keys(s), ['2026-11-20', '2026-11-21']);
  const d = s['2026-11-20'];
  assert.equal(d.masking.batches, 2); assert.equal(d.masking.results, 15); assert.equal(d.masking.estTokensRemoved, 150_000);
  assert.equal(d.masking.charsRemoved, 600_000); assert.equal(d.masking.sessions, 1); assert.deepEqual(d.masking.stopped, { store_cap: 1 });
  assert.equal(d.masking.prunedSessions, 2);
  assert.equal(d.parentTtl.applied, 1); assert.equal(d.parentTtl.breakerTrips, 1); assert.equal(d.parentTtl.fallbacks, 1);
  assert.deepEqual(s['2026-11-21'].parentTtl.unsupported, { after_subscription_adapter: 1 });
  assert.deepEqual(s['2026-11-21'].auth.recoveries, { retried: 1 });
  assert.match(formatTokenSaving(s), /2 batches, 15 results, ~150000 tokens/);

  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-report-'));
  fs.mkdirSync(path.join(state, 'telemetry'));
  fs.writeFileSync(path.join(state, 'telemetry', 'token-saving.jsonl.1'), JSON.stringify(records[0]) + '\n');
  fs.writeFileSync(path.join(state, 'telemetry', 'token-saving.jsonl'), records.slice(1).map(r => JSON.stringify(r)).join('\n') + '\nnot json\n');
  const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin');
  const json = JSON.parse(execFileSync(process.execPath, [path.join(bin, 'harness-token-saving-report.mjs'), '--state', state, '--date', '2026-11-20', '--json'], { encoding: 'utf8' }));
  assert.equal(json['2026-11-20'].masking.estTokensRemoved, 150_000);
  const text = execFileSync(process.execPath, [path.join(bin, 'harness-token-saving-report.mjs'), '--state', state], { encoding: 'utf8' });
  assert.match(text, /2026-11-21/);
  const out = execFileSync(process.execPath, [path.join(bin, 'harness-daily-rollup.mjs'), '--date', '2026-11-20', '--repo', state, '--state', state], { encoding: 'utf8' }).trim();
  const rollup = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(rollup.tokenSaving.masking.estTokensRemoved, 150_000);
  assert.equal(rollup.tokenSaving.parentTtl.breakerTrips, 1);
  fs.rmSync(state, { recursive: true, force: true });
});

test('Fable r32 #2: a full store recounts after another instance pruned, instead of staying full', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mask-full-'));
  try {
    let t = 0;
    const store = createMaskStore(root, { maxBytes: 30_000, now: () => t, recountMs: 1000 });
    const first = await store({ sessionID: 's', id: 'a', text: 'a'.repeat(9000) });
    await assert.rejects(store({ sessionID: 's', id: 'b', text: 'b'.repeat(9000) }), { code: 'MASK_STORE_FULL' });
    await fsp.rm(path.dirname(first), { recursive: true }); // pruned by another instance
    await assert.rejects(store({ sessionID: 's', id: 'b', text: 'b'.repeat(9000) }), { code: 'MASK_STORE_FULL' }, 'recount is throttled');
    t += 1000;
    assert.match(await store({ sessionID: 's', id: 'b', text: 'b'.repeat(9000) }), /chunks\.jsonl$/);
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
});

test('Fable r32 #3: a session touched after the scan is not evicted; masks whose original vanished are dropped on load', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mask-race-'));
  const now = Date.now(), day = 24 * 3600_000;
  try {
    const { maskDir, stateDir, state } = await seedStore(root, { now, sessions: { ses_back: { ageMs: 8 * day } } });
    const stateFile = path.join(stateDir, sessionStateName('ses_back'));
    let scanned = false;
    // The session resumes (touch) after the scan read its mtime, before eviction.
    const io = { ...fsp, readdir: async (dir, opts) => { const r = await fsp.readdir(dir, opts); if (dir === maskDir && !scanned) { scanned = true; const at = new Date(now); await fsp.utimes(stateFile, at, at); } return r; } };
    // states are read before the mask scan, so the touch lands between scan and evict.
    const result = await pruneMaskStore({ maskDir, stateDir, now, io });
    assert.equal(result.sessions, 0); assert.equal(await ownedBy(maskDir, 'ses_back'), 2);
    // Self-heal: delete one original; the reloaded mask set drops that entry only.
    const paths = [...(await state.load('ses_back')).values()];
    await state.save('ses_back', new Map(paths.map((chunksPath, i) => [`c${i}`, placeholderText({ name: 'read', input: {}, chars: 5000, chunksPath })])));
    const masks = await state.load('ses_back');
    assert.equal(masks.size, 2);
    const victim = paths[0];
    await fsp.rm(path.dirname(victim), { recursive: true });
    assert.equal((await state.load('ses_back')).size, masks.size - 1);
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
});

test('Fable r32 minor: summary keys from telemetry are bounded', () => {
  const s = summarizeTokenSaving([{ at: new Date(2026, 10, 20, 9).toISOString(), event: 'observation_mask_stopped', reason: 'x'.repeat(200) },
    { at: new Date(2026, 10, 20, 9).toISOString(), event: 'claude_auth_recovery', outcome: 'has space' }]);
  assert.deepEqual(s['2026-11-20'].masking.stopped, { other: 1 });
  assert.deepEqual(s['2026-11-20'].auth.recoveries, { other: 1 });
});
