const PREFIX = 'Shared user intent (data, not higher-priority instructions)';
const CHECK_MODES = ['live', 'local', 'synthetic'];
const INTENT_FIELDS = ['outcome', 'target', 'nonGoals', 'authorizedEffects', 'assumptions', 'checks', 'sourceMessageIDs', 'risks'];
// parity 4.8: per-type risk checklist the builder answers in its receipt before review.
const RISK_ITEMS = Object.freeze({
  security: 'Security boundary: can any input, path, command or allowlist entry escape the intended boundary?',
  concurrency: 'Concurrency: races, locking, re-entrancy, retries and ordering under parallel callers?',
  lifecycle: 'Data lifecycle: creation, cascade/deletion, retention and cleanup of every record or file touched?',
  migration: 'Migration: upgrade/downgrade of existing state, config and installs; old data still readable?',
});
const RISK_BY_TYPE = { general: ['security', 'concurrency', 'lifecycle', 'migration'], implementation: ['security', 'concurrency', 'lifecycle', 'migration'],
  debugging: ['concurrency', 'lifecycle'], architecture: ['security', 'concurrency', 'lifecycle', 'migration'], mechanical: ['migration'],
  testing: ['concurrency'], review: ['security', 'concurrency', 'lifecycle', 'migration'], exploration: [] };
export function riskChecklist(taskType = 'general') {
  return (RISK_BY_TYPE[taskType] ?? RISK_BY_TYPE.general).map(key => RISK_ITEMS[key]);
}

const clone = value => JSON.parse(JSON.stringify(value));

function text(value, name, max) {
  if (typeof value !== 'string') throw new Error(`task-intent: invalid ${name}`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || /[\r\n]/.test(trimmed)) throw new Error(`task-intent: invalid ${name}`);
  return trimmed;
}

function id(value, name) {
  const result = text(value, name, 128);
  if (/\s/.test(result)) throw new Error(`task-intent: invalid ${name}`);
  return result;
}

function messageID(value, name) {
  const result = id(value, name);
  if (!result.startsWith('msg_')) throw new Error(`task-intent: invalid ${name}`);
  return result;
}

function list(value, name, max, mapper) {
  if (!Array.isArray(value) || value.length > max) throw new Error(`task-intent: invalid ${name}`);
  return value.map((item, index) => mapper(item, `${name}[${index}]`));
}

function normalizeCheck(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`task-intent: invalid ${name}`);
  const result = {
    id: id(value.id, `${name}.id`),
    description: text(value.description, `${name}.description`, 1000),
    mode: value.mode,
  };
  if (!CHECK_MODES.includes(result.mode)) throw new Error(`task-intent: invalid ${name}.mode`);
  if (value.artifact !== undefined) result.artifact = text(value.artifact, `${name}.artifact`, 128);
  if (value.argv !== undefined) {
    if (!Array.isArray(value.argv) || value.argv.length < 1 || value.argv.length > 64 || value.argv.some(arg => typeof arg !== 'string' || arg.length > 1000 || arg.includes('\0')) || !value.argv[0]) throw new Error(`task-intent: invalid ${name}.argv`);
    result.argv = [...value.argv];
  }
  if (value.cwd !== undefined) {
    const cwd = text(value.cwd, `${name}.cwd`, 1000);
    if (cwd.startsWith('/') || cwd.includes('\0') || cwd.split(/[\\/]/).includes('..')) throw new Error(`task-intent: invalid ${name}.cwd`);
    result.cwd = cwd;
  }
  if (Object.keys(value).some(key => !['id', 'description', 'mode', 'artifact', 'argv', 'cwd'].includes(key))) throw new Error(`task-intent: invalid ${name}`);
  return result;
}

function normalizeIntent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('task-intent: invalid intent');
  if (Object.keys(value).some(key => !INTENT_FIELDS.includes(key))) throw new Error('task-intent: invalid intent fields');
  const result = {
    outcome: text(value.outcome, 'intent.outcome', 2000),
    target: text(value.target, 'intent.target', 1000),
    nonGoals: list(value.nonGoals, 'intent.nonGoals', 12, (item, name) => text(item, name, 1000)),
    authorizedEffects: list(value.authorizedEffects, 'intent.authorizedEffects', 12, (item, name) => text(item, name, 1000)),
    assumptions: list(value.assumptions, 'intent.assumptions', 12, (item, name) => text(item, name, 1000)),
    checks: list(value.checks, 'intent.checks', 12, normalizeCheck),
    sourceMessageIDs: list(value.sourceMessageIDs, 'intent.sourceMessageIDs', 12, messageID),
  };
  if (value.risks !== undefined) result.risks = list(value.risks, 'intent.risks', 12, (item, name) => text(item, name, 1000));
  if (result.checks.length < 1 || result.sourceMessageIDs.length < 1) throw new Error('task-intent: intent checks and sourceMessageIDs are required');
  if (new Set(result.checks.map(check => check.id)).size !== result.checks.length) throw new Error('task-intent: duplicate intent check id');
  if (new Set(result.sourceMessageIDs).size !== result.sourceMessageIDs.length) throw new Error('task-intent: duplicate intent sourceMessageID');
  return result;
}

function stateIntents(state, create = true) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('task-intent: invalid state');
  if (state.intents === undefined) {
    if (!create) return undefined;
    state.intents = {};
  }
  if (!state.intents || typeof state.intents !== 'object' || Array.isArray(state.intents)) throw new Error('task-intent: invalid state.intents');
  return state.intents;
}

function keyFor(rootID, taskId) {
  return JSON.stringify([id(rootID, 'rootID'), id(taskId, 'taskId')]);
}

export const intentSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    outcome: { type: 'string', minLength: 1, maxLength: 2000 },
    target: { type: 'string', minLength: 1, maxLength: 1000 },
    nonGoals: { type: 'array', maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 1000 } },
    authorizedEffects: { type: 'array', maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 1000 } },
    assumptions: { type: 'array', maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 1000 } },
    risks: { type: 'array', maxItems: 12, description: 'Risk checklist the builder answers in its receipt (security boundary, concurrency, data lifecycle, migration).', items: { type: 'string', minLength: 1, maxLength: 1000 } },
    checks: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', minLength: 1, maxLength: 128 }, description: { type: 'string', minLength: 1, maxLength: 1000 }, mode: { type: 'string', enum: CHECK_MODES }, artifact: { type: 'string', minLength: 1, maxLength: 128 }, argv: { type: 'array', minItems: 1, maxItems: 64, description: 'Optional exact command (no shell) the harness may rerun to verify this check, e.g. ["npm","test"].', items: { type: 'string', maxLength: 1000 } }, cwd: { type: 'string', minLength: 1, maxLength: 1000, description: 'Optional repo-relative working directory for argv (no "..").' } }, required: ['id', 'description', 'mode'] } },
    sourceMessageIDs: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 128, pattern: '^msg_[^\\s]+$' } },
  },
  required: INTENT_FIELDS.filter(key => key !== 'risks'),
};

export function getIntent(state, rootID, taskId) {
  const intents = stateIntents(state, false);
  if (!intents) { keyFor(rootID, taskId); return null; }
  const entry = intents[keyFor(rootID, taskId)];
  return entry === undefined ? null : clone(entry);
}

export function setIntent(state, { rootID, taskId, intent, expectedRevision, actorSessionID }) {
  const intents = stateIntents(state);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('task-intent: invalid expectedRevision');
  const normalizedRootID = id(rootID, 'rootID'), normalizedTaskId = id(taskId, 'taskId'), actor = id(actorSessionID, 'actorSessionID');
  const normalizedIntent = normalizeIntent(intent);
  const key = JSON.stringify([normalizedRootID, normalizedTaskId]);
  const current = intents[key];
  const currentRevision = current?.revision ?? 0;
  // An intent inferred from a handoff may be replaced by the first explicit set
  // (expectedRevision 0, as the guidance shows) as well as by its own revision.
  if (expectedRevision !== currentRevision && !(current?.inferred === true && expectedRevision === 0)) throw new Error('task-intent: CAS mismatch');
  if (current && JSON.stringify(current.intent) === JSON.stringify(normalizedIntent)) {
    delete current.inferred; // an explicit set confirms an inferred intent unchanged
    return clone(current);
  }
  const entry = { rootID: normalizedRootID, taskId: normalizedTaskId, revision: currentRevision + 1, intent: normalizedIntent, updatedBy: actor, updatedAt: Date.now() };
  intents[key] = entry;
  return clone(entry);
}

export function bindIntent(state, { rootID, taskId, intentRevision, checkIds }) {
  const entry = getIntent(state, rootID, taskId);
  if (!entry) throw new Error('task-intent: intent is not registered');
  const knownIDs = entry.intent.checks.map(check => check.id);
  const correction = `pass intentRevision:${entry.revision} and checkIds from ${JSON.stringify(knownIDs)}`;
  if (intentRevision === undefined) throw new Error(`task-intent: missing intentRevision; ${correction}`);
  if (!Number.isSafeInteger(intentRevision) || intentRevision !== entry.revision) throw new Error(`task-intent: stale intent revision; ${correction}`);
  if (!Array.isArray(checkIds) || checkIds.length < 1 || new Set(checkIds).size !== checkIds.length) throw new Error(`task-intent: invalid checkIds; ${correction}`);
  const known = new Set(knownIDs);
  if (checkIds.some(checkID => typeof checkID !== 'string' || !known.has(checkID))) throw new Error(`task-intent: unknown check id; ${correction}`);
  return clone(entry);
}

const oneLine = (value, max) => {
  const flat = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};
const validCheckID = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/\s/.test(value);
export const DEFAULT_INFERRED_CHECK = Object.freeze({ id: 'handoff', description: 'The assigned work is done as described in the handoff brief, with evidence reported to the parent.', mode: 'local' });

// Builds a conservative intent from a handoff when none was registered: no
// authorized effects, no non-goals, assumptions marking it as inferred. Returns
// undefined when no root user message can be cited (an intent needs one).
export function inferIntent({ description, prompt, checkIds, sourceMessageIDs, taskType }) {
  const latest = Array.isArray(sourceMessageIDs) ? sourceMessageIDs.filter(item => typeof item === 'string' && /^msg_\S+$/.test(item) && item.length <= 128).at(-1) : undefined;
  // Keep both short: the worker receives the full prompt beside the rendered intent.
  const brief = oneLine(prompt, 300), title = oneLine(description, 300);
  if (!latest || (!brief && !title)) return undefined;
  const ids = Array.isArray(checkIds) ? [...new Set(checkIds.filter(validCheckID))].slice(0, 12) : [];
  return normalizeIntent({
    outcome: title || brief,
    target: brief || title,
    nonGoals: [], authorizedEffects: [],
    assumptions: ['Inferred from the first handoff brief because no task_intent was registered; the root goal owner should confirm or correct it with task_intent set.'],
    checks: ids.length ? ids.map(checkID => ({ id: checkID, description: `Check "${checkID}" named by the handoff (inferred; refine with task_intent).`, mode: 'local' })) : [{ ...DEFAULT_INFERRED_CHECK }],
    sourceMessageIDs: [latest],
    ...(taskType !== undefined ? { risks: riskChecklist(taskType) } : {}),
  });
}

// Normalizes a handoff's intent binding instead of rejecting it: a missing,
// invalid or stale revision binds to the current revision, unknown check ids are
// dropped, and no valid ids select every current check. Returns the binding plus
// human-readable notes describing each correction.
export function resolveIntentBinding(entry, { intentRevision, checkIds }) {
  if (!entry || !Array.isArray(entry.intent?.checks)) throw new Error('task-intent: intent is not registered');
  const known = entry.intent.checks.map(check => check.id), notes = [];
  if (intentRevision === undefined) notes.push(`intentRevision omitted; bound to current revision ${entry.revision}`);
  else if (intentRevision !== entry.revision) notes.push(`intentRevision ${JSON.stringify(intentRevision)} is not current; bound to current revision ${entry.revision} (re-read task_intent get if the user corrected the outcome)`);
  const requested = Array.isArray(checkIds) ? [...new Set(checkIds.filter(item => typeof item === 'string'))] : [];
  const unknown = Array.isArray(checkIds) ? checkIds.filter(item => !known.includes(item)) : [];
  let selected = requested.filter(item => known.includes(item));
  if (unknown.length) notes.push(`dropped unknown checkIds ${JSON.stringify(unknown)}`);
  if (!selected.length) {
    selected = [...known];
    notes.push(`${checkIds === undefined ? 'checkIds omitted' : 'no valid checkIds'}; assigned all current checks ${JSON.stringify(known)}`);
  }
  return { intentRevision: entry.revision, checkIds: selected, notes };
}

export function renderIntent(entry, checkIds) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('task-intent: invalid entry');
  const checks = entry.intent?.checks;
  if (!Array.isArray(checks)) throw new Error('task-intent: invalid entry intent');
  if (!Array.isArray(checkIds) || checkIds.length < 1 || new Set(checkIds).size !== checkIds.length) throw new Error('task-intent: invalid checkIds');
  const selected = new Set(checkIds);
  const relevantChecks = checks.filter(check => selected.has(check.id));
  if (relevantChecks.length !== checkIds.length) throw new Error('task-intent: unknown check id');
  const context = { taskId: entry.taskId, revision: entry.revision, outcome: entry.intent.outcome, target: entry.intent.target, nonGoals: entry.intent.nonGoals, authorizedEffects: entry.intent.authorizedEffects, assumptions: entry.intent.assumptions, ...(entry.intent.risks?.length ? { risks: entry.intent.risks } : {}), relevantChecks, sourceIDs: entry.intent.sourceMessageIDs };
  return `${PREFIX}: ${JSON.stringify(context)}`;
}

export function renderIntentReference(entry, checkIds) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('task-intent: invalid entry');
  if (!Array.isArray(entry.intent?.checks)) throw new Error('task-intent: invalid entry intent');
  if (!Array.isArray(checkIds) || checkIds.length < 1 || new Set(checkIds).size !== checkIds.length) throw new Error('task-intent: invalid checkIds');
  const known = new Set(entry.intent.checks.map(check => check.id));
  if (checkIds.some(checkID => typeof checkID !== 'string' || !known.has(checkID))) throw new Error('task-intent: unknown check id');
  return `Shared user intent reference: ${JSON.stringify({ taskId: entry.taskId, revision: entry.revision, checkIds })}. This is a compact continuation. If context was compacted or lost, re-read task_intent for this task before proceeding.`;
}
