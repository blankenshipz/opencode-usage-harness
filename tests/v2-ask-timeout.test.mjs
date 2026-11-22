import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createParkMonitor, installParkYield, ASK_TIMEOUT_MS, askTimeoutMessage } from '../plugins/v2/park-yield.mjs';
import { blockedResumable, admissionDenial, denialAdvice } from '../plugins/v2/denial-recovery.mjs';
import { installPermissionReevaluation, recordGuardDecision, guardVerified, guardDecisions } from '../plugins/v2/permission-reevaluate.mjs';
import { markers } from '../plugins/v2/shell-guard.mjs';

const settle = () => new Promise(r => setImmediate(r));

test('4.4: default ask timeout is 15 min', () => { assert.equal(ASK_TIMEOUT_MS, 900_000); });

test('4.4: an ask pending past the timeout is rejected once (never approved) and logged', async () => {
  let at = 0; const logs = [], replies = [];
  const m = createParkMonitor({ now: () => at, askTimeout: 900_000, log: r => logs.push(r), reject: async r => { replies.push(r); } });
  m.asked({ id: 'per_1', sessionID: 'child', action: 'bash', summary: 'bash: git push', since: 0 });
  at = 899_999; await m.tick(); assert.equal(replies.length, 0);
  at = 900_000; const ev = await m.tick();
  assert.equal(replies.length, 1);
  assert.equal(replies[0].requestID, 'per_1'); assert.equal(replies[0].sessionID, 'child');
  assert.match(replies[0].message, /^ASK TIMEOUT DENY \(harness auto-approve policy\)/);
  assert.match(replies[0].message, /resumable blocker/); assert.match(replies[0].message, /exact command/); assert.match(replies[0].message, /do NOT retry variants/);
  const rec = ev.find(e => e.event === 'ask_timeout_denied'); assert.ok(rec); assert.equal(rec.summary, 'bash: git push');
  assert.equal(logs.filter(l => l.event === 'ask_timeout_denied').length, 1);
  assert.equal(m.pending().length, 0);
  at = 2_000_000; await m.tick(); assert.equal(replies.length, 1, 'never replied twice');
});

test('4.4: no reject function means no auto-deny; failed reject keeps the ask and is retried next tick (r40 M3)', async () => {
  let at = 0;
  const m = createParkMonitor({ now: () => at, askTimeout: 1000 });
  m.asked({ id: 'per_2', sessionID: 's', since: 0 }); at = 5000; await m.tick(); assert.equal(m.pending().length, 1);
  let calls = 0; const logs = [];
  const m2 = createParkMonitor({ now: () => at, askTimeout: 1000, log: r => logs.push(r), reject: async () => { calls++; throw new Error('gone'); } });
  m2.asked({ id: 'per_3', sessionID: 's', since: 0 }); await m2.tick(); await m2.tick();
  assert.equal(calls, 2, 'retried on the next tick');
  assert.equal(logs.filter(l => l.event === 'ask_timeout_reply_failed').length, 1, 'one failure line');
  assert.equal(m2.pending().length, 1);
  let ok = 0;
  const m3 = createParkMonitor({ now: () => at, askTimeout: 1000, log: r => logs.push(r), reject: async () => { if (++ok === 1) throw new Error('flaky'); } });
  m3.asked({ id: 'per_3b', sessionID: 's', since: 0 }); await m3.tick(); await m3.tick(); await m3.tick();
  assert.equal(ok, 2); assert.equal(m3.pending().length, 0);
  const denied = logs.find(l => l.event === 'ask_timeout_denied' && l.permissionID === 'per_3b');
  assert.ok(denied); assert.equal(denied.rule, 'ask_timeout'); assert.equal(denied.sessionID, 's'); assert.ok(denied.at);
});

test('r40 M3: reject is keyed by project directory; pending asks are listed on startup', async () => {
  let at = 0; const a = [], b = [];
  const m = createParkMonitor({ now: () => at, askTimeout: 1000 });
  const mk = (dir, sink, listed = []) => ({ location: { directory: dir }, event: { subscribe: async function* () {} },
    permission: { reply: async r => { sink.push(r); }, list: async () => listed } });
  const opts = { monitor: m, setTimer: () => ({ unref() {} }), clearTimer: () => {} };
  const h1 = installParkYield(mk('/p/a', a, [{ id: 'per_old', sessionID: 'sa', action: 'bash', time: { created: 1 } }]), opts);
  await settle(); await settle();
  const h2 = installParkYield(mk('/p/b', b), opts);
  await settle(); await settle();
  assert.ok(m.pending().some(x => x.requestID === 'per_old'), 'ask pending across reload is tracked');
  at = 5000; await m.tick(); h1.stop(); h2.stop();
  assert.equal(a.length, 1, "project a's reject answers project a's ask"); assert.equal(b.length, 0);
  assert.equal(a[0].decision, 'reject'); assert.equal(a[0].requestID, 'per_old');
});

test('4.4: installParkYield wires the deny through permission.reply with decision reject', async () => {
  let at = 0; const replies = [];
  const m = createParkMonitor({ now: () => at, askTimeout: 1000 });
  const ctx = { event: { subscribe: async function* () {} }, permission: { reply: async r => { replies.push(r); } } };
  const h = installParkYield(ctx, { monitor: m, setTimer: () => ({ unref() {} }), clearTimer: () => {} });
  m.asked({ id: 'per_4', sessionID: 's', since: 0 }); at = 1000; await m.tick(); h.stop();
  assert.equal(replies.length, 1); assert.equal(replies[0].decision, 'reject'); assert.equal(replies[0].requestID, 'per_4');
  assert.notEqual(replies[0].decision, 'once'); assert.notEqual(replies[0].decision, 'always');
});

test('4.4: denial-recovery treats ask-timeout and HARD DENY as blocked, resumable (not a denial)', () => {
  const timeout = askTimeoutMessage({ summary: 'bash: x', pendingMs: 900_000 });
  assert.deepEqual(blockedResumable(timeout), { status: 'blocked', resumable: true, kind: 'ask_timeout' });
  const hard = new Error('Subagent denied: HARD DENY (harness auto-approve policy; rule: force-push)');
  assert.equal(blockedResumable(hard).kind, 'hard_deny');
  assert.equal(admissionDenial(hard), undefined, 'not suppressed as a native denial');
  assert.equal(admissionDenial(new Error('Subagent denied: nope')), 'native_permission');
  assert.equal(blockedResumable('ordinary failure'), undefined);
  assert.match(denialAdvice('blocked_resumable'), /not a failure/);
});

function rig() {
  const queue = [], waiters = [], replies = [];
  const ctx = {
    event: { subscribe: () => ({ [Symbol.asyncIterator]() { return { next: () => queue.length ? Promise.resolve({ value: queue.shift(), done: false }) : new Promise(r => waiters.push(r)) }; } }) },
    permission: { hook: async () => {}, assert: async () => {}, list: async () => ({ data: [] }), reply: async r => { replies.push(r); } },
  };
  return { ctx, replies, push: e => { const w = waiters.shift(); if (w) w({ value: e, done: false }); else queue.push(e); } };
}

test('4.3: a native ask for a guard-verified call is approved once; hard-denied and guard-forced asks are not', async () => {
  guardDecisions.clear();
  const r = rig(); const logs = [];
  const h = await installPermissionReevaluation(r.ctx, { store: { load: () => [], save() {} }, log: x => logs.push(x), setTimer: () => 0, clearTimer: () => {} });
  recordGuardDecision('ses', 'call_ok', { verified: true });
  recordGuardDecision('ses', 'call_bad', { verified: false });
  recordGuardDecision('ses', 'call_bad', { verified: true }); // hard deny is sticky
  recordGuardDecision('ses', 'call_guard', { verified: true });
  r.push({ type: 'permission.asked', data: { id: 'per_ok', sessionID: 'ses', action: 'shell', source: { id: 'call_ok' } } });
  r.push({ type: 'permission.asked', data: { id: 'per_bad', sessionID: 'ses', action: 'shell', source: { id: 'call_bad' } } });
  r.push({ type: 'permission.asked', data: { id: 'per_g', sessionID: 'ses', action: 'shell', source: { id: 'call_guard' }, metadata: { [markers.GUARD_MARKER]: 'x' } } });
  r.push({ type: 'permission.asked', data: { id: 'per_other', sessionID: 'other', action: 'shell', source: { id: 'call_ok' } } });
  r.push({ type: 'permission.asked', data: { id: 'per_ok2', sessionID: 'ses', action: 'shell', source: { id: 'call_ok' } } });
  for (let i = 0; i < 5; i++) await settle();
  assert.deepEqual(r.replies, [{ sessionID: 'ses', requestID: 'per_ok', decision: 'once' }], 'one auto-reply, only for the verified call, only once');
  assert.equal(logs.filter(l => l.trigger === 'guard_decided').length, 1);
  h.stop();
});

test('4.3: guard decisions expire', () => {
  guardDecisions.clear();
  recordGuardDecision('s', 'c', { verified: true, now: 0 });
  assert.equal(guardVerified('s', 'c', 1), true);
  assert.equal(guardVerified('s', 'c', 10 * 60_000), false);
  recordGuardDecision('', 'c', { verified: true }); assert.equal(guardDecisions.size, 0);
});
