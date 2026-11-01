import test from 'node:test';
import assert from 'node:assert/strict';
import {workerObservation} from '../plugins/v2/worker-observation.mjs';
const owner={rootID:'r',parentID:'p',childID:'c',state:'running',admissionGeneration:2};
const current={revision:3};
test('running tool and silence are observations, never a stall or acceptance',()=>{
 const result=workerObservation(owner,{active:true,lastVisibleTextAt:100,activity:{runningTools:[{name:'shell',startedAt:200}],lastModelResponseAt:150}},current,[],1000);
 assert.equal(result.handoff.phase,'tool_running');assert.equal(result.workerActivity.runningTools[0].elapsedMs,800);
 assert.equal(result.workerActivity.visibleSilenceMs,900);assert.equal(result.workerActivity.verification,'unverified');
 assert.equal(result.handoff.elapsedMs,undefined);
});
test('idle masks stale running tools; missing native state remains unknown',()=>{
 assert.deepEqual(workerObservation(owner,{active:false,activity:{runningTools:[{name:'shell'}]}},current,[],1000).workerActivity.runningTools,[]);
 assert.equal(workerObservation(owner,{active:false},current,[],1000).handoff.phase,'awaiting_result_inspection');
 assert.equal(workerObservation(owner,undefined,current,[],1000).handoff.phase,'unknown');
});
test('expires receipt-time dependency context without inferring cross-root readiness',()=>{
 const progressCheckpoint={intentRevision:3,observedDuringGeneration:2,status:'blocked',progressState:'waiting_dependency',dependencySessionIDs:['dep','foreign'],recordedAt:300};
 const r={...owner,progressCheckpoint};const records=[{rootID:'r',childID:'dep'},{rootID:'other',childID:'foreign'}];
 const out=workerObservation(r,{active:false},current,records,1000);
 assert.equal(out.handoff.phase,'awaiting_result_inspection');assert.equal(out.handoff.reportedProgress.generationBinding,'receipt_time_only_not_execution_provenance');assert.deepEqual(out.handoff.dependencies.map(d=>d.observation),['same_root_owner_recorded','unobserved']);
 assert.equal(workerObservation({...r,state:'completed'},{active:false},current,records,1000).handoff.phase,'awaiting_parent_decision');
 assert.equal(workerObservation(r,{active:false},{revision:4},records,1000).handoff.phase,'awaiting_result_inspection');
 assert.equal(workerObservation({...r,admissionGeneration:3},{active:false},current,records,1000).handoff.phase,'awaiting_result_inspection');
});
test('collected completion awaits parent decision with exact generation timing only',()=>{
 const r={...owner,state:'completed',handoffTimings:[{generation:1,childID:'c',collectedAt:10},{generation:2,childID:'c',collectedAt:400}]};
 const result=workerObservation(r,{active:false},current,[],1000);
 assert.equal(result.handoff.phase,'awaiting_parent_decision');assert.equal(result.handoff.elapsedMs,600);
 assert.equal(workerObservation({...r,childID:'different'},{active:false},current,[],1000).handoff.since,undefined);
 for(const state of ['compacting','awaiting_continuation','awaiting_recovery']) assert.equal(workerObservation({...r,state},{active:false},current,[],1000).handoff.phase,state);
});

test('tool projection strips arbitrary payloads and custom names',()=>{
 const result=workerObservation(owner,{active:true,activity:{runningTools:[{name:'SECRET-name',status:'streaming',messageID:'msg_ok',toolID:'SECRET/input',startedAt:50,input:'SECRET',output:'SECRET',command:'SECRET',reasoning:'SECRET'}],lastCompletedTool:{name:'read',status:'completed',completedAt:90,output:'SECRET'}}},current,[],1000);
 assert.equal(JSON.stringify(result).includes('SECRET'),false);assert.equal(result.workerActivity.runningTools[0].name,'other');
});

test('late user-action self-report cannot override native collection state',()=>{
 const r={...owner,progressCheckpoint:{intentRevision:3,observedDuringGeneration:2,status:'blocked',progressState:'needs_user_action',recordedAt:700}};
 assert.equal(workerObservation(r,{active:false},current,[],1000).handoff.phase,'awaiting_result_inspection');
 assert.equal(workerObservation({...r,state:'completed'},{active:false},current,[],1000).handoff.phase,'awaiting_parent_decision');
 assert.equal(workerObservation({...r,denial:{category:'native_permission'}},{active:false},current,[],1000).handoff.phase,'blocked');
});
