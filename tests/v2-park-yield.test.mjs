import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createParkMonitor, installParkYield, parkedResult, NOTIFY_AFTER_MS, PARK_AFTER_MS } from '../plugins/v2/park-yield.mjs';

test('stalled at 10 min, parked at 30 min, logged once each, never replies', async () => {
  let at = 0; const logs = [];
  const m = createParkMonitor({ now: () => at, log: r => logs.push(r) });
  m.asked({ id: 'per_1', sessionID: 'child', action: 'bash', since: 0 });
  at = NOTIFY_AFTER_MS - 1; assert.deepEqual(await m.tick(), []);
  at = NOTIFY_AFTER_MS; assert.equal((await m.tick())[0].outcome, 'stalled');
  assert.deepEqual(await m.tick(), []);
  at = PARK_AFTER_MS; const parked = await m.tick();
  assert.equal(parked[0].outcome, 'parked'); assert.equal(parked[0].answerable, true);
  assert.deepEqual(logs.map(l => l.outcome), ['stalled', 'parked']);
  assert.equal(m.pending().length, 1, 'parked ask stays pending/answerable');
});

test('whenParked resolves only for matching sessions; reply clears the ask', async () => {
  let at = 0; const m = createParkMonitor({ now: () => at });
  const other = m.whenParked(sid => sid === 'other');
  const mine = m.whenParked(async sid => sid === 'grandchild');
  m.asked({ id: 'per_2', sessionID: 'grandchild', since: 0 });
  m.asked({ id: 'per_3', sessionID: 'x', since: 0 });
  at = PARK_AFTER_MS; await m.tick();
  const got = await mine.promise; assert.equal(got.requestID, 'per_2'); assert.equal(got.pendingMs, PARK_AFTER_MS);
  let otherDone = false; other.promise.then(() => { otherDone = true; }); await new Promise(r => setImmediate(r));
  assert.equal(otherDone, false); other.cancel();
  m.replied('per_2'); assert.deepEqual(m.pending().map(p => p.requestID), ['per_3']);
});

test('install tracks asked/replied events and the parked result is never a pass', async () => {
  const events = [{ type: 'permission.asked', data: { id: 'per_9', sessionID: 's', action: 'edit' } }, { type: 'permission.replied', data: { sessionID: 's', requestID: 'per_9' } }];
  const m = createParkMonitor(); let interval;
  const ctx = { event: { subscribe: async function* () { for (const e of events) yield e; } } };
  const handle = installParkYield(ctx, { monitor: m, setTimer: (fn, ms) => (interval = ms, { unref() {} }), clearTimer: () => {} });
  await new Promise(r => setImmediate(r)); assert.equal(interval, 10_000); assert.equal(m.pending().length, 0); handle.stop();
  const r = parkedResult({ parked: { requestID: 'per_1', sessionID: 'c', action: 'bash', pendingMs: PARK_AFTER_MS }, identity: { sessionID: 'c', agent: 'verifier', generation: 1 }, collect: {} });
  assert.equal(r.metadata.status, 'blocked'); assert.equal(r.metadata.verdict, 'blocked'); assert.match(r.content, /NOT a pass/); assert.match(r.content, /not denied/);
});

test('an ask answered while match() awaits never releases; session end forgets asks; tick is not reentrant', async () => {
  let at = 0, unblock; const m = createParkMonitor({ now: () => at });
  m.asked({ id: 'per_a', sessionID: 's', since: 0 });
  const w = m.whenParked(async () => { await new Promise(r => { unblock = r; }); return true; });
  at = PARK_AFTER_MS; const first = m.tick(); await new Promise(r => setImmediate(r));
  assert.deepEqual(await m.tick(), [], 'reentrant tick is skipped');
  m.replied('per_a'); unblock(); await first;
  let done = false; w.promise.then(() => { done = true; }); await new Promise(r => setImmediate(r)); assert.equal(done, false); w.cancel();
  m.asked({ id: 'per_b', sessionID: 'gone', since: 0 }); m.forgetSession('gone'); assert.equal(m.pending().length, 0);
});

test('r26: ask summary is redacted and pending asks are published', async () => {
  const { askSummary, createParkMonitor: make, PARK_AFTER_MS: P } = await import('../plugins/v2/park-yield.mjs');
  const s = askSummary({ permission: 'bash', patterns: ['curl -H authorization: abcdef https://x', 'token=supersecret'] });
  assert.ok(!s.includes('abcdef') && !s.includes('supersecret'), s);
  assert.match(s, /^bash: curl/);
  assert.ok(askSummary({ permission: 'read', patterns: ['x'.repeat(400)] }).length <= 160);
  let at = 0; const published = [];
  const m = make({ now: () => at, publish: a => published.push(a) });
  m.asked({ id: 'per_1', sessionID: 'c', action: 'bash', summary: 'bash: ls /opt' });
  assert.equal(published.at(-1)[0].summary, 'bash: ls /opt');
  at = P; const ev = await m.tick();
  assert.equal(ev.find(e => e.outcome === 'parked').summary, 'bash: ls /opt');
  assert.equal(published.at(-1)[0].parked, true);
  m.replied('per_1'); assert.deepEqual(published.at(-1), []);
});

test('r26 fable: redaction covers env assignments, auth headers and flags', async () => {
  const { askSummary } = await import('../plugins/v2/park-yield.mjs');
  for (const [cmd, secret] of [['PGPASSWORD=hunter2 psql -h db', 'hunter2'], ['curl -H "Authorization: Bearer abc123def"', 'abc123def'], ['API_KEY=abc123 run', 'abc123'], ['tool --token s3cr3t', 's3cr3t'], ['psql postgres://u:pw1@h/db', 'pw1']]) {
    const s = askSummary({ permission: 'bash', patterns: [cmd] });
    assert.ok(!s.includes(secret), s);
  }
});

test('0.3.3: stall is logged at once and the parent is released after 30 s', async () => {
  const { NOTIFY_AFTER_MS: N, PARK_AFTER_MS: P, PARK_TICK_MS: T } = await import('../plugins/v2/park-yield.mjs');
  assert.equal(N, 0); assert.equal(P, 30_000); assert.equal(T, 10_000);
  let at = 0; const logged = [];
  const m = createParkMonitor({ now: () => at, log: r => logged.push(r) });
  m.asked({ id: 'per_z', sessionID: 's', action: 'shell', since: 0 });
  await m.tick(); assert.deepEqual(logged.map(r => r.outcome), ['stalled']);
  at = 30_000; await m.tick(); assert.deepEqual(logged.map(r => r.outcome), ['stalled', 'parked']);
});
