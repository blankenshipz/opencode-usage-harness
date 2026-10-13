import test from 'node:test';
import assert from 'node:assert/strict';
import { beginCheckpoint, prepareCheckpoint, checkpointStatus, normalizeCheckpoint, backgroundDispatch, CHECKPOINT_MS } from '../plugins/v2/work-checkpoint.mjs';

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
