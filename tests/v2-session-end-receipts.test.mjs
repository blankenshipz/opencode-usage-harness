import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harnessTerminalReceipt, sessionEndOutcome } from '../plugins/v2/session-end-receipts.mjs';
import { createResultDelivery } from '../plugins/v2/result-delivery.mjs';

const terminal = { outcome: 'succeeded', promptID: 'p', assistantID: 'a', idleID: 'i', completedAt: 5 };
test('receipt and outcome are harness-authored and never claim checks passed', () => {
  const record = { childID: 'c', parentID: 'r', taskId: 't', workKey: 'w', agent: 'verifier', admissionGeneration: 3, parked: { generation: 3, requestID: 'per_1' } };
  const receipt = harnessTerminalReceipt({ record, terminal, now: 10 });
  assert.deepEqual(receipt, { by: 'harness', generation: 3, sessionID: 'c', outcome: 'succeeded', promptID: 'p', assistantID: 'a', idleID: 'i', completedAt: 5, writtenAt: 10 });
  const line = sessionEndOutcome({ record, receipt });
  assert.equal(line.source, 'harness'); assert.equal(line.status, 'ended'); assert.equal(line.checksVerified, false); assert.equal(line.parked.requestID, 'per_1');
  assert.equal(harnessTerminalReceipt({ record, terminal: { outcome: 'running' }, now: 1 }), undefined);
  assert.equal(sessionEndOutcome({ record, receipt: { ...receipt, outcome: 'interrupted' } }).status, 'interrupted');
});
test('result delivery writes the receipt once per generation at session end', async () => {
  const state = { records: [{ key: 'k', parentID: 'root', childID: 'c', taskId: 't', admissionGeneration: 1, state: 'completed',
    resultDelivery: { generation: 1, status: 'pending', mode: 'foreground', parentID: 'root', since: 0, toolReturned: true, returnedAt: 0 } }] };
  const registry = async (_w, fn) => fn(state, async () => {}); const lines = [];
  const delivery = createResultDelivery({ registry, workspace: '/p', ctx: {}, now: () => 100, appendOutcome: async l => lines.push(l),
    loadEvidence: async () => ({ terminal, notices: [], tool: { status: 'completed' } }), schedule: () => 0, cancel: () => {} });
  assert.equal(await delivery.check('k', 1), 'confirmed');
  assert.equal(state.records[0].harnessTerminalReceipt.assistantID, 'a'); assert.equal(lines.length, 1); assert.equal(lines[0].taskId, 't');
  assert.equal(await delivery.check('k', 1), 'confirmed'); assert.equal(lines.length, 1);
});
