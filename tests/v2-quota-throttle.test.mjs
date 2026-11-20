import { test } from 'node:test';
import assert from 'node:assert/strict';
import { budgetBrake, weeklyProjection, dispatchThrottle, installQuotaSampler, sampleQuota, QUOTA_SAMPLE_MS } from '../plugins/v2/quota-throttle.mjs';

const records = [{ rootID: 'root', childID: 'a' }, { rootID: 'root', childID: 'b' }, { rootID: 'other', childID: 'c' }];
const sessions = [{ id: 'a', active: true }, { id: 'b', active: true }, { id: 'c', active: true }];
test('throttle only new children while pace is ahead and the active cap is reached', () => {
  const base = { pace: 'ahead', newChild: true, rootID: 'root', records, sessions };
  const hit = dispatchThrottle(base); assert.equal(hit.reason, 'quota_pace_ahead'); assert.match(hit.message, /QUOTA_PACE_THROTTLED/); assert.match(hit.message, /not a permission denial/);
  assert.equal(dispatchThrottle({ ...base, pace: 'normal' }), undefined);
  assert.equal(dispatchThrottle({ ...base, newChild: false }), undefined);
  assert.equal(dispatchThrottle({ ...base, compact: true }), undefined);
  assert.equal(dispatchThrottle({ ...base, review: true }), undefined);
  assert.equal(dispatchThrottle({ ...base, sessions: [{ id: 'a', active: true }, { id: 'b', active: false }] }), undefined);
});
test('sampler reads on a timer, feeds pace, and swallows failures', async () => {
  let fn, ms, n = 0; const seen = [];
  const s = installQuotaSampler({}, { read: async () => { n++; if (n === 2) throw new Error('x'); return { pools: { openai: { checked_at: new Date().toISOString(), windows: [] } } }; },
    setTimer: (f, m) => (fn = f, ms = m, { unref() {} }), clearTimer: () => {}, onSample: p => seen.push(p) });
  assert.equal(ms, QUOTA_SAMPLE_MS);
  assert.deepEqual(await s.sample(), { openai: 'unknown' }); assert.equal(await s.sample(), undefined);
  fn(); await new Promise(r => setImmediate(r)); assert.equal(n, 3); assert.equal(seen.length, 2); s.stop();
  assert.deepEqual(sampleQuota({}), { openai: 'unknown' });
});

test('throttle counts in-flight admissions, excludes the caller chain and parked children', () => {
  const sessions = [{ id: 'a', active: true }, { id: 'b', active: true, parentID: 'a' }];
  const base = { pace: 'ahead', newChild: true, rootID: 'root', sessions };
  assert.ok(dispatchThrottle({ ...base, records: [{ rootID: 'root', childID: 'a' }, { rootID: 'root', key: 'k2', inFlight: 't', state: 'starting' }] }));
  assert.equal(dispatchThrottle({ ...base, callerID: 'b', records: [{ rootID: 'root', childID: 'a' }, { rootID: 'root', childID: 'b' }] }), undefined);
  assert.equal(dispatchThrottle({ ...base, records: [{ rootID: 'root', childID: 'a' }, { rootID: 'root', childID: 'b', admissionGeneration: 2, parked: { generation: 2 } }] }), undefined);
});

const NOW = Date.parse('2026-11-20T00:00:00Z');
const q = (used, rate, hours = 24) => ({ pools: { openai: { windows: [{ scope: 'account', duration_minutes: 10080, used_percent: used, resets_at: new Date(NOW + hours * 3600_000).toISOString(), burn_rate_per_hour: rate }] } } });
const env = {};
test('weekly projection and fail-open on missing data', () => {
  assert.equal(Math.round(weeklyProjection(q(50, 2), 'openai', NOW).projected), 98);
  assert.equal(weeklyProjection({}, 'openai', NOW), undefined);
  const nob = { pools: { openai: { windows: [{ scope: 'account', duration_minutes: 10080, used_percent: 99, resets_at: NOW + 3600_000 }] } } };
  const noReset = { pools: { openai: { windows: [{ scope: 'account', duration_minutes: 10080, used_percent: 99 }] } } };
  assert.equal(budgetBrake({ quota: noReset, now: NOW, newChild: true, env, agent: 'builder', burn: () => ({ ratePerHour: 5 }) }), undefined);
  assert.equal(budgetBrake({ quota: nob, now: NOW, newChild: true, env, agent: 'builder', burn: () => undefined }), undefined); // week avg keeps it < 100%
  assert.equal(budgetBrake({ quota: undefined, now: NOW, newChild: true, env }), undefined);
  const hot = { pools: { openai: { windows: [{ scope: 'account', duration_minutes: 10080, used_percent: 30, resets_at: NOW + 24 * 3600_000 }] } } };
  assert.equal(budgetBrake({ quota: { pools: { openai: { windows: [{ ...hot.pools.openai.windows[0], used_percent: 99.8 }] } } }, now: NOW, newChild: true, env, agent: 'builder' }).level, 2);
});
test('level 1 caps builders to one active child per root; user priority allowed', () => {
  const base = { quota: q(60, 2), now: NOW, newChild: true, rootID: 'root', records, sessions, env, agent: 'builder' }; // 108%
  const hit = budgetBrake(base);
  assert.equal(hit.level, 1); assert.match(hit.message, /pacing for weekly quota/); assert.match(hit.message, /108%/);
  assert.match(hit.message, /2026-11-21T00:00:00.000Z/); assert.match(hit.message, /not a permission denial/);
  assert.equal(budgetBrake({ ...base, records: [] }), undefined);
  assert.equal(budgetBrake({ ...base, userRequested: true }), undefined);
  assert.equal(dispatchThrottle({ ...base, pace: 'normal', priority: 'user' }), undefined);
  assert.equal(dispatchThrottle({ ...base, pace: 'normal' }).reason, 'weekly_budget_brake');
});
test('level 2 refuses builders unless user-requested; exemptions and env override', () => {
  const base = { quota: q(60, 3), now: NOW, newChild: true, rootID: 'root', records: [], sessions, env, agent: 'builder' }; // 132%
  assert.equal(budgetBrake(base).level, 2);
  assert.equal(budgetBrake({ ...base, quota: q(91, 0.5) }).level, 2);
  assert.equal(budgetBrake({ ...base, userRequested: true }), undefined);
  for (const agent of ['verifier', 'code-reviewer']) assert.equal(budgetBrake({ ...base, agent }), undefined);
  for (const k of ['review', 'compact']) assert.equal(budgetBrake({ ...base, [k]: true }), undefined);
  assert.equal(budgetBrake({ ...base, newChild: false }), undefined);
  assert.equal(budgetBrake({ ...base, env: { HARNESS_BUDGET_BRAKE: 'off' } }), undefined);
  assert.equal(budgetBrake({ ...base, quota: q(50, 1) }), undefined); // 74%
});

test('r26 fable: a short burst is not extrapolated over the week; non-builders are never braked', () => {
  // 30% used after 48 h (avg 0.625/h, 120 h left -> 105%); trailing burst 3/h would project 390%.
  const quota = { pools: { openai: { windows: [{ scope: 'account', duration_minutes: 10080, used_percent: 30, resets_at: new Date(NOW + 120 * 3600_000).toISOString() }] } } };
  const p = weeklyProjection(quota, 'openai', NOW, () => ({ ratePerHour: 3 }));
  assert.equal(Math.round(p.projected), 105);
  for (const agent of ['router', 'explorer', undefined]) assert.equal(budgetBrake({ quota: q(60, 3), now: NOW, newChild: true, rootID: 'root', records: [], sessions, env, agent }), undefined);
});
