import crypto from 'node:crypto';

// Receipt semantics, not prose, timestamps, or token volume, define observed
// progress. Missing receipts mean unknown progress, never proof of wasted work.
export function observeAdmission(record, state, input, rootID) {
  const evidence = state.intentEvidence?.[JSON.stringify([rootID, input.taskId])];
  const checks = [...(input.checkIds ?? [])].sort().map(id => {
    const r = evidence?.revision === input.intentRevision ? evidence.checks?.[id] : undefined;
    return [id, r?.status, r?.mode, r?.freshness, r?.artifact?.subject, r?.artifact?.revision, r?.artifact?.generation];
  });
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify([input.intentRevision, input.operation, checks])).digest('hex');
  const prior = record.convergence;
  record.convergence = { fingerprint, admissions: prior?.fingerprint === fingerprint ? Math.min((prior.admissions ?? 0) + 1, 1000000) : 1 };
  return convergenceAdvice(record);
}

export function convergenceAdvice(record) {
  if ((record.convergence?.admissions ?? 0) < 3) return undefined;
  return { admissionsWithoutReceiptChange: record.convergence.admissions, advisory: 'Repeated dispatches without changed assigned-check receipts. Progress may be unrecorded: inspect the last artifact/checkpoint or concrete failure, then give the same owner one next action. Diagnose unchanged failures before another attempt; preserve unaffected passing checks. Do not infer a stall, replace a worker, or add review from this count alone.' };
}

export function userActions(records, revision) {
  return records.filter(r => r.intentRevision === revision && r.attention?.intentRevision === revision && r.attention?.progressState === 'needs_user_action')
    .map(r => ({ sessionID: r.childID, taskId: r.taskId, workKey: r.workKey, ...r.attention }));
}
