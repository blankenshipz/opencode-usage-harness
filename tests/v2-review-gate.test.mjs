import test from 'node:test';
import assert from 'node:assert/strict';
import { recordReviewGate, pendingReviewGate, mainLandingCommand, gateMessage } from '../plugins/v2/review-gate.mjs';

test('pending required review and gated review block; completion clears gate', () => {
  const state = { records: [{ rootID: 'r', taskId: 't', workKey: 'rev', childID: 'c', state: 'running', routing: { reviewIndependence: 'required' } }] };
  assert.equal(pendingReviewGate(state, 'r', { now: 20 })[0].kind, 'pending');
  assert.deepEqual(pendingReviewGate(state, 'other'), []);
  state.records[0].state = 'completed'; state.records[0].updatedAt = 5;
  assert.deepEqual(pendingReviewGate(state, 'r', { now: 20 }), []);
  recordReviewGate(state, { rootID: 'r', taskId: 't', reason: 'receipt missing', at: 10 });
  assert.equal(pendingReviewGate(state, 'r', { now: 20 })[0].kind, 'gated');
  assert.match(gateMessage(pendingReviewGate(state, 'r', { now: 20 })), /DEPLOY-READY/);
  state.records[0].updatedAt = 11;
  assert.deepEqual(pendingReviewGate(state, 'r', { now: 20 }), []);
  state.records.push({ rootID: 'r', taskId: 'x', state: 'running', routing: {} });
  assert.deepEqual(pendingReviewGate(state, 'r', { now: 20 }), []);
});

test('main landing commands', () => {
  assert.equal(mainLandingCommand('git push origin main', 'feature'), true);
  assert.equal(mainLandingCommand('git push origin HEAD:main', 'feature'), true);
  assert.equal(mainLandingCommand('git push', 'main'), true);
  assert.equal(mainLandingCommand('git push origin feature', 'main'), false);
  assert.equal(mainLandingCommand('cd x && git -C repo merge feature', 'main'), true);
  assert.equal(mainLandingCommand('git merge main', 'feature'), false);
  assert.equal(mainLandingCommand('git status', 'main'), false);
  assert.equal(mainLandingCommand('git push --all', 'feature'), true);
  assert.equal(mainLandingCommand('git push -u origin feature', 'feature'), false);
});

test('r26 fable: gate bypasses and false positives', () => {
  for (const c of ['git push origin HEAD', 'git push origin "main"', 'bash -c "git push origin main"', 'git push --mirror', 'git push origin HEAD:refs/heads/main', 'git push -f origin +main'])
    assert.equal(mainLandingCommand(c, c.includes('HEAD') && !c.includes(':') ? 'main' : 'feature'), true, c);
  assert.equal(mainLandingCommand('git push', undefined), true, 'unknown branch fails closed');
  assert.equal(mainLandingCommand('git merge --abort', 'main'), false);
  assert.equal(mainLandingCommand('git push origin feature', 'feature'), false);
});

test('r26 fable: completion gate is per task, stale states and old gates do not block', () => {
  const state = { records: [
    { rootID: 'r', taskId: 'a', state: 'running', routing: { reviewIndependence: 'required' } },
    { rootID: 'r', taskId: 'b', state: 'settled', routing: { reviewIndependence: 'required' } }] };
  assert.equal(pendingReviewGate(state, 'r', { taskId: 'b' }).length, 0);
  assert.equal(pendingReviewGate(state, 'r', { taskId: 'a' }).length, 1);
  recordReviewGate(state, { rootID: 'r', taskId: 'c', reason: 'x', at: 0 });
  assert.equal(pendingReviewGate(state, 'r', { taskId: 'c', now: 1000 }).length, 1);
  assert.equal(pendingReviewGate(state, 'r', { taskId: 'c', now: 25 * 3600_000 }).length, 0);
});
