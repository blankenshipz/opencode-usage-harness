import test from 'node:test';
import assert from 'node:assert/strict';
import { acknowledgeTaskReview, backgroundDispatch, beginCheckpoint, CHECKPOINT_MS, checkpointStatus, HIGH_CONTEXT_TOKENS, normalizeCheckpoint, normalizeReviewAcknowledgement, prepareCheckpoint, TASK_REVIEW_CONTINUATIONS, TASK_REVIEW_STEPS } from '../plugins/v2/work-checkpoint.mjs';

test('cooperative slice survives serialization and becomes due on the existing boundary', () => {
  let owner = {};
  beginCheckpoint(owner, { objective: 'Capture one failure', expectedEvidence: 'Retained exception' }, 100);
  for (let n = 0; n < 29; n++) assert.equal(prepareCheckpoint(owner, 100).due, false);
  owner = JSON.parse(JSON.stringify(owner));
  assert.equal(prepareCheckpoint(owner, 100).due, true);
  assert.equal(checkpointStatus(owner, 100).preparedSteps, 30);
  beginCheckpoint(owner, undefined, 200);
  assert.equal(checkpointStatus(owner, 200).due, false);
  assert.equal(checkpointStatus(owner, 200 + CHECKPOINT_MS).due, true);
  assert.equal(checkpointStatus(owner, 0).elapsedMs, 0);
});

test('cumulative work survives continuation slices and review becomes due independently of the 30-step reminder', () => {
  const owner = {};
  beginCheckpoint(owner, undefined, 0);
  for (let n = 0; n < TASK_REVIEW_STEPS; n++) prepareCheckpoint(owner, 0);
  let status = checkpointStatus(owner, 0);
  assert.equal(status.preparedSteps, TASK_REVIEW_STEPS);
  assert.equal(status.due, true);
  assert.equal(status.cumulative.preparedSteps, TASK_REVIEW_STEPS);
  assert.equal(status.taskReview.due, true);
  beginCheckpoint(owner, undefined, 1);
  status = checkpointStatus(owner, 1);
  assert.equal(status.preparedSteps, 0);
  assert.equal(status.cumulative.preparedSteps, TASK_REVIEW_STEPS);
  assert.equal(status.cumulative.continuations, 1);
  assert.equal(status.taskReview.due, true);
  for (let n = 1; n < TASK_REVIEW_CONTINUATIONS; n++) beginCheckpoint(owner, undefined, n + 1);
  assert.equal(checkpointStatus(owner, 10).cumulative.continuations, TASK_REVIEW_CONTINUATIONS);
});

test('legacy slices retain known progress and explicit acknowledgement advances only the review baseline', () => {
  const owner = { workCheckpoint: { startedAt: 10, preparedSteps: 9 } };
  let status = checkpointStatus(owner, 10, { knownContext: { usedTokens: 900, maxTokens: 1000 } });
  assert.deepEqual(status.cumulative, { preparedSteps: 9, continuations: 0 });
  assert.equal(status.highContext.ratio, 0.9);
  for (let n = 0; n < TASK_REVIEW_STEPS - 9; n++) prepareCheckpoint(owner, 10);
  status = acknowledgeTaskReview(owner, { hypothesis: 'The retained exception comes from the parser branch', evidenceReference: 'tests/parser-repro.txt' }, 20);
  assert.equal(status.cumulative.preparedSteps, TASK_REVIEW_STEPS);
  assert.equal(status.taskReview.due, false);
  assert.deepEqual(status.taskReview.baseline, { preparedSteps: TASK_REVIEW_STEPS, continuations: 0 });
  assert.equal(status.taskReview.lastAcknowledgement.evidenceReference, 'tests/parser-repro.txt');
  assert.throws(() => acknowledgeTaskReview(owner, { hypothesis: 'x', evidenceReference: '' }), /invalid task review acknowledgement/);
  assert.throws(() => normalizeReviewAcknowledgement({ hypothesis: 'x', evidenceReference: 'ref', extra: true }), /invalid task review acknowledgement/);
  const tokenOnly = checkpointStatus(owner, 20, { knownContext: { tokens: HIGH_CONTEXT_TOKENS } }).highContext;
  assert.deepEqual(tokenOnly, { used: HIGH_CONTEXT_TOKENS, advisory: tokenOnly.advisory });
  assert.equal('ratio' in tokenOnly, false);
});

test('legacy assignments have no injected slice and status reads do not advance it', () => {
  assert.equal(prepareCheckpoint({}), undefined);
  const owner = {}; beginCheckpoint(owner, undefined, 1);
  for (let n = 0; n < 50; n++) checkpointStatus(owner, 100);
  assert.equal(owner.workCheckpoint.preparedSteps, 0);
});

test('checkpoint targets are bounded and sustained dispatch uses native background by default', () => {
  assert.equal(normalizeCheckpoint(undefined), undefined);
  for (const value of [{}, { objective: 'x', expectedEvidence: '' }, { objective: 'x', expectedEvidence: 'x', extra: 1 }]) {
    assert.throws(() => normalizeCheckpoint(value), /invalid checkpoint/);
  }
  for (const operation of ['coordinate', 'implement', 'deploy']) assert.equal(backgroundDispatch({ operation }), true);
  assert.equal(backgroundDispatch({ operation: 'inspect' }), false);
  assert.equal(backgroundDispatch({ operation: 'implement', background: false }), false);
  assert.equal(backgroundDispatch({ operation: 'inspect', background: true }), true);
});
