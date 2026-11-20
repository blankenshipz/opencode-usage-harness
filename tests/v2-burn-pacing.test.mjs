import test from 'node:test';
import assert from 'node:assert/strict';
import { windowBurn, burnAhead, resetBurnSamples } from '../plugins/v2/burn-pacing.mjs';
import { quotaPace } from '../plugins/v2/dispatch-routing.mjs';

const H = 3600_000, t0 = Date.parse('2026-11-20T09:00:00Z'), resets = new Date(t0 + 99 * H).toISOString();
const weekly = used => ({ scope: 'account', used_percent: used, duration_minutes: 10080, resets_at: resets, pace_delta: 0 });

test('trailing weekly burn above the sustainable rate reports ahead; below it does not', () => {
  const store = new Map();
  assert.equal(windowBurn('anthropic', weekly(40), t0, store), undefined, 'one sample is not a rate');
  assert.equal(windowBurn('anthropic', weekly(40.2), t0 + 10 * 60_000, store), undefined, 'span under 30 min');
  const fast = windowBurn('anthropic', weekly(42), t0 + H, store); // 2 pts/h vs 58/98 ≈ 0.59
  assert.ok(fast.ahead && fast.ratePerHour > 1.9 && fast.sustainablePerHour < 0.6);
  const slow = new Map();
  windowBurn('anthropic', weekly(40), t0, slow);
  assert.equal(windowBurn('anthropic', weekly(40.4), t0 + H, slow).ahead, false);
  // Short windows are ignored (they have their own pacing).
  assert.equal(windowBurn('anthropic', { ...weekly(40), duration_minutes: 300 }, t0, new Map()), undefined);
  assert.equal(burnAhead('anthropic', [weekly(40)], t0, new Map()), false);
});

test('quotaPace folds the burn guard into the existing ahead pace', () => {
  resetBurnSamples();
  const quota = at => ({ pools: { anthropic: { checked_at: new Date(at).toISOString(), windows: [weekly(40 + 2 * (at - t0) / H)] } } });
  assert.equal(quotaPace(quota(t0), t0, 'anthropic'), 'normal');
  assert.equal(quotaPace(quota(t0 + H), t0 + H, 'anthropic'), 'ahead');
  resetBurnSamples();
});
