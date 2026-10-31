// Stable, bounded projection for task_dispatch_status. Keep this separate from
// admission and collection so summary reads cannot change execution semantics.
const own = (value, key) => value?.[key] === undefined ? {} : { [key]: value[key] };

function taskWorkSummary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return {
    ...own(value, 'steps'),
    ...own(value, 'continuations'),
    ...own(value, 'due'),
    ...own(value, 'limits'),
  };
}

function checkpointSummary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return {
    ...own(value, 'due'),
    ...own(value, 'highContext'),
    ...own(value, 'taskReview'),
    ...own(value, 'limits'),
  };
}

function verificationSummary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const summary = {};
  for (const key of ['id', 'phase', 'expiresAt', 'expired', 'readiness', 'failureKey', 'livenessVerified', 'selfReported', 'delayedReporting']) {
    if (value[key] !== undefined) summary[key] = value[key];
  }
  return summary;
}

function externalGrantSummary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const summary = {};
  for (const key of ['grantID', 'expiresAt', 'expiry']) if (value[key] !== undefined) summary[key] = value[key];
  return summary;
}

function routingSummary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const selected = value.selected;
  const effort = value.effort ?? (typeof selected === 'string' && selected.includes('#') ? selected.split('#').at(-1) : undefined);
  return { ...own(value, 'selected'), ...own(value, 'effort'), ...(effort === undefined || value.effort !== undefined ? {} : { effort }) };
}

function ownerSummary(owner) {
  const summary = {};
  for (const key of ['taskId', 'workKey', 'childID', 'parentID', 'agent', 'operation', 'intentRevision', 'checkIds', 'admissionGeneration', 'compactionID', 'compactionOutcome', 'recordedState', 'effectiveState', 'nativeExecution', 'collection', 'writePaths', 'rebind', 'needsRebind', 'denial', 'continuationOwner', 'activeDescendants', 'inFlight']) {
    if (owner?.[key] !== undefined) summary[key] = owner[key];
  }
  if (owner?.routing !== undefined) summary.routing = routingSummary(owner.routing);
  if (owner?.workCheckpoint !== undefined) summary.workCheckpoint = checkpointSummary(owner.workCheckpoint);
  if (owner?.verificationAttempt !== undefined) summary.verificationAttempt = verificationSummary(owner.verificationAttempt);
  if (owner?.externalWrites !== undefined) summary.externalWrites = owner.externalWrites;
  if (owner?.externalGrant !== undefined) summary.externalGrant = externalGrantSummary(owner.externalGrant);
  // `attention` is the current self-reported user blocker. Retain its
  // actionable fields while avoiding any accidental expansion of the record.
  if (owner?.attention !== undefined) summary.blocker = owner.attention;
  if (owner?.convergence !== undefined) summary.convergence = owner.convergence;
  return summary;
}

export function summarizeTaskDispatchStatus(status) {
  if (!status || typeof status !== 'object' || Array.isArray(status)) return status;
  return {
    owners: Array.isArray(status.owners) ? status.owners.map(ownerSummary) : [],
    ...own(status, 'quotaRecoveryPending'),
    ...(status.taskWork === undefined ? {} : { taskWork: taskWorkSummary(status.taskWork) }),
    ...own(status, 'userActions'),
    ...own(status, 'existingUntracked'),
    ...own(status, 'workspaceActive'),
  };
}
