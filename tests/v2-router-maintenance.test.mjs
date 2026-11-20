import { test } from 'node:test';
import assert from 'node:assert/strict';
import { holdWake, routerCompactionDue, createRouterCompactor, routerCompactionTokens, ROUTER_WAKE_HOLD_MS, ROUTER_COMPACTION_TOKENS } from '../plugins/v2/router-maintenance.mjs';
import { createResultDelivery } from '../plugins/v2/result-delivery.mjs';

const sibling = (key, state = 'running', status = 'pending') => ({ key, parentID: 'root', state, resultDelivery: { mode: 'background', status } });
test('wake hold applies only while a sibling background child runs, and is bounded', () => {
  const base = { key: 'a', parentID: 'root', settledAt: 1000, now: 2000 };
  assert.equal(holdWake({ ...base, records: [sibling('a'), sibling('b')] }), true);
  assert.equal(holdWake({ ...base, records: [sibling('a'), sibling('b', 'completed')] }), false);
  assert.equal(holdWake({ ...base, records: [sibling('a'), sibling('b', 'running', 'delivered')] }), false);
  assert.equal(holdWake({ ...base, records: [sibling('a'), { ...sibling('b'), parentID: 'other' }] }), false);
  assert.equal(holdWake({ ...base, now: 1000 + ROUTER_WAKE_HOLD_MS, records: [sibling('a'), sibling('b')] }), false);
});
test('router compaction is due at 100k for root sessions once per observed message', async () => {
  assert.equal(ROUTER_COMPACTION_TOKENS, 100000); assert.equal(routerCompactionTokens({}), 100000);
  assert.equal(routerCompactionTokens({ HARNESS_ROUTER_COMPACTION_TOKENS: '80000' }), 80000);
  assert.equal(routerCompactionDue({ id: 'r', contextTokens: 99999 }), false);
  assert.equal(routerCompactionDue({ id: 'r', contextTokens: 100000 }), true);
  assert.equal(routerCompactionDue({ id: 'c', parentID: 'r', contextTokens: 200000 }), false);
  const sessions = [{ id: 'r', contextTokens: 120000, contextMessageID: 'msg_1' }], calls = [];
  const compactor = createRouterCompactor({ compact: async input => calls.push(input), loadSessions: async () => sessions, newID: () => 'msg_c' });
  assert.equal(await compactor('r'), true); assert.equal(await compactor('r'), false);
  sessions[0].contextMessageID = 'msg_2'; assert.equal(await compactor('r'), true);
  assert.deepEqual(calls.map(c => c.sessionID), ['r', 'r']);
});
test('result delivery holds a waking fallback delivery while a sibling runs', async () => {
  const state = { records: [
    { key: 'a', parentID: 'root', childID: 'ca', admissionGeneration: 1, state: 'running', resultDelivery: { generation: 1, status: 'pending', mode: 'background', parentID: 'root', since: 0, toolReturned: true, returnedAt: 0 } },
    { key: 'b', parentID: 'root', childID: 'cb', admissionGeneration: 1, state: 'running', resultDelivery: { generation: 1, status: 'pending', mode: 'background', parentID: 'root', since: 0 } }] };
  const registry = async (_w, fn) => fn(state, async () => {});
  let at = 60_000; const sent = [];
  const delivery = createResultDelivery({ registry, workspace: '/p', ctx: { session: { synthetic: async i => sent.push(i) } }, now: () => at,
    loadEvidence: async () => ({ terminal: { outcome: 'succeeded', completedAt: 1 }, notices: [] }), loadFinalText: async () => ({ text: 'done' }), schedule: () => 0, cancel: () => {} });
  assert.equal(await delivery.check('a', 1), 'pending'); assert.equal(sent.length, 0);
  at = 1 + ROUTER_WAKE_HOLD_MS; assert.equal(await delivery.check('a', 1), 'delivered'); assert.equal(sent.length, 1);
});
