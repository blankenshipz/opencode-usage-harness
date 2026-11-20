import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchThrottle, installQuotaSampler, sampleQuota, QUOTA_SAMPLE_MS } from '../plugins/v2/quota-throttle.mjs';

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
