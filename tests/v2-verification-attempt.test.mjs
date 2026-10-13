import test from 'node:test';
import assert from 'node:assert/strict';
import { attemptSchema, normalizeAttempt, recordAttempt, attemptStatus } from '../plugins/v2/verification-attempt.mjs';

const ready = (id = 'a', extra = {}) => ({ id, phase: 'ready', expectedSignal: 'button-press', receipt: `private/${id}`, observedAt: 100, expiresAt: 200, readiness: { receiver: true, observer: true, recorder: true }, ...extra });
const terminal = (id = 'a', phase = 'captured', extra = {}) => ({ id, phase, evidence: 'private receipt reference', observedAt: 150, ...extra });

test('schema and normalization are strict and bounded', () => {
  assert.equal(attemptSchema.additionalProperties, false);
  assert.deepEqual(normalizeAttempt(ready()), ready());
  for (const bad of [ready('has space'), { ...ready(), extra: true }, { ...ready(), readiness: { receiver: true, observer: true, recorder: false } }, { ...ready(), receipt: 'https://secret.example/raw' }, terminal('a', 'captured', { evidence: undefined })]) assert.throws(() => normalizeAttempt(bad));
});

test('ready lifecycle does not extend expiry and reports self-reported status', () => {
  const owner = {};
  const first = recordAttempt(owner, ready(), 110);
  const duplicate = recordAttempt(owner, ready('a', { expiresAt: 999 }), 120);
  assert.equal(first.expiresAt, 200); assert.equal(duplicate.expiresAt, 200); assert.equal(duplicate.selfReported, true); assert.equal(duplicate.livenessVerified, false);
  assert.equal(attemptStatus(owner, 200).phase, 'expired');
});

test('terminal records require the known ready id, preserve ordering, and support delayed receipts', () => {
  const owner = {}, orderingOwner = {};
  recordAttempt(owner, ready(), 110);
  const captured = recordAttempt(owner, terminal(), 500);
  assert.equal(captured.phase, 'captured'); assert.equal(captured.delayedReporting, true); assert.equal(captured.expiresAt, 200);
  recordAttempt(orderingOwner, ready(), 110);
  assert.throws(() => recordAttempt(orderingOwner, terminal('unknown'), 150), /known ready/);
  assert.throws(() => recordAttempt(orderingOwner, terminal('a', 'failed', { observedAt: 90 }), 150), /stale/);
  assert.throws(() => recordAttempt(owner, ready(), 120), /cannot reopen/);
});

test('observed completion after deadline is accepted only when observed before deadline', () => {
  const owner = {};
  recordAttempt(owner, ready(), 110);
  assert.throws(() => recordAttempt(owner, terminal('a', 'captured', { observedAt: 201 }), 500), /after ready expiry/);
});

test('legacy owners have no status and new ids may be used after expiry', () => {
  const owner = {};
  assert.equal(attemptStatus(owner, 100), undefined);
  recordAttempt(owner, ready('old'), 110);
  recordAttempt(owner, ready('new', { expiresAt: 300 }), 210);
  const status = attemptStatus(owner, 150);
  assert.equal(status.id, 'new'); assert.equal(status.phase, 'ready');
});

test('durable owner field survives JSON reload and explicit expiry is terminal', () => {
  const owner = {};
  recordAttempt(owner, ready(), 110);
  const reloaded = JSON.parse(JSON.stringify(owner));
  const expired = recordAttempt(reloaded, { id: 'a', phase: 'expired', evidence: 'deadline reached', observedAt: 200 }, 200);
  assert.equal(expired.phase, 'expired');
  assert.equal(attemptStatus(reloaded, 201).phase, 'expired');
  assert.throws(() => recordAttempt(reloaded, ready('a', { expiresAt: 400 }), 210), /cannot reopen/);
  const duplicate = recordAttempt(reloaded, { id: 'a', phase: 'expired', evidence: 'deadline reached', observedAt: 200 }, 210);
  assert.equal(duplicate.phase, 'expired'); assert.equal(duplicate.id, expired.id); assert.equal(duplicate.delayedReporting, true);
});
