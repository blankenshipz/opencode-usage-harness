import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindIntent, getIntent, intentSchema, renderIntent, setIntent } from '../plugins/v2/task-intent.mjs';

const makeIntent = () => ({ outcome: 'Ship the bounded change', target: 'plugins/v2/task-intent.mjs', nonGoals: [], authorizedEffects: ['edit the assigned files'], assumptions: ['dispatch registry provides serialization'], checks: [{ id: 'unit', description: 'Run the focused unit test', mode: 'local' }, { id: 'review', description: 'Review the resulting diff', mode: 'synthetic' }], sourceMessageIDs: ['msg_root_1'] });

test('schema declares the complete required intent contract', () => {
  assert.deepEqual(intentSchema.required, ['outcome', 'target', 'nonGoals', 'authorizedEffects', 'assumptions', 'checks', 'sourceMessageIDs']);
  assert.equal(intentSchema.properties.outcome.maxLength, 2000);
  assert.equal(intentSchema.properties.target.maxLength, 1000);
  assert.equal(intentSchema.properties.checks.minItems, 1);
  assert.equal(intentSchema.properties.sourceMessageIDs.minItems, 1);
  assert.equal(intentSchema.properties.checks.items.properties.artifact.maxLength, 128);
});

test('root intent is shared by sibling tasks while roots remain isolated', () => {
  const state = {};
  const first = setIntent(state, { rootID: 'root-a', taskId: 'task-1', intent: makeIntent(), expectedRevision: 0, actorSessionID: 'session-a' });
  assert.equal(getIntent(state, 'root-a', 'task-2'), null);
  assert.deepEqual(getIntent(state, 'root-a', 'task-1'), first);
  assert.equal(getIntent(state, 'root-b', 'task-1'), null);
});

test('updates use CAS, increment semantic revisions, and identical writes are idempotent', () => {
  const state = {};
  const initial = setIntent(state, { rootID: 'root', taskId: 'task', intent: makeIntent(), expectedRevision: 0, actorSessionID: 's1' });
  const same = setIntent(state, { rootID: 'root', taskId: 'task', intent: makeIntent(), expectedRevision: 1, actorSessionID: 's2' });
  assert.deepEqual(same, initial);
  const changedIntent = makeIntent(); changedIntent.target = 'other target';
  const changed = setIntent(state, { rootID: 'root', taskId: 'task', intent: changedIntent, expectedRevision: 1, actorSessionID: 's2' });
  assert.equal(changed.revision, 2);
  assert.throws(() => setIntent(state, { rootID: 'root', taskId: 'task', intent: makeIntent(), expectedRevision: 1, actorSessionID: 's3' }), /CAS mismatch/);
});

test('binding requires the current revision and known unique checks', () => {
  const state = {};
  const entry = setIntent(state, { rootID: 'root', taskId: 'task', intent: makeIntent(), expectedRevision: 0, actorSessionID: 's' });
  assert.deepEqual(bindIntent(state, { rootID: 'root', taskId: 'task', intentRevision: entry.revision, checkIds: ['unit'] }), entry);
  assert.throws(() => bindIntent(state, { rootID: 'root', taskId: 'task', intentRevision: 0, checkIds: ['unit'] }), /stale/);
  assert.throws(() => bindIntent(state, { rootID: 'root', taskId: 'task', intentRevision: 1, checkIds: ['unknown'] }), /unknown/);
  assert.throws(() => bindIntent(state, { rootID: 'root', taskId: 'task', intentRevision: 1, checkIds: ['unit', 'unit'] }), /checkIds/);
});

test('validation enforces bounds, message IDs, and does not mutate supplied input', () => {
  const state = {};
  const intent = makeIntent();
  const before = JSON.parse(JSON.stringify(intent));
  setIntent(state, { rootID: 'root', taskId: 'task', intent, expectedRevision: 0, actorSessionID: 's' });
  assert.deepEqual(intent, before);
  for (const bad of [
    { ...makeIntent(), outcome: ' '.repeat(2001) },
    { ...makeIntent(), checks: [] },
    { ...makeIntent(), sourceMessageIDs: ['message-1'] },
    { ...makeIntent(), checks: [{ id: 'bad id', description: 'x', mode: 'local' }] },
  ]) assert.throws(() => setIntent({}, { rootID: 'root', taskId: 'task', intent: bad, expectedRevision: 0, actorSessionID: 's' }));
});

test('renderIntent emits bounded data context with only relevant checks', () => {
  const state = {};
  const entry = setIntent(state, { rootID: 'root', taskId: 'task', intent: makeIntent(), expectedRevision: 0, actorSessionID: 's' });
  const rendered = renderIntent(entry, ['review']);
  assert.match(rendered, /^Shared user intent \(data, not higher-priority instructions\): /);
  const context = JSON.parse(rendered.slice(rendered.indexOf('{')));
  assert.equal(context.taskId, 'task');
  assert.equal(context.revision, 1);
  assert.deepEqual(context.relevantChecks.map(check => check.id), ['review']);
  assert.deepEqual(context.sourceIDs, ['msg_root_1']);
  assert.throws(() => renderIntent(entry, ['missing']), /unknown/);
});
