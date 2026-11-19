import test from 'node:test';
// Hermetic default: a persisted operator choice must not change these fixtures.
process.env.HARNESS_COMPACTION_TOKENS = '120000';
import assert from 'node:assert/strict';
import { acknowledgeTaskReview, backgroundDispatch, beginCheckpoint, CHECKPOINT_MS, checkpointStatus, contextMaintenance, observedContext, HIGH_CONTEXT_TOKENS, normalizeCheckpoint, normalizeReviewAcknowledgement, prepareCheckpoint, TASK_REVIEW_CONTINUATIONS, TASK_REVIEW_STEPS } from '../plugins/v2/work-checkpoint.mjs';

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
  assert.deepEqual(tokenOnly, { used: HIGH_CONTEXT_TOKENS, trigger: HIGH_CONTEXT_TOKENS, triggerBasis: 'absolute_tokens', advisory: tokenOnly.advisory });
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

const roomyModel={providerID:'anthropic',id:'fixture-roomy',variant:'medium'};
const roomyCatalog=[{providerID:'anthropic',id:'fixture-roomy',limit:{context:1000000,output:128000},variants:[{id:'medium'}]}];
const roomyNative={model:roomyModel,contextModel:roomyModel,contextTokens:142000};
test('a roomy known window no longer defers pressure past the absolute token threshold',()=>{
 // 872k usable input: 80% would be 697,600 tokens, far beyond a useful builder context.
 const observation=observedContext({...roomyNative,contextTokens:119999},roomyCatalog);
 assert.equal(observation.pressure,'normal');assert.equal(observation.limit,872000);assert.equal(observation.capacityBasis,'catalog_input_budget');
 assert.equal(observation.threshold,120000);assert.equal(observation.thresholdBasis,'absolute_tokens');
 assert.equal(observedContext(roomyNative,roomyCatalog).pressure,'high');
 assert.equal(observedContext({...roomyNative,contextTokens:284000},roomyCatalog).pressure,'high');
 assert.equal(observedContext({...roomyNative,contextTokens:120000},roomyCatalog).pressure,'high');
});
test('model-aware budget respects smaller input limits, output reserve and variant overrides',()=>{
 const model={providerID:'demo',id:'small',variant:'medium'};const native={model,contextModel:model,contextTokens:45000};
 const catalog=[{...model,limit:{context:64000,input:60000,output:8000},variants:[{id:'medium'}]}];
 assert.equal(observedContext(native,catalog).limit,56000);assert.equal(observedContext(native,catalog).pressure,'high');
 catalog[0].limit.input=40000;assert.equal(observedContext(native,catalog).limit,40000);
 catalog[0].variants[0].limit={input:30000};assert.equal(observedContext(native,catalog).limit,30000);
});
test('model-aware pressure never borrows another model or trusts malformed catalog limits',()=>{
 for(const [native,catalog] of [
  [{...roomyNative,contextModel:undefined},roomyCatalog],
  [{...roomyNative,model:{...roomyModel,id:'other'}},roomyCatalog],
  [roomyNative,undefined],[roomyNative,[]],[roomyNative,[...roomyCatalog,...roomyCatalog]],
  [roomyNative,[{...roomyCatalog[0],providerID:'other'}]],
  [roomyNative,[{...roomyCatalog[0],variants:[]}]],
  ...[{context:0,output:128000},{context:1000000,output:1000000},{context:1000000,output:Infinity},{context:1000000},null].map(limit=>[roomyNative,[{...roomyCatalog[0],limit}]]),
 ]) {
  const result=observedContext(native,catalog);assert.equal(result.capacityBasis,'legacy_token_fallback');assert.equal(result.limit,undefined);assert.equal(result.pressure,'high');assert.ok(result.capacityUnknownReason);
 }
});
test('model-aware advice still needs a safe exact-parent checkpoint and never treats a large window as a usage target',()=>{
 const native={...roomyNative,contextTokens:100000,id:'child',active:false,lastAssistantID:'new'};const record={parentID:'parent',childID:'child',state:'completed'};const options={callerID:'parent',compactionAvailable:true,catalog:roomyCatalog};
 assert.equal(contextMaintenance(record,native,options).recommended,undefined);
 const high={...native,contextTokens:750000};assert.equal(contextMaintenance(record,high,options).eligibleForCompaction,true);
 assert.equal(contextMaintenance(record,{...high,active:true},options).blockedReason,'wait_for_current_work');
 assert.equal(contextMaintenance(record,high,{...options,callerID:'other'}).blockedReason,'recorded_parent_required');
});

test('absolute compaction threshold: min(absolute, 80% of known window), absolute when unknown',async()=>{
 const {contextTrigger,compactionTokenThreshold,DEFAULT_COMPACTION_TOKENS,COMPACTION_TOKENS_ENV}=await import('../plugins/v2/work-checkpoint.mjs');
 assert.equal(DEFAULT_COMPACTION_TOKENS,120000);assert.equal(COMPACTION_TOKENS_ENV,'HARNESS_COMPACTION_TOKENS');
 assert.deepEqual(contextTrigger(872000,120000),{trigger:120000,basis:'absolute_tokens',absolute:120000});
 assert.deepEqual(contextTrigger(100000,120000),{trigger:80000,basis:'window_ratio',absolute:120000});
 assert.deepEqual(contextTrigger(undefined,90000),{trigger:90000,basis:'absolute_tokens',absolute:90000});
 assert.equal(contextTrigger(undefined,0).trigger,120000);
 // Small window: 80% cap still applies below the absolute threshold.
 const model={providerID:'demo',id:'small'};const catalog=[{...model,limit:{context:64000,output:8000}}];
 const small=observedContext({model,contextModel:model,contextTokens:44800},catalog);
 assert.equal(small.limit,56000);assert.equal(small.threshold,44800);assert.equal(small.thresholdBasis,'window_ratio');assert.equal(small.pressure,'high');
 assert.equal(observedContext({model,contextModel:model,contextTokens:44799},catalog).pressure,'normal');
 // Configurable absolute threshold, explicit option wins over the environment default.
 assert.equal(observedContext({...roomyNative,contextTokens:150000},roomyCatalog,{threshold:200000}).pressure,'normal');
 assert.equal(observedContext({...roomyNative,contextTokens:200000},roomyCatalog,{threshold:200000}).pressure,'high');
 // Resolution order: env, then persisted configure choice, then default; invalid values fall through.
 const choices=value=>()=>JSON.stringify({shell_policy:'allowlist',compaction_tokens:value});
 assert.equal(compactionTokenThreshold({env:{HARNESS_COMPACTION_TOKENS:'80000'},readFile:choices(90000)}),80000);
 assert.equal(compactionTokenThreshold({env:{},readFile:choices(90000)}),90000);
 assert.equal(compactionTokenThreshold({env:{HARNESS_COMPACTION_TOKENS:'nope'},readFile:choices(90000)}),90000);
 assert.equal(compactionTokenThreshold({env:{HARNESS_COMPACTION_TOKENS:'5'},readFile:choices('x')}),120000);
 assert.equal(compactionTokenThreshold({env:{},readFile:()=>{throw Object.assign(new Error('missing'),{code:'ENOENT'});}}),120000);
 // Status advice uses the same trigger.
 const record={parentID:'parent',childID:'child',state:'completed'};
 const advice=contextMaintenance(record,{...roomyNative,id:'child',active:false,lastAssistantID:'new',contextTokens:284000},{callerID:'parent',compactionAvailable:true,catalog:roomyCatalog});
 assert.equal(advice.pressure,'high');assert.equal(advice.eligibleForCompaction,true);
});
