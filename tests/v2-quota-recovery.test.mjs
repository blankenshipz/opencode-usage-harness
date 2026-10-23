import test from 'node:test';
import assert from 'node:assert/strict';
import { quotaRecoveryReceipt, enqueueQuotaRecovery, pendingQuotaRecovery, deliverQuotaRecovery } from '../plugins/v2/quota-recovery.mjs';

const quotaError = (category, reason, telemetry_reason) => Object.assign(new Error('private subprocess text'), {
  code: 'SUBSCRIPTION_QUOTA_CHECK_FAILED', quota: { category }, detail: { reason, telemetry_reason },
});
const target = { parentID: 'ses_parent', childID: 'ses_child', generation: 7 };

test('quota recovery receipt is closed-set, sanitized, and binds its parent child and generation', () => {
  const telemetry = quotaRecoveryReceipt({ error: quotaError('telemetry_failure', 'telemetry_unavailable', 'quota_rpc_failed'), ...target, now: () => 10 });
  assert.deepEqual(telemetry, {
    id: telemetry.id, type: 'quota_admission_blocked', category: 'telemetry_failure', telemetryReason: 'quota_rpc_failed',
    target, recordedAt: 10,
  });
  const policy = quotaRecoveryReceipt({ error: quotaError('policy_denial', 'policy_denied'), ...target, now: () => 11 });
  assert.equal(policy.category, 'policy_denial');
  assert.equal(policy.telemetryReason, undefined);
  assert.equal(quotaRecoveryReceipt({ error: quotaError('telemetry_failure', 'policy_denied'), ...target }), undefined);
  const unknownTelemetry = quotaRecoveryReceipt({ error: quotaError('telemetry_failure', 'telemetry_unavailable', 'private_reason'), ...target });
  assert.equal(unknownTelemetry.telemetryReason, undefined);
  assert.equal(JSON.stringify(telemetry).includes('private subprocess text'), false);
});

test('quota recovery outbox persists failed notification, de-duplicates across restart, and never executes a child', async () => {
  const receipt = quotaRecoveryReceipt({ error: quotaError('telemetry_failure', 'telemetry_unavailable', 'timeout'), ...target, now: () => 10 });
  const state = {};
  enqueueQuotaRecovery(state, receipt);
  enqueueQuotaRecovery(state, structuredClone(receipt));
  assert.equal(state.quotaRecoveryOutbox.length, 1);

  const restarted = structuredClone(state);
  let calls = 0;
  await assert.rejects(deliverQuotaRecovery({ state: restarted, notify: async () => { calls++; throw new Error('notifier offline'); }, now: () => 20 }), /notifier offline/);
  assert.equal(calls, 1);
  assert.deepEqual(pendingQuotaRecovery(restarted).map(entry => entry.id), [receipt.id]);

  const delivered = [];
  const result = await deliverQuotaRecovery({ state: restarted, notify: async value => delivered.push(value), now: () => 30 });
  assert.deepEqual(result, { delivered: [receipt.id], pending: [] });
  assert.deepEqual(delivered, [{ receiptID: receipt.id, parentID: 'ses_parent', childID: 'ses_child', generation: 7,
    category: 'telemetry_failure', telemetryReason: 'timeout' }]);
  await deliverQuotaRecovery({ state: restarted, notify: async () => { throw new Error('already delivered'); } });
  assert.equal(restarted.quotaRecoveryOutbox[0].deliveredAt, 30);
});

test('quota recovery delivery targets an exact generation and leaves another generation pending', async () => {
  const state = {};
  const first = quotaRecoveryReceipt({ error: quotaError('policy_denial', 'policy_denied'), ...target });
  const next = quotaRecoveryReceipt({ error: quotaError('policy_denial', 'policy_denied'), ...target, generation: 8 });
  enqueueQuotaRecovery(state, first); enqueueQuotaRecovery(state, next);
  const sent = [];
  await deliverQuotaRecovery({ state, target, notify: async receipt => sent.push(receipt.receiptID) });
  assert.deepEqual(sent, [first.id]);
  assert.deepEqual(pendingQuotaRecovery(state).map(entry => entry.id), [next.id]);
});
