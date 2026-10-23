import crypto from 'node:crypto';

const telemetryReasons = new Set(['initialization_failed', 'quota_rpc_failed', 'invalid_response',
  'unexpected_eof', 'timeout', 'executable_missing', 'permission_denied', 'process_io_failed', 'unknown_failure']);
const categories = new Set(['telemetry_failure', 'policy_denial']);
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 500 && !/[\0\r\n]/.test(value);
const generation = value => Number.isSafeInteger(value) && value > 0;
const requestKinds = new Set(['dispatch','compaction']);
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

// A quota receipt is deliberately narrower than the guard error. It carries no
// subprocess diagnostics and has no execution instruction: dispatch owns whether
// a child is resumed, while this module only preserves a parent notification.
export function quotaRecoveryReceipt({ error, parentID, childID, generation: targetGeneration, requestKind = 'dispatch', compactionID, now = Date.now }) {
  if (error?.code !== 'SUBSCRIPTION_QUOTA_CHECK_FAILED' || !identifier(parentID) || !identifier(childID) || !generation(targetGeneration)) return;
  if (!requestKinds.has(requestKind) || (requestKind === 'compaction' && !identifier(compactionID))) return;
  const category = error?.quota?.category;
  const detail = error?.detail;
  if (!categories.has(category) || !detail || typeof detail !== 'object' ||
      (category === 'telemetry_failure' && !['telemetry_unavailable','timeout'].includes(detail.reason)) ||
      (category === 'policy_denial' && detail.reason !== 'policy_denied')) return;
  const telemetryReason = category === 'telemetry_failure' && telemetryReasons.has(detail.telemetry_reason) ? detail.telemetry_reason : undefined;
  const target = { parentID, childID, generation: targetGeneration, ...(requestKind === 'compaction' ? {requestKind,compactionID} : {}) };
  const id = digest({ type: 'quota_admission_blocked', category, telemetryReason, target });
  return { id, type: 'quota_admission_blocked', category, ...(telemetryReason ? { telemetryReason } : {}), target,
    recordedAt: Math.max(0, Math.trunc(now())) };
}

const validReceipt = value => value && value.type === 'quota_admission_blocked' && typeof value.id === 'string' &&
  categories.has(value.category) && identifier(value.target?.parentID) && identifier(value.target?.childID) && generation(value.target?.generation) && requestKinds.has(value.target?.requestKind ?? 'dispatch') &&
  ((value.target?.requestKind ?? 'dispatch') !== 'compaction' || identifier(value.target?.compactionID)) &&
  (value.telemetryReason === undefined || telemetryReasons.has(value.telemetryReason));

export function enqueueQuotaRecovery(state, receipt) {
  if (!validReceipt(receipt)) throw new Error('quota-recovery: invalid receipt');
  const outbox = Array.isArray(state.quotaRecoveryOutbox) ? state.quotaRecoveryOutbox : (state.quotaRecoveryOutbox = []);
  const existing = outbox.find(entry => entry.id === receipt.id);
  if (existing) return existing;
  if (outbox.filter(entry => validReceipt(entry) && entry.deliveredAt === undefined).length >= 32)
    throw new Error('quota-recovery: pending outbox limit reached; inspect and deliver existing receipts before admitting another recovery notice');
  const stored = { ...receipt };
  outbox.push(stored);
  return stored;
}

export function pendingQuotaRecovery(state, target) {
  const outbox = Array.isArray(state?.quotaRecoveryOutbox) ? state.quotaRecoveryOutbox : [];
  return outbox.filter(entry => validReceipt(entry) && entry.deliveredAt === undefined && (!target ||
    (target.parentID === undefined || entry.target.parentID === target.parentID) &&
    (target.childID === undefined || entry.target.childID === target.childID) &&
    (target.generation === undefined || entry.target.generation === target.generation) &&
    (target.requestKind === undefined || entry.target.requestKind === target.requestKind) &&
    (target.compactionID === undefined || entry.target.compactionID === target.compactionID)));
}

export function markQuotaRecoveryDelivered(state, id, now = Date.now) {
  const entry = Array.isArray(state?.quotaRecoveryOutbox) && state.quotaRecoveryOutbox.find(candidate => candidate.id === id);
  if (!validReceipt(entry)) throw new Error('quota-recovery: unknown receipt');
  if (entry.deliveredAt === undefined) entry.deliveredAt = Math.max(0, Math.trunc(now()));
  return entry;
}

// Delivery is intentionally independent from child execution. If the process
// stops after a notifier accepts the receipt but before state is saved, the same
// deterministic id is delivered again; notifier-side idempotency makes that safe.
export async function deliverQuotaRecovery({ state, notify, target, now = Date.now }) {
  if (typeof notify !== 'function') throw new Error('quota-recovery: notifier is required');
  const delivered = [];
  for (const entry of pendingQuotaRecovery(state, target)) {
    await notify({ receiptID: entry.id, parentID: entry.target.parentID, childID: entry.target.childID,
      generation: entry.target.generation, ...(entry.target.requestKind ? {requestKind:entry.target.requestKind} : {}), ...(entry.target.compactionID ? {compactionID:entry.target.compactionID} : {}), category: entry.category, ...(entry.telemetryReason ? { telemetryReason: entry.telemetryReason } : {}) });
    markQuotaRecoveryDelivered(state, entry.id, now);
    delivered.push(entry.id);
  }
  return { delivered, pending: pendingQuotaRecovery(state, target).map(entry => entry.id) };
}

export function quotaRecoverySyntheticInput(notice) {
  return {sessionID:notice.parentID,id:`msg_quota_${notice.receiptID}`,resume:false,
    text:`Quota admission blocked for child ${notice.childID}. Receipt ${notice.receiptID}; inspect task_dispatch_status before any explicit recovery.`,
    metadata:{type:'quota_admission_blocked',receiptID:notice.receiptID,childID:notice.childID,generation:notice.generation,requestKind:notice.requestKind, ...(notice.compactionID ? {compactionID:notice.compactionID} : {}),category:notice.category}};
}
