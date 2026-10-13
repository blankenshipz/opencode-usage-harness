const phases = ['ready', 'captured', 'failed', 'expired'];
const terminalPhases = new Set(['captured', 'failed']);
const fields = new Set(['id', 'phase', 'expectedSignal', 'receipt', 'observedAt', 'expiresAt', 'readiness', 'evidence', 'failureKey']);
const readinessFields = new Set(['receiver', 'observer', 'recorder']);

// This is metadata about a human/device attempt. It never probes a device or
// infers that a signal is live.
export const attemptSchema = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 128, pattern: '^\\S+$' },
    phase: { type: 'string', enum: phases },
    expectedSignal: { type: 'string', minLength: 1, maxLength: 500 },
    receipt: { type: 'string', minLength: 1, maxLength: 500 },
    observedAt: { type: 'integer', minimum: 0 },
    expiresAt: { type: 'integer', minimum: 0 },
    readiness: { type: 'object', additionalProperties: false, required: ['receiver', 'observer', 'recorder'], properties: { receiver: { type: 'boolean' }, observer: { type: 'boolean' }, recorder: { type: 'boolean' } } },
    evidence: { type: 'string', minLength: 1, maxLength: 500 },
    failureKey: { type: 'string', minLength: 1, maxLength: 128, pattern: '^\\S+$' },
  },
  required: ['id', 'phase', 'observedAt'],
});

const text = (value, name, max, noWhitespace = false) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\r\n]/.test(value) || (noWhitespace && /\s/.test(value))) throw new TypeError(`verification-attempt: invalid ${name}`);
  return value;
};
const timestamp = (value, name) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`verification-attempt: invalid ${name}`);
  return value;
};

export function normalizeAttempt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.has(key))) throw new TypeError('verification-attempt: invalid attempt fields');
  const id = text(value.id, 'id', 128, true);
  if (!phases.includes(value.phase)) throw new TypeError('verification-attempt: invalid phase');
  const observedAt = timestamp(value.observedAt, 'observedAt');
  const result = { id, phase: value.phase, observedAt };
  if (value.expectedSignal !== undefined) result.expectedSignal = text(value.expectedSignal, 'expectedSignal', 500);
  if (value.receipt !== undefined) {
    const receipt = text(value.receipt, 'receipt', 500);
    if (receipt.includes('://')) throw new TypeError('verification-attempt: receipt must be a private reference');
    result.receipt = receipt;
  }
  if (value.expiresAt !== undefined) result.expiresAt = timestamp(value.expiresAt, 'expiresAt');
  if (value.readiness !== undefined) {
    if (!value.readiness || typeof value.readiness !== 'object' || Array.isArray(value.readiness) || Object.keys(value.readiness).some(key => !readinessFields.has(key)) || Object.keys(value.readiness).length !== 3 || Object.values(value.readiness).some(item => typeof item !== 'boolean')) throw new TypeError('verification-attempt: invalid readiness');
    result.readiness = { receiver: value.readiness.receiver, observer: value.readiness.observer, recorder: value.readiness.recorder };
  }
  if (value.evidence !== undefined) result.evidence = text(value.evidence, 'evidence', 500);
  if (value.failureKey !== undefined) result.failureKey = text(value.failureKey, 'failureKey', 128, true);
  if (value.phase === 'ready') {
    if (result.expectedSignal === undefined || result.receipt === undefined || result.expiresAt === undefined || !result.readiness || !Object.values(result.readiness).every(Boolean)) throw new TypeError('verification-attempt: ready requires signal, receipt, expiry, and readiness');
  } else if (result.evidence === undefined) {
    throw new TypeError('verification-attempt: terminal attempt requires evidence');
  }
  return result;
}

const ownerAttempt = owner => {
  if (!owner || typeof owner !== 'object' || Array.isArray(owner)) throw new TypeError('verification-attempt: invalid owner');
  return owner.verificationAttempt;
};
const copy = value => value === undefined ? undefined : structuredClone(value);

export function recordAttempt(owner, attempt, now = Date.now()) {
  const normalized = normalizeAttempt(attempt), currentTime = timestamp(now, 'now');
  const prior = ownerAttempt(owner);
  if (normalized.observedAt > currentTime) throw new Error('verification-attempt: observedAt is in the future');
  if (normalized.phase === 'ready') {
    if (normalized.expiresAt <= normalized.observedAt || normalized.expiresAt <= currentTime) throw new Error('verification-attempt: ready attempt is already expired');
    if (prior && prior.id === normalized.id) {
      if (prior.phase !== 'ready') throw new Error('verification-attempt: terminal attempt cannot reopen');
      if (currentTime >= prior.expiresAt) throw new Error('verification-attempt: expired ready attempt cannot reopen');
      if (normalized.observedAt < prior.observedAt) throw new Error('verification-attempt: stale ready attempt');
      return statusRecord(prior, currentTime);
    }
    if (prior?.phase === 'ready' && currentTime < prior.expiresAt) throw new Error('verification-attempt: active ready attempt must expire or terminate first');
    owner.verificationAttempt = copy(normalized);
    return statusRecord(normalized, currentTime);
  }
  if (normalized.phase === 'expired') {
    if (prior?.id === normalized.id && prior.phase === 'expired' && JSON.stringify({ ...normalized, expectedSignal: prior.expectedSignal, receipt: prior.receipt, expiresAt: prior.expiresAt, readiness: prior.readiness }) === JSON.stringify(prior)) return statusRecord(prior, currentTime);
    if (!prior || prior.id !== normalized.id || prior.phase !== 'ready') throw new Error('verification-attempt: expiry requires a known ready attempt');
    if (currentTime < prior.expiresAt || normalized.observedAt < prior.expiresAt) throw new Error('verification-attempt: expiry is before ready deadline');
    const expired = { ...normalized, expectedSignal: prior.expectedSignal, receipt: prior.receipt, expiresAt: prior.expiresAt, readiness: prior.readiness };
    owner.verificationAttempt = copy(expired);
    return statusRecord(expired, currentTime);
  }
  if (!terminalPhases.has(normalized.phase)) throw new Error('verification-attempt: invalid record phase');
  if (!prior || prior.id !== normalized.id || prior.phase !== 'ready') {
    if (prior?.id === normalized.id && terminalPhases.has(prior.phase) && JSON.stringify({ ...normalized, expectedSignal: prior.expectedSignal, receipt: prior.receipt, expiresAt: prior.expiresAt, readiness: prior.readiness }) === JSON.stringify(prior)) return statusRecord(prior, currentTime);
    throw new Error('verification-attempt: terminal attempt requires a known ready attempt');
  }
  if (normalized.observedAt < prior.observedAt) throw new Error('verification-attempt: stale terminal attempt');
  if (normalized.observedAt > prior.expiresAt) throw new Error('verification-attempt: observed after ready expiry');
  if (normalized.expectedSignal !== undefined && normalized.expectedSignal !== prior.expectedSignal) throw new Error('verification-attempt: signal does not match ready attempt');
  if (normalized.receipt !== undefined && normalized.receipt !== prior.receipt) throw new Error('verification-attempt: receipt does not match ready attempt');
  const completed = { ...normalized, expectedSignal: prior.expectedSignal, receipt: prior.receipt, expiresAt: prior.expiresAt, readiness: prior.readiness };
  owner.verificationAttempt = copy(completed);
  return statusRecord(completed, currentTime);
}

function statusRecord(attempt, now) {
  const expired = attempt.phase === 'expired' || (attempt.phase === 'ready' && now >= attempt.expiresAt);
  return { ...copy(attempt), ...(expired ? { phase: 'expired' } : {}), expired, delayedReporting: attempt.phase !== 'ready' && now > attempt.expiresAt, selfReported: true, livenessVerified: false };
}

export function attemptStatus(owner, now = Date.now()) {
  const attempt = ownerAttempt(owner);
  return attempt === undefined ? undefined : statusRecord(attempt, timestamp(now, 'now'));
}
