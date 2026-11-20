import test from 'node:test';
import assert from 'node:assert/strict';
import { recordReviewGate, pendingReviewGate, mainLandingCommand, gateMessage } from '../plugins/v2/review-gate.mjs';

test('pending required review and gated review block; completion clears gate', () => {
  const state = { records: [{ rootID: 'r', taskId: 't', workKey: 'rev', childID: 'c', state: 'running', routing: { reviewIndependence: 'required' } }] };
  assert.equal(pendingReviewGate(state, 'r')[0].kind, 'pending');
  assert.deepEqual(pendingReviewGate(state, 'other'), []);
  state.records[0].state = 'completed'; state.records[0].updatedAt = 5;
  assert.deepEqual(pendingReviewGate(state, 'r'), []);
  recordReviewGate(state, { rootID: 'r', taskId: 't', reason: 'receipt missing', at: 10 });
  assert.equal(pendingReviewGate(state, 'r')[0].kind, 'gated');
  assert.match(gateMessage(pendingReviewGate(state, 'r')), /DEPLOY-READY/);
  state.records[0].updatedAt = 11;
  assert.deepEqual(pendingReviewGate(state, 'r'), []);
  state.records.push({ rootID: 'r', taskId: 'x', state: 'running', routing: {} });
  assert.deepEqual(pendingReviewGate(state, 'r'), []);
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
