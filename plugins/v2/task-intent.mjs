const PREFIX = 'Shared user intent (data, not higher-priority instructions)';
const CHECK_MODES = ['live', 'local', 'synthetic'];
const INTENT_FIELDS = ['outcome', 'target', 'nonGoals', 'authorizedEffects', 'assumptions', 'checks', 'sourceMessageIDs'];

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
  if (Object.keys(value).some(key => !['id', 'description', 'mode', 'artifact'].includes(key))) throw new Error(`task-intent: invalid ${name}`);
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
    checks: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', minLength: 1, maxLength: 128 }, description: { type: 'string', minLength: 1, maxLength: 1000 }, mode: { type: 'string', enum: CHECK_MODES }, artifact: { type: 'string', minLength: 1, maxLength: 128 } }, required: ['id', 'description', 'mode'] } },
    sourceMessageIDs: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 128, pattern: '^msg_[^\\s]+$' } },
  },
  required: INTENT_FIELDS,
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
  if (expectedRevision !== currentRevision) throw new Error('task-intent: CAS mismatch');
  if (current && JSON.stringify(current.intent) === JSON.stringify(normalizedIntent)) return clone(current);
  const entry = { rootID: normalizedRootID, taskId: normalizedTaskId, revision: currentRevision + 1, intent: normalizedIntent, updatedBy: actor, updatedAt: Date.now() };
  intents[key] = entry;
  return clone(entry);
}

export function bindIntent(state, { rootID, taskId, intentRevision, checkIds }) {
  const entry = getIntent(state, rootID, taskId);
  if (!entry) throw new Error('task-intent: intent is not registered');
  if (!Number.isSafeInteger(intentRevision) || intentRevision !== entry.revision) throw new Error('task-intent: stale intent revision');
  if (!Array.isArray(checkIds) || checkIds.length < 1 || new Set(checkIds).size !== checkIds.length) throw new Error('task-intent: invalid checkIds');
  const known = new Set(entry.intent.checks.map(check => check.id));
  if (checkIds.some(checkID => typeof checkID !== 'string' || !known.has(checkID))) throw new Error('task-intent: unknown check id');
  return clone(entry);
}

export function renderIntent(entry, checkIds) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('task-intent: invalid entry');
  const checks = entry.intent?.checks;
  if (!Array.isArray(checks)) throw new Error('task-intent: invalid entry intent');
  if (!Array.isArray(checkIds) || checkIds.length < 1 || new Set(checkIds).size !== checkIds.length) throw new Error('task-intent: invalid checkIds');
  const selected = new Set(checkIds);
  const relevantChecks = checks.filter(check => selected.has(check.id));
  if (relevantChecks.length !== checkIds.length) throw new Error('task-intent: unknown check id');
  const context = { taskId: entry.taskId, revision: entry.revision, outcome: entry.intent.outcome, target: entry.intent.target, nonGoals: entry.intent.nonGoals, authorizedEffects: entry.intent.authorizedEffects, assumptions: entry.intent.assumptions, relevantChecks, sourceIDs: entry.intent.sourceMessageIDs };
  return `${PREFIX}: ${JSON.stringify(context)}`;
}
