import test from 'node:test';
import assert from 'node:assert/strict';
import { acknowledgeTaskReview, backgroundDispatch, beginCheckpoint, CHECKPOINT_MS, checkpointStatus, HIGH_CONTEXT_TOKENS, normalizeCheckpoint, normalizeReviewAcknowledgement, prepareCheckpoint, TASK_REVIEW_CONTINUATIONS, TASK_REVIEW_STEPS } from '../plugins/v2/work-checkpoint.mjs';

test('cooperative slice survives serialization and becomes due on the existing boundary', () => {
  let owner = {};
  beginCheckpoint(owner, { objective: 'Capture one failure', expectedEvidence: 'Retained exception' }, 100);
  for (let n = 0; n < 29; n++) assert.equal(prepareCheckpoint(owner, 100).due, false);
  owner = JSON.parse(JSON.stringify(owner));
  assert.equal(prepareCheckpoint(owner, 100).due, true);
  assert.equal(checkpointStatus(owner, 100).preparedSteps, 30);
  beginCheckpoint(owner, undefined, 200);
  assert.equal(checkpointStatus(owner, 200).due, false);
  assert.equal(checkpointStatus(owner, 200 + CHECKPOINT_MS).due, true);
  assert.equal(checkpointStatus(owner, 0).elapsedMs, 0);
});

test('cumulative work survives continuation slices and review becomes due independently of the 30-step reminder', () => {
  const owner = {};
  beginCheckpoint(owner, undefined, 0);
  for (let n = 0; n < TASK_REVIEW_STEPS; n++) prepareCheckpoint(owner, 0);
  let status = checkpointStatus(owner, 0);
  assert.equal(status.preparedSteps, TASK_REVIEW_STEPS);
  assert.equal(status.due, true);
  assert.equal(status.cumulative.preparedSteps, TASK_REVIEW_STEPS);
  assert.equal(status.taskReview.due, true);
  beginCheckpoint(owner, undefined, 1);
  status = checkpointStatus(owner, 1);
  assert.equal(status.preparedSteps, 0);
  assert.equal(status.cumulative.preparedSteps, TASK_REVIEW_STEPS);
  assert.equal(status.cumulative.continuations, 1);
  assert.equal(status.taskReview.due, true);
  for (let n = 1; n < TASK_REVIEW_CONTINUATIONS; n++) beginCheckpoint(owner, undefined, n + 1);
  assert.equal(checkpointStatus(owner, 10).cumulative.continuations, TASK_REVIEW_CONTINUATIONS);
});

test('legacy slices retain known progress and explicit acknowledgement advances only the review baseline', () => {
  const owner = { workCheckpoint: { startedAt: 10, preparedSteps: 9 } };
  let status = checkpointStatus(owner, 10, { knownContext: { usedTokens: 900, maxTokens: 1000 } });
  assert.deepEqual(status.cumulative, { preparedSteps: 9, continuations: 0 });
  assert.equal(status.highContext.ratio, 0.9);
  for (let n = 0; n < TASK_REVIEW_STEPS - 9; n++) prepareCheckpoint(owner, 10);
  status = acknowledgeTaskReview(owner, { hypothesis: 'The retained exception comes from the parser branch', evidenceReference: 'tests/parser-repro.txt' }, 20);
  assert.equal(status.cumulative.preparedSteps, TASK_REVIEW_STEPS);
  assert.equal(status.taskReview.due, false);
  assert.deepEqual(status.taskReview.baseline, { preparedSteps: TASK_REVIEW_STEPS, continuations: 0 });
  assert.equal(status.taskReview.lastAcknowledgement.evidenceReference, 'tests/parser-repro.txt');
  assert.throws(() => acknowledgeTaskReview(owner, { hypothesis: 'x', evidenceReference: '' }), /invalid task review acknowledgement/);
  assert.throws(() => normalizeReviewAcknowledgement({ hypothesis: 'x', evidenceReference: 'ref', extra: true }), /invalid task review acknowledgement/);
  const tokenOnly = checkpointStatus(owner, 20, { knownContext: { tokens: HIGH_CONTEXT_TOKENS } }).highContext;
  assert.deepEqual(tokenOnly, { used: HIGH_CONTEXT_TOKENS, advisory: tokenOnly.advisory });
  assert.equal('ratio' in tokenOnly, false);
});

test('legacy assignments have no injected slice and status reads do not advance it', () => {
  assert.equal(prepareCheckpoint({}), undefined);
  const owner = {}; beginCheckpoint(owner, undefined, 1);
  for (let n = 0; n < 50; n++) checkpointStatus(owner, 100);
  assert.equal(owner.workCheckpoint.preparedSteps, 0);
});

test('checkpoint targets are bounded and sustained dispatch uses native background by default', () => {
  assert.equal(normalizeCheckpoint(undefined), undefined);
  for (const value of [{}, { objective: 'x', expectedEvidence: '' }, { objective: 'x', expectedEvidence: 'x', extra: 1 }]) {
    assert.throws(() => normalizeCheckpoint(value), /invalid checkpoint/);
  }
  for (const operation of ['coordinate', 'implement', 'deploy', 'publish']) assert.equal(backgroundDispatch({ operation }), true);
  assert.equal(backgroundDispatch({ operation: 'inspect' }), false);
  assert.equal(backgroundDispatch({ operation: 'implement', background: false }), false);
  assert.equal(backgroundDispatch({ operation: 'inspect', background: true }), true);
});

test('progress checkpoint does not require timer-only handoff or redispatch', async () => {
  const {checkpointReminder, checkpointHandoff} = await import('../plugins/v2/work-checkpoint.mjs');
  assert.match(checkpointReminder, /Continue the assigned implementation and targeted verification/);
  assert.match(checkpointReminder, /timer alone is not a reason to yield, compact, redispatch/);
  assert.match(checkpointHandoff({objective:'fix',expectedEvidence:'test'}), /do not return solely/);
  assert.match(checkpointHandoff(), /unless blocked or a changed approach is needed/);
});


test('context maintenance is generation-bound advice at a safe same-owner checkpoint', async () => {
  const {contextMaintenance, observedContext} = await import('../plugins/v2/work-checkpoint.mjs');
  const record={parentID:'parent',childID:'child',state:'completed',admissionGeneration:3,completionBinding:{background:true,generation:3},completionReceipt:{generation:3}};
  const native={id:'child',active:false,lastAssistantID:'msg_new',contextTokens:450000,contextObservedAt:1234,contextMessageID:'msg_usage'};
  const options={callerID:'parent',compactionAvailable:true};
  const ready=contextMaintenance(record,native,options);
  assert.equal(ready.eligibleForCompaction,true);assert.equal(ready.when,'before_next_substantial_continuation');assert.equal(ready.tokens,450000);assert.equal(ready.messageID,'msg_usage');
  const cases=[
    [{...record,state:'running'},native,options,'collect_current_result_first'],
    [record,{...native,active:true},options,'wait_for_current_work'],
    [record,native,{...options,activeDescendants:['grandchild']},'wait_for_current_work'],
    [record,native,{...options,callerID:'other'},'recorded_parent_required'],
    [{...record,denial:{category:'native_permission'}},native,options,'resolve_recorded_denial'],
    [record,native,{...options,needsRebind:true},'current_intent_rebind_required'],
    [{...record,completionReceipt:{generation:2}},native,options,'current_generation_receipt_required'],
    [record,native,{...options,compactionAvailable:false},'native_compaction_unavailable'],
    [record,{...native,active:undefined},options,'native_state_unknown'],
  ];
  for(const [r,n,o,reason] of cases){const result=contextMaintenance(r,n,o);assert.equal(result.eligibleForCompaction,false);assert.equal(result.blockedReason,reason);}
  assert.deepEqual(observedContext({}),{status:'unknown'});
  assert.equal(observedContext({contextTokens:0}).tokens,0);
  assert.equal(observedContext({contextTokens:Infinity}).status,'unknown');
  assert.equal(contextMaintenance(record,{...native,contextTokens:10},options).recommended,undefined);
});
