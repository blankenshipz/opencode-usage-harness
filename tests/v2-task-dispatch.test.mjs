import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { installTaskDispatch, hasCapability } from '../plugins/v2/task-dispatch.mjs';
import { createV2TaskOutcomes } from '../plugins/v2/task-outcomes.mjs';
import { setIntent } from '../plugins/v2/task-intent.mjs';
import { createRegistry } from '../plugins/v2/dispatch-registry.mjs';
import { createWorkerProgress } from '../plugins/v2/worker-progress.mjs';
import { summarizeTaskDispatchStatus } from '../plugins/v2/task-dispatch-status-summary.mjs';
const agents = JSON.parse(fs.readFileSync(new URL('./fixtures/agents.json', import.meta.url)));
const intent = {outcome:'Working release',target:'Local backend',nonGoals:[],authorizedEffects:['Local changes'],assumptions:[],checks:[{id:'backend',description:'Actual backend check',mode:'local'}],sourceMessageIDs:['msg_user']};
const base = { background:false,intentRevision:1,checkIds:['backend'],taskId:'release',workKey:'backend',operation:'implement',agent:'builder',description:'Fix backend',prompt:'Implement requested backend checks',requiredCapabilities:['edit','shell'],writePaths:['backend'] };
test('status summary keeps routing and recovery actions while excluding prompt history and receipts', () => {
 const summary = summarizeTaskDispatchStatus({owners:[{taskId:'release',workKey:'backend',childID:'child-1',parentID:'root',agent:'builder',operation:'implement',intentRevision:3,checkIds:['backend'],admissionGeneration:4,compactionID:'compact-4',compactionOutcome:{id:'compact-4',status:'failed'},routing:{selected:'openai/model#high',effortDecision:{selected:'openai/model#high',reason:'fixture'}},recordedState:'denied',effectiveState:'denied',nativeExecution:{active:false},collection:{action:'task_dispatch_collect',taskId:'release',workKey:'backend',sessionID:'child-1',generation:4},writePaths:['backend'],externalWrites:['/tmp/owned'],externalGrant:{grantID:'grant-1',expiresAt:99,externalRoot:'/secret'},workCheckpoint:{due:true,highContext:{used:9},taskReview:{due:false},limits:{steps:30}},verificationAttempt:{id:'attempt-1',phase:'ready',expiresAt:88,expired:false,readiness:{receiver:true,observer:true,recorder:true},livenessVerified:false,selfReported:true,receipt:'SECRET receipt',evidence:'SECRET evidence'},denial:{category:'native_permission',action:'recover'},rebind:{action:'rebind_same_child'},continuationOwner:{action:'recover_same_child'},activeDescendants:['grandchild'],attention:{progressState:'needs_user_action',nextAction:'inspect'},prompt:'SECRET prompt',history:['SECRET history'],completionReceipt:{assistantID:'SECRET receipt'}}],userActions:[{action:'resume_same_child',sessionID:'child-1'}],taskWork:{steps:2,continuations:1,due:false,limits:{steps:240,continuations:12},history:['SECRET']}});
 assert.equal(summary.owners[0].taskId,'release'); assert.equal(summary.owners[0].routing.selected,'openai/model#high');
 assert.equal(summary.owners[0].routing.effort,'high'); assert.deepEqual(summary.owners[0].collection.sessionID,'child-1');
 assert.equal(summary.owners[0].compactionID,'compact-4'); assert.equal(summary.owners[0].compactionOutcome.status,'failed');
 assert.equal(summary.owners[0].agent,'builder'); assert.equal(summary.owners[0].intentRevision,3); assert.deepEqual(summary.owners[0].workCheckpoint,{due:true,highContext:{used:9},taskReview:{due:false},limits:{steps:30}});
 assert.equal(summary.owners[0].blocker.nextAction,'inspect'); assert.deepEqual(summary.owners[0].activeDescendants,['grandchild']);
 assert.equal(summary.owners[0].verificationAttempt.phase,'ready'); assert.equal(summary.owners[0].verificationAttempt.expiresAt,88); assert.equal(summary.owners[0].verificationAttempt.receipt,undefined); assert.deepEqual(summary.owners[0].externalGrant,{grantID:'grant-1',expiresAt:99});
 const encoded=JSON.stringify(summary); assert.equal(encoded.includes('SECRET'),false); assert.equal(summary.owners[0].prompt,undefined); assert.equal(summary.owners[0].completionReceipt,undefined);
 assert.equal(summarizeTaskDispatchStatus({owners:[{routing:{selected:'provider/model'}}]}).owners[0].routing.effort,undefined);
 const expired=summarizeTaskDispatchStatus({owners:[{verificationAttempt:{id:'attempt-1',phase:'expired',expired:true,failureKey:'device_timeout',livenessVerified:false,selfReported:true}}]}); assert.equal(expired.owners[0].verificationAttempt.phase,'expired'); assert.equal(expired.owners[0].verificationAttempt.failureKey,'device_timeout');
});
test('summary input is optional and default status remains the full status shape', async t => {
 const h=await harness(t); await h.call({...base,background:true});
 const full=JSON.parse((await h.call({taskId:'release'},'task_dispatch_status')).content);
 const summarized=JSON.parse((await h.call({taskId:'release',summary:true},'task_dispatch_status')).content);
 assert.equal(typeof full.owners[0].routing.source,'string');
 assert.equal(summarized.owners[0].description,undefined); assert.equal(summarized.owners[0].prompt,undefined);
 assert.equal(summarized.owners[0].taskId,'release'); assert.equal(summarized.owners[0].writePaths.includes('backend'),true);
});
test('status neither reconciles nor delivers or exposes another root recovery',async t=>{
 const h=await harness(t);
 const {quotaRecoveryReceipt,enqueueQuotaRecovery}=await import('../plugins/v2/quota-recovery.mjs');
 h.sessions.push({id:'other-root',agent:'router',directory:'/project',active:false},
  {id:'other-child',parentID:'other-root',agent:'builder',directory:'/project',active:false,lastCompaction:{id:'msg_other_compact',status:'completed'}});
 const error=Object.assign(new Error('fixture'),{code:'SUBSCRIPTION_QUOTA_CHECK_FAILED',quota:{category:'telemetry_failure'},detail:{reason:'timeout'}});
 await h.registry('/project',async(state,save)=>{
  state.records.push({key:'other',rootID:'other-root',parentID:'other-root',childID:'other-child',taskId:'other-task',workKey:'other',state:'compacting',compactionID:'msg_other_compact',admissionGeneration:1});
  enqueueQuotaRecovery(state,quotaRecoveryReceipt({error,parentID:'other-root',childID:'other-child',generation:1}));await save();
 });
 const notices=[];h.ctx.session.synthetic=async input=>notices.push(input);
 const status=JSON.parse((await h.call({},'task_dispatch_status')).content);
 assert.equal(notices.length,0);assert.deepEqual(status.quotaRecoveryPending,[]);
 assert.equal(JSON.stringify(status).includes('other-child'),false);
 await h.registry('/project',async state=>{const other=state.records.find(r=>r.key==='other');assert.equal(other.state,'compacting');assert.equal(other.compactionOutcome,undefined);assert.equal(state.quotaRecoveryOutbox[0].deliveredAt,undefined);});
});
async function harness(t, custom, nativeInput, dispatchOptions={}) {
 const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'dispatch-test-'));t.after(()=>fsp.rm(dir,{recursive:true,force:true}));
 const sessions=[{id:'root',agent:'router',directory:'/project',active:true}];const calls=[];const tools=new Map();
 const native={name:'subagent',description:'Native subagent',input:nativeInput??{type:'object',properties:{agent:{type:'string'},description:{type:'string'},prompt:{type:'string'},model:{type:'string'},sessionID:{type:'string'},background:{type:'boolean'}},required:['agent','description','prompt']},execute:async(input,context)=>{
  calls.push(input); if(custom)return custom(input,context,sessions,calls);
  const id=input.sessionID??`ses_${calls.length}`;let child=sessions.find(s=>s.id===id);
  if(!child){child={id,parentID:context.sessionID,agent:input.agent,directory:'/project',active:true};sessions.push(child);}
  await context.progress({sessionID:id,status:'running'});child.active=!!input.background;
  return {output:{sessionID:id,status:child.active?'running':'completed',output:'OK'},content:'OK',metadata:{sessionID:id,status:child.active?'running':'completed'}};
 }};const rawNative={...native};tools.set('subagent',native);
 const ctx={location:{directory:'/project'},agent:{list:async()=>({data:Object.entries(agents).map(([id,a])=>({id,...a}))})},tool:{transform:async fn=>{assert.notEqual(fn.constructor.name,'AsyncFunction','native editor transformations must be synchronous');return fn({get:n=>tools.get(n),update:(n,fn)=>fn(tools.get(n)),add:tool=>tools.set(tool.name,tool)});}}};
 const registry=createRegistry(dir);await registry('/project',async(state,save)=>{setIntent(state,{rootID:'root',taskId:'release',intent,expectedRevision:0,actorSessionID:'root'});await save();});
 const hooks=new Map();ctx.session={hook:async(name,fn)=>{const previous=hooks.get(name);hooks.set(name,async event=>{if(previous)await previous(event);return fn(event);});}};
 const runtime=await installTaskDispatch(ctx,{registry,globalRegistry:createRegistry(path.join(dir,'global-writers')),loadSessions:async()=>sessions,loadSources:async()=>['msg_user','msg_correction'],loadRoutingPolicy:()=>undefined,...dispatchOptions});
 const call=(input,tool='task_dispatch',sessionID='root')=>tools.get(tool).execute(input,{sessionID,agent:'router',progress:async()=>{}});
 return {call,sessions,calls,tools,ctx,dir,registry,rawNative,hooks,runtime};
}
test('configured roles retain capability ceilings',()=>{
 assert.equal(hasCapability(agents.coordinator,'shell'),false);assert.equal(hasCapability(agents.coordinator,'delegate'),true);
 assert.equal(hasCapability(agents.builder,'shell'),true);assert.equal(hasCapability(agents.builder,'edit'),true);assert.equal(hasCapability(agents.builder,'delegate'),false);assert.equal(hasCapability(agents.scout,'shell'),false);
});
test('worker progress publishes only a bounded live snapshot and disconnects cleanly', async () => {
 let begin, release; const started = new Promise(resolve => { begin = resolve; });
 const stream = { async *[Symbol.asyncIterator]() { begin(); await new Promise(resolve => { release = resolve; }); yield { type:'session.tool.input.started', data:{sessionID:'ses_leaf',id:'tool_1',name:'shell',input:'SECRET=never-forward'} }; await new Promise(() => {}); } };
 const updates=[]; const tracker=createWorkerProgress({event:{subscribe:()=>stream}},{loadSessions:async()=>[{id:'ses_child'},{id:'ses_leaf',parentID:'ses_child'}],minInterval:30});
 const handle=tracker.attach(async update=>updates.push(update)); await handle.native({sessionID:'ses_child',status:'running',output:'SECRET=never-forward'});
 await started; release(); await new Promise(resolve=>setTimeout(resolve,10)); assert.equal(updates.length,1); await new Promise(resolve=>setTimeout(resolve,35));
 const latest=updates.at(-1); assert.deepEqual(latest,{sessionID:'ses_child',status:'running',toolCalls:[{tool:'shell',status:'running'}],summary:[{id:'worker:ses_child',tool:'shell',state:{status:'running',title:'Active'}}],workerProgress:{state:'working',tool:'shell',updatedAt:latest.workerProgress.updatedAt}});
 assert.equal(JSON.stringify(updates).includes('SECRET'),false);
 handle.close(); tracker.dispose(); assert.equal(updates.length,2);
});
test('native and wrapper both reject incapable Git history routing before native execution',async t=>{
 const h=await harness(t);for(const tool of ['task_dispatch','subagent']) {
 await assert.rejects(h.call({...base,operation:'inspect',agent:'scout',prompt:'Inspect Git history for the latest vendor',requiredCapabilities:[]},tool),/cannot perform shell/);
 await assert.rejects(h.call({...base,operation:'coordinate',agent:'coordinator',requiredCapabilities:['shell','delegate']},tool),/cannot perform shell/);
 await assert.rejects(h.call({agent:'builder'},tool),/taskId/);
 }assert.equal(h.calls.length,0);
});
test('capability mismatch is a structured preflight failure with no quota, native, or registry side effect',async t=>{
 let quotaReads=0;const h=await harness(t,undefined,undefined,{loadQuota:async()=>{quotaReads++;return {};}});
 const list=h.ctx.agent.list;h.ctx.agent.list=async()=>({data:[...(await list()).data,{...(await list()).data.find(agent=>agent.id==='scout'),id:'harness-reviewer'}]});
 let before;await h.registry('/project',async state=>{before=JSON.stringify(state);});
 await assert.rejects(h.call({...base,operation:'inspect',agent:'harness-reviewer',requiredCapabilities:['shell'],writePaths:[],routing:{complexity:'routine',risk:'normal'},model:'anthropic/fixture-opus#high'}),error=>{
  assert.equal(error.code,'TASK_DISPATCH_CAPABILITY_MISMATCH');assert.equal(error.category,'assignment_validation');assert.match(error.message,/TASK_DISPATCH_CAPABILITY_MISMATCH/);assert.match(error.message,/cannot perform shell/);assert.match(error.message,/not native permission denial/);return true;
 });
 assert.equal(quotaReads,0);assert.equal(h.calls.length,0);
 await h.registry('/project',async state=>assert.equal(JSON.stringify(state),before));
 const accepted=await h.call({...base,routing:{complexity:'routine',risk:'normal'},model:'anthropic/fixture-opus#high'});
 assert.equal(accepted.content,'OK');assert.equal(quotaReads,1);assert.equal(h.calls.length,1);assert.equal(h.calls[0].model,'anthropic/fixture-opus#high');
});
test('capability mismatch cannot reclassify or recover an existing native denial',async t=>{
 let attempts=0;const h=await harness(t,async(input,context,sessions)=>{
  attempts++;const id=input.sessionID??'ses_denied';if(!sessions.some(session=>session.id===id))sessions.push({id,parentID:'root',agent:'builder',directory:'/project',active:false});
  await context.progress({sessionID:id,status:'running'});throw new Error('Subagent denied: builder');
 });
 await assert.rejects(h.call(base),/Subagent denied/);assert.equal(attempts,1);
 for(const continuation of [{sessionID:'ses_denied'},{}]) await assert.rejects(h.call({...base,agent:'scout',operation:'inspect',requiredCapabilities:['shell'],writePaths:[],...continuation}),error=>{
  assert.notEqual(error.code,'TASK_DISPATCH_CAPABILITY_MISMATCH');assert.match(error.message,/continuation must be the same role|remains denied/);return true;
 });
 await h.registry('/project',async state=>{assert.equal(state.records[0].childID,'ses_denied');assert.equal(state.records[0].denial.category,'native_permission');});
 await assert.rejects(h.call({...base,sessionID:'ses_denied'}),/remains denied \(native_permission\)/);assert.equal(attempts,1);
});
test('an existing valid child cannot receive new-assignment capability correction',async t=>{
 const h=await harness(t);const first=await h.call({...base,background:true});const id=first.metadata.sessionID;
 await assert.rejects(h.call({...base,agent:'scout',operation:'inspect',requiredCapabilities:['shell'],writePaths:[],sessionID:id}),error=>{
  assert.notEqual(error.code,'TASK_DISPATCH_CAPABILITY_MISMATCH');assert.match(error.message,/continuation must be the same role/);return true;
 });
 assert.equal(h.calls.length,1);
});
test('local task-fit floor survives failed advisory telemetry before native dispatch',async t=>{
 const policy={version:1,enabled:true,roles:{builder:[{ref:'anthropic/fixture-opus#high',taskFit:{implementation:{band:'preferred',evidence_status:'supported',evidence_ref:'fixture-receipt'}}}]}};
 let reads=0;const h=await harness(t,undefined,undefined,{loadRoutingPolicy:()=>policy,loadQuota:async()=>{reads++;throw new Error('fixture telemetry unavailable');}});
 await assert.rejects(h.call({...base,routing:{complexity:'complex',risk:'high',taskType:'implementation'}}),error=>error.code==='ROUTING_TASK_FIT_UNAVAILABLE');
 assert.equal(reads,1);assert.equal(h.calls.length,0);
 await h.registry('/project',async state=>assert.equal(state.records.length,0));
});
test('invalid task classification or local fit policy never falls through to execution',async t=>{
 let reads=0;const h=await harness(t,undefined,undefined,{loadQuota:async()=>{reads++;return {};}});
 await assert.rejects(h.call({...base,routing:{complexity:'standard',risk:'normal',taskType:'invented'}}),/invalid routing assessment/);
 assert.equal(reads,0);assert.equal(h.calls.length,0);
 const broken=await harness(t,undefined,undefined,{loadRoutingPolicy:()=>{throw Object.assign(new Error('ROUTING_POLICY_INVALID'),{code:'ROUTING_POLICY_INVALID'});}});
 await assert.rejects(broken.call(base),error=>error.code==='ROUTING_POLICY_INVALID');assert.equal(broken.calls.length,0);
});
test('fresh built-in callers retain the stock subagent arguments and original executor',async t=>{
 const h=await harness(t);const stock={agent:'builder',description:'Inspect files',prompt:'Inspect the current files',background:false};
 const result=await h.tools.get('subagent').execute(stock,{sessionID:'root',agent:'build',progress:async()=>{}});
 assert.deepEqual(h.calls,[stock]);assert.equal(result.content,'OK');assert.equal(h.tools.get('subagent').input.type,'object'); const event={agent:'build',sessionID:'root',tools:{subagent:{...h.tools.get('subagent')}},system:[]}; await h.hooks.get('context')(event); assert.deepEqual(event.tools.subagent.input,h.rawNative.input); event.agent='router'; await h.hooks.get('context')(event); assert.ok(event.tools.subagent.input.required.includes('taskId'));
});
test('native callers cannot bypass managed ownership or adopt a managed child',async t=>{
 const h=await harness(t);const managed=await h.call({...base,background:true});const stock={agent:'builder',description:'Native work',prompt:'Do native work'};
 await assert.rejects(h.tools.get('subagent').execute(stock,{sessionID:'root',agent:'build',progress:async()=>{}}),/managed task/);
 h.sessions.find(session=>session.id===managed.metadata.sessionID).active=false;
 await h.registry('/project',async(state,save)=>{state.records[0].state='completed';await save();});
 await assert.rejects(h.tools.get('subagent').execute({...stock,sessionID:managed.metadata.sessionID},{sessionID:'root',agent:'build',progress:async()=>{}}),/cannot adopt managed child/);
 assert.equal(h.calls.length,1);
});
test('fresh native callers wait for a foreign active registered writer',async t=>{
 const h=await harness(t);h.sessions.push({id:'foreign-root',agent:'router',directory:'/project',active:false},{id:'foreign-writer',parentID:'foreign-root',agent:'builder',directory:'/project',active:true});
 await h.registry('/project',async(state,save)=>{state.records.push({key:'foreign',rootID:'foreign-root',parentID:'foreign-root',childID:'foreign-writer',taskId:'other',workKey:'writer',writePaths:['src'],state:'running'});await save();});
 await assert.rejects(h.tools.get('subagent').execute({agent:'builder',description:'Native work',prompt:'Do native work'},{sessionID:'root',agent:'build',progress:async()=>{}}),/registered writer/);
 assert.equal(h.calls.length,0);
});
test('native permission errors propagate without retry',async t=>{
 const h=await harness(t,async()=>{throw new Error('Subagent denied: builder SECRET-native-error');});await assert.rejects(h.call(base),/Subagent denied/);assert.equal(h.calls.length,1);
 const status=JSON.parse((await h.call({taskId:'release'},'task_dispatch_status')).content);assert.equal(status.owners[0].denial.category,'native_permission');assert.match(status.owners[0].denial.action,/Do not retry unchanged/);
 await h.registry('/project',async state=>assert.equal(JSON.stringify(state).includes('SECRET-native-error'),false));
});
test('same denied work suppresses prompt and model changes until declared recovery, then native decides again',async t=>{
 let attempts=0;const h=await harness(t,async()=>{
  attempts++;if(attempts===1)throw new Error('Subagent denied: builder');
  if(attempts===2)return {output:{error:{code:'misalignment_policy_violation',message:'Provider refusal'}}};
  return {content:'accepted',metadata:{sessionID:'ses_recovered',status:'completed'},output:{sessionID:'ses_recovered',status:'completed'}};
 });
 await assert.rejects(h.call(base),/Subagent denied/);
 await assert.rejects(h.call({...base,prompt:'totally different wording',model:'provider/other'}),/remains denied \(native_permission\)/);assert.equal(attempts,1);
 const recovery={kind:'authorization_changed',scope:'subagent:builder',inputs:['agent:builder'],authorization:'A current native permission may now admit this request',explanation:'The owner updated the applicable admission rule',reference:'policy-change-42'};
 const refused=await h.call({...base,recovery});assert.match(refused.content,/provider_refusal recorded/);assert.equal(refused.metadata.denial.category,'provider_refusal');assert.equal(attempts,2);const receipt=JSON.parse((await h.call({taskId:'release'},'task_dispatch_status')).content);assert.equal(receipt.owners[0].denial.category,'provider_refusal');
 await assert.rejects(h.call({...base,recovery,prompt:'again'}),/remains denied \(provider_refusal\)/);assert.equal(attempts,2);
 await assert.rejects(h.call({...base,recovery:{...recovery,explanation:'Same referenced evidence, paraphrased explanation'}}),/remains denied \(provider_refusal\)/);assert.equal(attempts,2);
 const providerRecovery={...recovery,kind:'authorization_changed',authorization:'The provider authorization was refreshed',reference:'provider-change-43'};
 const accepted=await h.call({...base,recovery:providerRecovery});assert.equal(accepted.content,'accepted');assert.equal(attempts,3);
});
test('denial receipts survive reload and unrelated work remains eligible',async t=>{
 const h=await harness(t,async(input)=>{if(input.description==='Fix backend')throw new Error('Subagent denied: builder');return {content:'other',metadata:{sessionID:'ses_other',status:'completed'},output:{sessionID:'ses_other',status:'completed'}};});
 await assert.rejects(h.call(base),/Subagent denied/);
 const recreated=new Map([['subagent',{...h.rawNative}]]);
 await installTaskDispatch({...h.ctx,tool:{transform:async fn=>fn({get:n=>recreated.get(n),update:(n,fn)=>fn(recreated.get(n)),add:t=>recreated.set(t.name,t)})}},{registry:createRegistry(h.dir),globalRegistry:createRegistry(path.join(h.dir,'global-writers')),loadRoutingPolicy:()=>undefined,loadSessions:async()=>h.sessions,loadSources:async()=>['msg_user','msg_correction']});
 await assert.rejects(recreated.get('task_dispatch').execute({...base,prompt:'changed after reload'},{sessionID:'root',agent:'router',progress:async()=>{}}),/remains denied/);
 const other=await h.call({...base,workKey:'unrelated',description:'Independent task',writePaths:['mobile']});assert.equal(other.content,'other');
});
test('only the anchored native failed-run policy code is a provider refusal',async t=>{
 let calls=0;const h=await harness(t,async()=>{
  calls++;if(calls===1) throw new Error('Subagent failed (sessionID: ses_policy): {"code":"misalignment_policy_violation"}');
  return {content:'child quoted misalignment_policy_violation but is ordinary output',metadata:{sessionID:'ses_quote',status:'completed'},output:{sessionID:'ses_quote',status:'completed',output:'misalignment_policy_violation'}};
 });
 await assert.rejects(h.call(base),/misalignment_policy_violation/);
 const recovery={kind:'scope_changed',scope:'narrower read-only scope',inputs:['path:src'],authorization:'Existing authorization remains applicable',explanation:'The requested work is now narrower',reference:'scope-change-1'};
 await h.call({...base,recovery});assert.equal(calls,2);
 const status=JSON.parse((await h.call({taskId:'release'},'task_dispatch_status')).content);assert.equal(status.owners[0].denial,undefined);
});
test('same work resumes child after transient failure and preserves selected role/model',async t=>{
 const h=await harness(t,async(input,context,sessions,calls)=>{
 const id=input.sessionID??'ses_paused';if(!sessions.some(s=>s.id===id))sessions.push({id,parentID:'root',agent:'builder',directory:'/project',active:false});
 await context.progress({sessionID:id,status:'running'});if(calls.length===1)throw new Error('quota telemetry unavailable');
 return {content:'recovered',metadata:{sessionID:id,status:'completed'},output:{sessionID:id,status:'completed',output:'recovered'}};
 });
 await assert.rejects(h.call(base),/quota telemetry unavailable/);
 await h.registry('/project',async state=>{assert.equal(state.records[0].intentRevision,1);assert.equal(state.records[0].deliveredIntentRevision,undefined);});
 const result=await h.call({...base,model:'openai/gpt-6-sol#medium'});assert.equal(result.content,'recovered');assert.equal(result.output,undefined);assert.equal(h.calls[1].sessionID,'ses_paused');assert.equal(h.calls[1].model,'openai/gpt-6-sol#medium');
 assert.match(h.calls[0].prompt,/Shared user intent/);assert.match(h.calls[1].prompt,/Shared user intent/);assert.equal(h.calls[1].prompt.includes('compact continuation'),false);
 const status=JSON.parse((await h.call({taskId:'release'},'task_dispatch_status')).content);assert.equal(status.owners.length,1);assert.equal(status.owners[0].state,'completed');
});
test('same child uses compact intent reference only after accepted matching delivery, and refresh resends context',async t=>{
 const h=await harness(t);const first=await h.call({...base,background:true});const id=first.metadata.sessionID;
 await h.call({...base,background:true,sessionID:id});
 assert.match(h.calls[1].prompt,/compact continuation/);assert.match(h.calls[1].prompt,/"taskId":"release"/);assert.match(h.calls[1].prompt,/Next action/);assert.equal(h.calls[1].prompt.includes('Working release'),false);
 await h.call({...base,background:true,sessionID:id,refreshIntent:true});
 assert.match(h.calls[2].prompt,/Shared user intent/);assert.match(h.calls[2].prompt,/Working release/);assert.equal(h.calls[2].prompt.includes('compact continuation'),false);
});
test('child can record an assigned checkpoint before its native call returns',async t=>{
 let h;h=await harness(t,async(input,context,sessions)=>{
  const id=input.sessionID??'ses_checkpoint';if(!sessions.some(s=>s.id===id))sessions.push({id,parentID:'root',agent:'builder',directory:'/project',active:true});
  await context.progress({sessionID:id,status:'running'});
  await h.runtime.outcome({taskId:'release',intentRevision:1,scope:'checkpoint',status:'completed',results:[{id:'backend',status:'passed',mode:'local',evidence:'Checkpoint completed before return'}]},{sessionID:id},async()=> 'recorded');
  return {content:'done',metadata:{sessionID:id,status:'completed'},output:{sessionID:id,status:'completed'}};
 });
 await h.call(base);const current=JSON.parse((await h.call({action:'get',taskId:'release'},'task_intent')).content);
 assert.equal(current.evidence.checks.backend.sessionID,'ses_checkpoint');
});
test('background duplicate is retained, explicit sessionID steers same child',async t=>{
 const h=await harness(t);const first=await h.call({...base,background:true});const id=first.metadata.sessionID;
 const second=await h.call({...base,background:true});assert.match(second.content,/still running/);assert.equal(h.calls.length,1);
 await h.call({...base,background:true,sessionID:id});assert.equal(h.calls.length,2);assert.equal(h.calls[1].sessionID,id);
});
test('concurrent coordinators reserve one owner even with different work keys',async t=>{
 const h=await harness(t);const input={...base,agent:'coordinator',operation:'coordinate',requiredCapabilities:['delegate'],background:true};
 const results=await Promise.allSettled([h.call({...input,workKey:'first'}),h.call({...input,workKey:'replacement'})]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(h.calls.length,1);
});
test('prefixed coordinator shares duplicate ownership guard and old child IDs stay exact',async t=>{
 const h=await harness(t);const original=h.ctx.agent.list;
 h.ctx.agent.list=async()=>({data:(await original()).data.flatMap(a=>a.id==='coordinator'||a.id==='builder'?[a,{...a,id:`harness-${a.id}`}]:[a])});
 const input={...base,agent:'harness-coordinator',operation:'coordinate',requiredCapabilities:['delegate'],background:true,writePaths:[]};
 await h.call(input);
 await assert.rejects(h.call({...input,agent:'coordinator',workKey:'replacement'}),/coordinator.*already|ownership already/);
 h.sessions.push({id:'old-child',parentID:'root',agent:'builder',directory:'/project',active:false});
 await assert.rejects(h.call({...base,agent:'harness-builder',sessionID:'old-child'}),/same role and a direct child/);
});
test('writers have disjoint ownership; deployment waits for existing writers',async t=>{
 const h=await harness(t);await h.call({...base,background:true});
 await assert.rejects(h.call({...base,workKey:'again',writePaths:['backend/api']}),error=>/overlapping/.test(error.message)&&error.message.includes('owned by ses_1')&&error.message.includes('requested paths: /project/backend/api')&&error.message.includes('conflicting paths: /project/backend'));
 await h.call({...base,workKey:'mobile',writePaths:['mobile'],background:true});
 await assert.rejects(h.call({...base,workKey:'deploy',operation:'deploy',requiredCapabilities:['shell']}),/overlapping/);
 h.sessions.filter(s=>s.id!=='root').forEach(s=>s.active=false);
 await h.call({...base,workKey:'deploy',operation:'deploy',requiredCapabilities:['shell'],background:true});
 await assert.rejects(h.call({...base,workKey:'another-deploy',operation:'deploy',requiredCapabilities:['shell']}),/overlapping/);
});
test('continuation path retention keeps admitted scope across operations without widening read-only or deploy ownership',async t=>{
 const h=await harness(t);const inspect=(await h.call({...base,background:true})).metadata.sessionID;
 h.sessions.push({id:'active-writer',parentID:'root',agent:'builder',directory:'/project',active:true});
 await h.registry('/project',async(state,save)=>{Object.assign(state.records[0],{operation:'inspect',writePaths:[]});state.records.push({key:'other-writer',rootID:'root',parentID:'root',childID:'active-writer',taskId:'other',workKey:'writer',agent:'builder',writePaths:['backend'],state:'running'});await save();});
 await assert.rejects(h.call({...base,sessionID:inspect,background:true,writePaths:undefined}),/empty read-only scope requires explicit non-empty writePaths/);

 const deploy=await harness(t);const implement=(await deploy.call({...base,background:true})).metadata.sessionID;
 await deploy.call({...base,sessionID:implement,background:true,writePaths:['backend/api']});
 await deploy.registry('/project',async state=>assert.deepEqual(state.records[0].writePaths,['backend/api']));
 deploy.sessions.push({id:'mobile-writer',parentID:'root',agent:'builder',directory:'/project',active:true});
 await deploy.registry('/project',async(state,save)=>{state.records.push({key:'mobile-writer',rootID:'root',parentID:'root',childID:'mobile-writer',taskId:'mobile',workKey:'writer',agent:'builder',writePaths:['mobile'],state:'running'});await save();});
 await deploy.call({...base,sessionID:implement,operation:'verify',requiredCapabilities:['shell'],background:true,writePaths:undefined});
 await deploy.registry('/project',async state=>assert.deepEqual(state.records[0].writePaths,['backend/api']));
 await assert.rejects(deploy.call({...base,sessionID:implement,operation:'deploy',requiredCapabilities:['shell'],background:true,writePaths:undefined}),/overlapping/);
});
test('same-child continuations retain narrow paths for explicit and implicit operation changes',async t=>{
 const h=await harness(t);const child=(await h.call({...base,background:true})).metadata.sessionID;
 h.sessions.push({id:'mobile-writer',parentID:'root',agent:'builder',directory:'/project',active:true});
 await h.registry('/project',async(state,save)=>{state.records.push({key:'mobile-writer',rootID:'root',parentID:'root',childID:'mobile-writer',taskId:'mobile',workKey:'writer',agent:'builder',writePaths:['mobile'],state:'running'});await save();});
 await h.call({...base,sessionID:child,operation:'inspect',requiredCapabilities:['shell'],background:true,writePaths:undefined});
 await h.registry('/project',async state=>assert.deepEqual(state.records[0].writePaths,['backend']));
 h.sessions.find(session=>session.id===child).active=false;
 const retained=await h.call({...base,operation:'verify',requiredCapabilities:['shell'],background:true,writePaths:undefined});
 assert.equal(retained.content,'OK');assert.equal(h.calls.at(-1).sessionID,child);
 await assert.rejects(h.call({...base,sessionID:child,operation:'verify',requiredCapabilities:['shell'],background:true,writePaths:[]}),/requires explicit non-empty writePaths/);
});
test('an edit-capable inspect continuation cannot widen an empty read-only scope by omission',async t=>{
 const h=await harness(t);const child=(await h.call({...base,background:true})).metadata.sessionID;
 await h.registry('/project',async(state,save)=>{Object.assign(state.records[0],{operation:'inspect',writePaths:[]});await save();});
 await assert.rejects(h.call({...base,sessionID:child,operation:'inspect',requiredCapabilities:['shell'],background:true,writePaths:undefined}),/empty read-only scope requires explicit non-empty writePaths/);
 await h.registry('/project',async(state,save)=>{delete state.records[0].writePaths;await save();});
 await assert.rejects(h.call({...base,sessionID:child,operation:'inspect',requiredCapabilities:['shell'],background:true,writePaths:undefined}),/legacy continuation without a recorded write scope requires explicit non-empty writePaths/);
});
test('legacy child continuations without a record must declare non-empty writer paths',async t=>{
 const h=await harness(t);h.sessions.push({id:'legacy-child',parentID:'root',agent:'builder',directory:'/project',active:false});
 for (const writePaths of [undefined,[]]) await assert.rejects(h.call({...base,sessionID:'legacy-child',operation:'inspect',requiredCapabilities:['shell'],background:true,writePaths}),/legacy continuation without a recorded write scope requires explicit non-empty writePaths/);
});
test('legacy active workers block new writers; direct-child adoption preserves ownership',async t=>{
 const h=await harness(t);h.sessions.push({id:'legacy',parentID:'root',agent:'builder',directory:'/project',active:true});
 await assert.rejects(h.call(base),/untracked worker/);await h.call({...base,sessionID:'legacy',background:true});assert.equal(h.calls[0].sessionID,'legacy');
 await assert.rejects(h.call({...base,workKey:'changed',sessionID:'legacy'}),/retain that ownership identity/);
});
test('ownership survives plugin recreation and failed parents with active descendants',async t=>{
 const h=await harness(t);await h.call({...base,background:true});
 const recreated=new Map([['subagent',{...h.rawNative}]]);
 await installTaskDispatch({...h.ctx,tool:{transform:async fn=>fn({get:n=>recreated.get(n),update:(n,fn)=>fn(recreated.get(n)),add:t=>recreated.set(t.name,t)})}},{registry:createRegistry(h.dir),globalRegistry:createRegistry(path.join(h.dir,'global-writers')),loadRoutingPolicy:()=>undefined,loadSessions:async()=>h.sessions});
 const content=JSON.parse((await recreated.get('task_dispatch_status').execute({},{sessionID:'root'})).content);assert.equal(content.owners[0].childID,'ses_1');
 h.sessions[1].active=false;h.sessions.push({id:'grandchild',parentID:'ses_1',agent:'builder',directory:'/project',active:true});
 await assert.rejects(h.call({...base,workKey:'replacement'}),/overlapping/);
});

test('registry serializes independent processes and preserves each update',async t=>{
 const h=await harness(t);const execute=promisify(execFile);const moduleURL=new URL('../plugins/v2/dispatch-registry.mjs',import.meta.url).href;
 const source=`import {createRegistry} from ${JSON.stringify(moduleURL)}; await createRegistry(process.argv[1])('/project',async(s,save)=>{const n=s.counter??0;await new Promise(r=>setTimeout(r,30));s.counter=n+1;await save();});`;
 await Promise.all(Array.from({length:3},()=>execute(process.execPath,['--input-type=module','-e',source,h.dir])));
 await h.registry('/project',async state=>assert.equal(state.counter,3));
});
test('kernel flock keeps a held registry exclusive and releases it when its process dies',async t=>{
 const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'dispatch-flock-'));t.after(()=>fsp.rm(dir,{recursive:true,force:true}));
 const registry=createRegistry(dir);let release,entered=false;let started;
 const ready=new Promise(resolve=>{started=resolve;});
 const first=registry('/project',async()=>{started();await new Promise(resolve=>{release=resolve;});});
 await ready;
 const second=registry('/project',async()=>{entered=true;});
 await new Promise(resolve=>setTimeout(resolve,100));assert.equal(entered,false,'a second file description must not enter while the first callback owns flock');
 release();await first;await second;assert.equal(entered,true);
 const moduleURL=new URL('../plugins/v2/dispatch-registry.mjs',import.meta.url).href;
 const source=`import {createRegistry} from ${JSON.stringify(moduleURL)}; await createRegistry(process.argv[1])('/dead-owner',async()=>{console.log('locked');await new Promise(()=>{});});`;
 const child=spawn(process.execPath,['--input-type=module','-e',source,dir],{stdio:['ignore','pipe','pipe']});
 await new Promise((resolve,reject)=>{child.stdout.once('data',data=>data.toString().includes('locked')?resolve():reject(new Error('child did not acquire registry')));child.once('error',reject);});
 child.kill('SIGKILL');await new Promise(resolve=>child.once('close',resolve));
 let recovered=false;await registry('/dead-owner',async()=>{recovered=true;});assert.equal(recovered,true);
});
test('dead admission owner is recovered without replacing a known child',async t=>{
 const h=await harness(t);await h.call({...base,background:true});
 await h.registry('/project',async(state,save)=>{Object.assign(state.records[0],{inFlight:'abandoned',ownerPid:999999,state:'starting'});await save();});
 const answer=await h.call({...base,background:true});assert.match(answer.content,/still running/);assert.equal(h.calls.length,1);
 await h.registry('/project',async state=>assert.equal(state.records[0].inFlight,null));
});

test('edit-capable inspect workers cannot bypass writer ownership', async t => {
 const h=await harness(t);await h.call({...base,background:true});
 for(const tool of ['task_dispatch','subagent']) await assert.rejects(h.call({...base,workKey:'hidden-writer',operation:'inspect',requiredCapabilities:[],writePaths:undefined,prompt:'Inspect then edit backend/file.js'},tool),/overlapping/);
 assert.equal(h.calls.length,1);
});

test('paused coordinator retains ownership while descendants are active', async t => {
 const h=await harness(t);const input={...base,agent:'coordinator',operation:'coordinate',requiredCapabilities:['delegate'],background:true};
 const first=await h.call(input);const id=first.metadata.sessionID;
 h.sessions.find(s=>s.id===id).active=false;
 h.sessions.push({id:'leaf',parentID:id,agent:'builder',directory:'/project',active:true});
 await assert.rejects(h.call({...input,workKey:'replacement'}),/coordinator.*already/);
 assert.equal(h.calls.length,1);
});

test('grandchild contention identifies resumable coordinator without cross-parent adoption', async t => {
 const h=await harness(t);
 h.sessions.push({id:'coordinator',parentID:'root',agent:'coordinator',directory:'/project',active:true},{id:'legacy-leaf',parentID:'coordinator',agent:'builder',directory:'/project',active:true});
 await assert.rejects(h.call(base), e=>/untracked worker/.test(e.message)&&e.message.includes('"sessionID":"coordinator"')&&e.message.includes('resume_direct_child'));
 await assert.rejects(h.call({...base,sessionID:'legacy-leaf'}),/direct child/);
 const status=JSON.parse((await h.call({},'task_dispatch_status')).content);
 const leaf=status.workspaceActive.find(s=>s.id==='legacy-leaf');assert.equal(leaf.sessionID,'coordinator');assert.equal(leaf.parentID,'coordinator');
 assert.equal(h.calls.length,0);
});
test('workspace status exposes foreign-tree contention without offering adoption', async t => {
 const h=await harness(t);h.sessions.push({id:'foreign-root',agent:'router',directory:'/project',active:false},{id:'foreign-leaf',parentID:'foreign-root',agent:'builder',directory:'/project',active:true});
 const status=JSON.parse((await h.call({},'task_dispatch_status')).content);
 const leaf=status.workspaceActive.find(s=>s.id==='foreign-leaf');assert.equal(leaf.action,'wait_for_other_parent');assert.equal(leaf.sessionID,undefined);
});

test('new handoffs need intent and receive shared context; ordinary work waits',async t=>{
 const h=await harness(t);
 await assert.rejects(h.call({...base,taskId:'unregistered'}),/register the user outcome/);
 await h.call(base);assert.match(h.calls[0].prompt,/Shared user intent/);assert.match(h.calls[0].prompt,/Working release/);assert.equal(h.calls[0].background,false);
 await assert.rejects(h.call({...base,checkIds:['unknown']}),/check/);
});
test('root correction parks old child and explicit same-child continuation rebinds it',async t=>{
 const h=await harness(t);const first=await h.call({...base,background:true});const id=first.metadata.sessionID;
 await assert.rejects(h.call({action:'set',taskId:'release',expectedRevision:1,intent:{...intent,target:'Physical phone',sourceMessageIDs:['msg_correction']}},'task_intent',id),/only the root/);
 await h.call({action:'set',taskId:'release',expectedRevision:1,intent:{...intent,target:'Physical phone',sourceMessageIDs:['msg_correction']}},'task_intent');
 await assert.rejects(h.hooks.get('model.request')({sessionID:id}),/rebind_same_child/);
 const status=JSON.parse((await h.call({taskId:'release'},'task_dispatch_status')).content).owners[0];
 assert.equal(status.needsRebind,true);assert.deepEqual(status.rebind,{action:'rebind_same_child',parentID:'root',childID:id,taskId:'release',workKey:'backend',agent:'builder',operation:'implement',writePaths:['backend'],previousIntentRevision:1,intentRevision:2,availableCheckIds:['backend'],advice:'The recorded parent must explicitly call task_dispatch with this sessionID, taskId/workKey, agent, operation, current intentRevision, and selected current checkIds. Omit writePaths to retain these paths; explicit paths remain subject to ownership checks. This does not authorize execution.'});
 assert.equal(h.calls.length,1,'status reads recovery state without native inference');
 await assert.rejects(h.call({...base,sessionID:id}),/revision/i);
 await assert.rejects(h.call({...base,intentRevision:2}),/explicitly resume/);
 h.sessions.push({id:'other-parent',parentID:'root',agent:'router',directory:'/project',active:true});
 await assert.rejects(h.call({...base,intentRevision:2,sessionID:id},'task_dispatch','other-parent'),/direct child/);
 await assert.rejects(h.call({...base,intentRevision:2,sessionID:id,background:true}),/still active on a superseded revision/);
 await h.registry('/project',async state=>assert.equal(state.records[0].intentRevision,1));
 await assert.rejects(h.hooks.get('model.request')({sessionID:id}),/rebind_same_child/);
 h.sessions.find(session=>session.id===id).active=false;
 await h.call({...base,intentRevision:2,sessionID:id,background:true,writePaths:undefined});
 await h.registry('/project',async state=>{assert.equal(state.records[0].childID,id);assert.deepEqual(state.records[0].writePaths,['backend']);assert.equal(state.records[0].intentRevision,2);});
 await h.hooks.get('model.request')({sessionID:id});assert.equal(h.calls[1].sessionID,id);assert.match(h.calls[1].prompt,/Physical phone/);
 await h.call({...base,intentRevision:2,sessionID:id,background:true,writePaths:undefined});
 await h.registry('/project',async state=>assert.deepEqual(state.records[0].writePaths,['backend']));
 await h.call({...base,intentRevision:2,sessionID:id,background:true,writePaths:['backend/api']});
 await h.registry('/project',async state=>assert.deepEqual(state.records[0].writePaths,['backend/api']));
});
test('failed corrected delivery restores the prior child binding',async t=>{
 const h=await harness(t,async(input,context,sessions,calls)=>{
  const id=input.sessionID??'rebind-failure';let child=sessions.find(session=>session.id===id);
  if(!child){child={id,parentID:context.sessionID,agent:input.agent,directory:'/project',active:false};sessions.push(child);}
  await context.progress({sessionID:id,status:'running'});if(calls.length===2)throw new Error('native delivery failed');
  return {content:'OK',metadata:{sessionID:id,status:'completed'},output:{sessionID:id,status:'completed'}};
 });
 const id=(await h.call(base)).metadata.sessionID;
 await h.call({action:'set',taskId:'release',expectedRevision:1,intent:{...intent,target:'Corrected target',sourceMessageIDs:['msg_correction']}},'task_intent');
 await assert.rejects(h.call({...base,intentRevision:2,sessionID:id}),/native delivery failed/);
 await h.registry('/project',async state=>{assert.equal(state.records[0].intentRevision,1);assert.deepEqual(state.records[0].checkIds,['backend']);});
 await assert.rejects(h.hooks.get('model.request')({sessionID:id}),/rebind_same_child/);
});
test('changed checks resend full intent to the same child',async t=>{
 const h=await harness(t);const id=(await h.call({...base,background:true})).metadata.sessionID;
 await h.call({...base,background:true,sessionID:id,checkIds:['backend']});assert.match(h.calls[1].prompt,/compact continuation/);
 await h.call({action:'set',taskId:'release',expectedRevision:1,intent:{...intent,checks:[...intent.checks,{id:'review',description:'Review the diff',mode:'synthetic'}],sourceMessageIDs:['msg_correction']}},'task_intent');
 h.sessions.find(session=>session.id===id).active=false;
 await h.call({...base,intentRevision:2,checkIds:['review'],background:true,sessionID:id});
 assert.match(h.calls[2].prompt,/Shared user intent/);assert.match(h.calls[2].prompt,/"id":"review"/);assert.equal(h.calls[2].prompt.includes('compact continuation'),false);
});
test('source attribution rejects foreign or outdated user IDs; status exposes shared evidence',async t=>{
 const h=await harness(t);
 for(const ids of [['msg_foreign'],['msg_user']])await assert.rejects(h.call({action:'set',taskId:'release',expectedRevision:1,intent:{...intent,sourceMessageIDs:ids}},'task_intent'),/source|latest/);
 const r=await h.call({action:'get',taskId:'release'},'task_intent');assert.deepEqual(JSON.parse(r.content).sourceMessageIDs,['msg_user','msg_correction']);
});
test('outcome revision, assigned checks, and active-work completion are enforced',async t=>{
 const h=await harness(t);const first=await h.call({...base,background:true});const id=first.metadata.sessionID;
 const args={taskId:'release',intentRevision:1,scope:'checkpoint',status:'completed',results:[{id:'backend',status:'passed',mode:'local',evidence:'Actual endpoint returned 200'}]};
 await h.runtime.outcome(args,{sessionID:id},async contract=>{assert.equal(contract.goal,'Working release');return 'recorded';});
 const current=JSON.parse((await h.call({action:'get',taskId:'release'},'task_intent')).content);assert.equal(current.evidence.checks.backend.sessionID,id);
 await assert.rejects(h.runtime.outcome({...args,intentRevision:0},{sessionID:id},()=>{}),/current intentRevision/);
 await assert.rejects(h.runtime.outcome({...args,scope:'task'},{sessionID:id},()=>{}),/only the root/);
 await assert.rejects(h.runtime.outcome({...args,results:[{...args.results[0],mode:'synthetic'}]},{sessionID:id},()=>{}),/verification mode/);
 await assert.rejects(h.runtime.outcome({...args,scope:'task'},{sessionID:'root'},()=>{}),/active workers/);
});


test('real outcome tool uses shared acceptance instead of an independent child contract',async t=>{
 const h=await harness(t);const tools=new Map([['subagent',{...h.rawNative}]]);const records=[];
 const plugin=createV2TaskOutcomes({dispatchOptions:{registry:h.registry,loadSessions:async()=>h.sessions,loadSources:async()=>['msg_user']},append:async r=>records.push(r)});
 const ctx={...h.ctx,event:{subscribe:()=>({async *[Symbol.asyncIterator](){}})},tool:{transform:async fn=>fn({get:n=>tools.get(n),update:(n,fn)=>fn(tools.get(n)),add:t=>tools.set(t.name,t)})}};
 const cleanup=await plugin.setup(ctx);t.after(cleanup);
 const execute=args=>tools.get('task_outcome').execute(args,{sessionID:'root',agent:'router'});
 await assert.rejects(execute({taskId:'release',intentRevision:1,scope:'task',status:'completed',results:[]}),/every contracted/);
 await execute({taskId:'release',intentRevision:1,scope:'task',status:'completed',results:[{id:'backend',mode:'local',status:'passed',evidence:'Verified local endpoint'}]});
 assert.equal(records.length,1);
 await h.call({action:'set',taskId:'release',expectedRevision:1,intent:{...intent,target:'Physical phone',sourceMessageIDs:['msg_correction']}},'task_intent');
 await assert.rejects(execute({taskId:'release',intentRevision:1,scope:'task',status:'completed',results:[{id:'backend',mode:'local',status:'passed',evidence:'Old result'}]}),/current intentRevision/);
 assert.equal(records.length,1);
});

test('worker reasoning and response phases are visible without forwarding content', async () => {
 const queue=[];let wake,closed=false;
 const stream={async *[Symbol.asyncIterator](){while(!closed){if(!queue.length)await new Promise(r=>{wake=r;});while(queue.length)yield queue.shift();}}};
 const updates=[];const tracker=createWorkerProgress({event:{subscribe:()=>stream}},{minInterval:0});
 const handle=tracker.attach(async value=>updates.push(value));await handle.native({sessionID:'ses_worker'});
 async function emit(type,sessionID='ses_worker') {queue.push({type,data:{sessionID,text:'SECRET',delta:'SECRET',id:'part'}});wake?.();await new Promise(r=>setTimeout(r,5));}
 await emit('session.reasoning.started');assert.equal(updates.at(-1).workerProgress.phase,'reasoning');assert.equal(updates.at(-1).summary[0].state.title,'Reasoning');
 const count=updates.length;await emit('session.reasoning.delta');await emit('session.text.started','ses_other');assert.equal(updates.length,count);
 await emit('session.reasoning.ended');assert.equal(updates.at(-1).workerProgress.phase,undefined);
 await emit('session.text.started');assert.equal(updates.at(-1).toolCalls[0].tool,'responding');
 await emit('session.text.ended');assert.equal(updates.at(-1).workerProgress.phase,undefined);
 assert.equal(JSON.stringify(updates).includes('SECRET'),false);
 handle.close();const before=updates.length;await emit('session.text.started');assert.equal(updates.length,before);
 tracker.dispose();closed=true;wake?.();
});

test('convergence advises without blocking, preserves result, ignores polling and resets on receipts', async t => {
 const h=await harness(t);
 await h.call(base);
 await h.call({...base,sessionID:'ses_1'});
 const third=await h.call({...base,sessionID:'ses_1'});
 assert.equal(third.metadata.convergence.admissionsWithoutReceiptChange,3);
 assert.equal(third.content,'OK');
 assert.match(h.calls.at(-1).prompt,/Convergence advisory/);
 for(let i=0;i<4;i++) await h.call({taskId:'release'},'task_dispatch_status');
 let status=JSON.parse((await h.call({taskId:'release'},'task_dispatch_status')).content);
 assert.equal(status.owners[0].convergence.admissionsWithoutReceiptChange,3);
 h.sessions.find(s=>s.id==='ses_1').active=true;
 await h.call(base);
 assert.equal(h.calls.length,3);
 h.sessions.find(s=>s.id==='ses_1').active=false;
 const receipt={taskId:'release',intentRevision:1,scope:'checkpoint',status:'completed',results:[{id:'backend',status:'passed',mode:'local',evidence:'Verified'}]};
 await h.runtime.outcome(receipt,{sessionID:'ses_1'},async()=> 'recorded');
 assert.equal((await h.call({...base,sessionID:'ses_1'})).metadata.convergence,undefined);
 await h.runtime.outcome({...receipt,results:[{...receipt.results[0],evidence:'Same proof reworded'}]},{sessionID:'ses_1'},async()=> 'recorded');
 await h.call({...base,sessionID:'ses_1'});
 assert.equal((await h.call({...base,sessionID:'ses_1'})).metadata.convergence.admissionsWithoutReceiptChange,3);
});

test('user actions surface by current task binding and clear on continued checkpoint',async t=>{
 const h=await harness(t);await h.call(base);
 const args={taskId:'release',intentRevision:1,scope:'checkpoint',status:'blocked',progressState:'needs_user_action',blocker:{kind:'environment',evidence:'Device needs physical test',nextAction:'Press Play once'}};
 await h.runtime.outcome(args,{sessionID:'ses_1'},async()=> 'recorded');
 const read=async()=>JSON.parse((await h.call({taskId:'release'},'task_dispatch_status')).content);
 assert.equal((await read()).userActions[0].nextAction,'Press Play once');
 await h.runtime.outcome({taskId:'release',intentRevision:1,scope:'checkpoint',status:'in_progress'},{sessionID:'ses_1'},async()=> 'recorded');
 assert.deepEqual((await read()).userActions,[]);
});

test('sustained work defaults to native background and retains ownership on duplicate', async t => {
 const h=await harness(t);const input={...base,background:undefined,checkpoint:{objective:'Capture the current failure',expectedEvidence:'One retained exception'}};
 const result=await h.call(input);assert.equal(h.calls[0].background,true);assert.equal(result.metadata.status,'running');
 assert.match(h.calls[0].prompt,/One retained exception/);
 await h.call(input);assert.equal(h.calls.length,1);
 const status=JSON.parse((await h.call({taskId:'release'},'task_dispatch_status')).content);
 assert.equal(status.owners[0].workCheckpoint.preparedSteps,0);
});

test('context checkpoint is cooperative, durable and excludes unrelated or legacy owners', async t => {
 const h=await harness(t);const id=(await h.call({...base,background:true})).metadata.sessionID;
 const context=()=>({sessionID:id,system:[]});
 for(let n=0;n<29;n++){const e=context();await h.hooks.get('context')(e);assert.equal(e.system.length,0);}
 const e=context();await h.hooks.get('context')(e);assert.match(e.system[0].text,/Progress checkpoint due/);
 assert.equal(h.calls.length,1);assert.equal(h.sessions.find(s=>s.id===id).active,true);
 const unrelated={sessionID:'root',system:[]};await h.hooks.get('context')(unrelated);assert.deepEqual(unrelated.system,[]);
 const status=JSON.parse((await h.call({taskId:'release'},'task_dispatch_status')).content);
 assert.equal(status.owners[0].workCheckpoint.due,true);assert.equal(status.owners[0].workCheckpoint.preparedSteps,30);
 await h.call({...base,background:true,sessionID:id});const resumed=context();await h.hooks.get('context')(resumed);assert.deepEqual(resumed.system,[]);
});

test('accepted outcomes record durable semantic evidence; rejected outcomes do not', async t => {
 const h=await harness(t);await h.call(base);
 const receipt={taskId:'release',intentRevision:1,scope:'checkpoint',status:'in_progress',progressEvidence:{failureKey:'observer-closed',kind:'reproduced',reference:'receipts/replay-1'}};
 await assert.rejects(h.runtime.outcome(receipt,{sessionID:'ses_1'},async()=>{throw new Error('receipt rejected');}),/receipt rejected/);
 let status=JSON.parse((await h.call({taskId:'release'},'task_dispatch_status')).content);
 assert.equal(status.owners[0].convergence,undefined);
 await h.runtime.outcome(receipt,{sessionID:'ses_1'},async()=> 'recorded');
 await h.call({...base,sessionID:'ses_1'});await h.call({...base,sessionID:'ses_1'});
 status=JSON.parse((await h.call({taskId:'release'},'task_dispatch_status')).content);
 assert.equal(status.owners[0].convergence,undefined);
 const third=await h.call({...base,sessionID:'ses_1'});assert.equal(third.metadata.convergence.semanticNoProgressContinuations,2);
});

test('attempt readiness and capture survive registry reload; invalid outcomes cannot alter them',async t=>{
 const h=await harness(t);await h.call(base);const now=Date.now();
 const receipt={taskId:'release',intentRevision:1,scope:'checkpoint',status:'blocked',progressState:'needs_user_action',blocker:{kind:'environment',evidence:'Ready for device action',nextAction:'Press Play once'},attempt:{id:'attempt-1',phase:'ready',expectedSignal:'First receiver event',receipt:'receipts/attempt-1',observedAt:now,expiresAt:now+60000,readiness:{receiver:true,observer:true,recorder:true}}};
 await h.runtime.outcome(receipt,{sessionID:'ses_1'},async()=> 'recorded');
 const status=()=>h.call({taskId:'release'},'task_dispatch_status').then(r=>JSON.parse(r.content));
 assert.equal((await status()).owners[0].verificationAttempt.phase,'ready');
 const capture={...receipt,status:'in_progress',progressState:'working',blocker:undefined,attempt:{id:'attempt-1',phase:'captured',observedAt:now,evidence:'Event retained'}};
 await assert.rejects(h.runtime.outcome(capture,{sessionID:'ses_1'},async()=>{throw new Error('failed append');}),/failed append/);
 assert.equal((await status()).owners[0].verificationAttempt.phase,'ready');
 await h.runtime.outcome(capture,{sessionID:'ses_1'},async()=> 'recorded');
 assert.equal((await status()).owners[0].verificationAttempt.phase,'captured');assert.deepEqual((await status()).userActions,[]);
 await assert.rejects(h.runtime.outcome({...receipt,attempt:{...receipt.attempt,id:'other',readiness:{receiver:true,observer:true,recorder:false}}},{sessionID:'ses_1'},async()=> 'should not record'),/readiness/);
});

test('dispatch supplies configured model on continuation and preserves explicit override',async t=>{
 const h=await harness(t);const list=h.ctx.agent.list;h.ctx.agent.list=async()=>({data:(await list()).data.map(a=>a.id==='builder'?{...a,model:{providerID:'demo',id:'balanced',variant:'medium'}}:a)});
 await h.call({...base,background:false});const id=h.calls[0].sessionID??'ses_1';
 await h.call({...base,sessionID:id,background:false});assert.equal(h.calls.at(-1).model,'demo/balanced#medium');
 await h.call({...base,sessionID:id,background:false,model:'demo/strong#high'});
 await h.call({...base,sessionID:id,background:false});assert.equal(h.calls.at(-1).model,'demo/strong#high');
});
test('an explicit completed idle continuation can reassess only to a catalog-supported medium effort',async t=>{
 const h=await harness(t,undefined,undefined,{loadQuota:async()=>({catalog:[{providerID:'anthropic',id:'sonnet',variants:[{id:'high'},{id:'medium'}]}]})});
 const list=h.ctx.agent.list;h.ctx.agent.list=async()=>({data:(await list()).data.map(a=>a.id==='builder'?{...a,model:'anthropic/sonnet#high'}:a)});
 const first=await h.call({...base,background:false,routing:{complexity:'standard',risk:'normal'}});
 await h.call({...base,background:false,sessionID:first.metadata.sessionID,continuationEffort:'reassess',routing:{complexity:'standard',risk:'normal'}});
 assert.equal(h.calls.at(-1).sessionID,first.metadata.sessionID);assert.equal(h.calls.at(-1).model,'anthropic/sonnet#medium');
 await h.registry('/project',async state=>{
  const routing=state.records[0].routing;
  assert.equal(routing.source,'safe_checkpoint_effort');assert.equal(routing.effortDecision.reason,'same_model_medium_supported');
 });
});
test('effort reassessment retains high when the completed direct child still has an active descendant',async t=>{
 const h=await harness(t,undefined,undefined,{loadQuota:async()=>({catalog:[{providerID:'anthropic',id:'sonnet',variants:[{id:'high'},{id:'medium'}]}]})});
 const list=h.ctx.agent.list;h.ctx.agent.list=async()=>({data:(await list()).data.map(a=>a.id==='builder'?{...a,model:'anthropic/sonnet#high'}:a)});
 const first=await h.call({...base,background:false,routing:{complexity:'standard',risk:'normal'}});
 h.sessions.push({id:'active-descendant',parentID:first.metadata.sessionID,agent:'scout',directory:'/project',active:true});
 await h.call({...base,background:false,sessionID:first.metadata.sessionID,continuationEffort:'reassess',routing:{complexity:'standard',risk:'normal'}});
 assert.equal(h.calls.at(-1).model,'anthropic/sonnet#high');
 await h.registry('/project',async state=>assert.equal(state.records[0].routing.effortDecision.reason,'not_completed_idle_boundary'));
});
test('historical transcript refuses dispatch and model inference with canonical recovery',async t=>{
 const h=await harness(t);h.sessions[0].canonicalSessionID='canonical';
 await assert.rejects(h.call(base),/canonical/);assert.equal(h.calls.length,0);
 await assert.rejects(h.hooks.get('model.request')({sessionID:'root'}),/canonical/);
});
test('cumulative review persists across continuations and accepts evidence without human approval',async t=>{
 const h=await harness(t);await h.call({...base,background:false});
 await h.registry('/project',async(state,save)=>{state.records[0].workAccounting={preparedSteps:240,continuations:12,reviewBaseline:{preparedSteps:0,continuations:0}};await save();});
 await assert.rejects(h.call({...base,background:false}),/cumulative work review due/);
 await h.call({...base,background:false,workReview:{hypothesis:'Repair measured parse failure',evidenceReference:'receipt-parse-1'}});
 await h.registry('/project',async state=>assert.equal(state.records[0].workAccounting.preparedSteps,240));
});
test('native compaction keeps ownership and resets only intent delivery acknowledgement',async t=>{
 const h=await harness(t);await h.call({...base,background:false});const child=h.sessions.find(s=>s.parentID==='root');child.lastAssistantID='last-message';let compacted;
 h.ctx.session.compact=async input=>{compacted=input;};
 const result=await h.call({...base,sessionID:child.id,compact:true,checkpoint:{objective:'Parsing repair verified',expectedEvidence:'receipt-parse-1'}});
 assert.equal(result.metadata.status,'compacting');assert.equal(compacted.sessionID,child.id);assert.match(compacted.id,/^msg_/);assert.equal(h.calls.length,1);
 await h.call({...base,sessionID:child.id});assert.equal(h.calls.length,1);
 child.lastCompaction={id:compacted.id,status:'completed'};child.active=false;await assert.rejects(h.call({...base,sessionID:child.id,compact:true,checkpoint:{objective:'same',expectedEvidence:'same'}}),/no new observed context/);
 await h.call({...base,sessionID:child.id,background:false});assert.match(h.calls.at(-1).prompt,/Shared user intent/);
});
test('compaction reconciliation is generation-scoped and status only records the matching native outcome',async t=>{
 const h=await harness(t);await h.call({...base,background:false});const child=h.sessions.find(s=>s.parentID==='root');let requested=[];
 child.lastAssistantID='assistant-a';h.ctx.session.compact=async input=>requested.push(input);
 await h.call({...base,sessionID:child.id,compact:true,checkpoint:{objective:'A',expectedEvidence:'receipt-a'}});
 const [a]=requested;child.lastCompaction={id:'other-generation',status:'completed'};
 let status=JSON.parse((await h.call({taskId:'release'},'task_dispatch_status')).content);
 assert.equal(status.owners[0].state,'compacting');assert.equal(status.owners[0].compactionOutcome,undefined);assert.equal(h.calls.length,1);
 child.lastCompaction={id:a.id,status:'failed'};
 status=JSON.parse((await h.call({taskId:'release'},'task_dispatch_status')).content);
 assert.equal(status.owners[0].state,'awaiting_recovery');assert.equal(status.owners[0].compactionOutcome.status,'failed');assert.deepEqual(status.owners[0].continuationOwner,{parentID:'root',childID:child.id,action:'recover_same_child'});assert.equal(h.calls.length,1);
 child.lastAssistantID='assistant-b';await h.call({...base,sessionID:child.id,compact:true,checkpoint:{objective:'B',expectedEvidence:'receipt-b'}});
 const b=requested.at(-1);assert.notEqual(a.id,b.id);child.lastCompaction={id:b.id,status:'completed'};
 status=JSON.parse((await h.call({taskId:'release'},'task_dispatch_status')).content);
 assert.equal(status.owners[0].compactionOutcome.id,b.id);assert.equal(status.owners[0].compactionOutcome.status,'completed');assert.deepEqual(status.owners[0].compactionHistory.map(x=>[x.id,x.status]),[[a.id,'failed'],[b.id,'completed']]);assert.equal('compactionFailed' in status.owners[0],false);assert.equal(h.calls.length,1);
});
test('matching compaction outcome survives plugin restart with the same continuation owner',async t=>{
 const h=await harness(t);await h.call({...base,background:false});const child=h.sessions.find(s=>s.parentID==='root');child.lastAssistantID='assistant-a';let compacted;
 h.ctx.session.compact=async input=>{compacted=input;};await h.call({...base,sessionID:child.id,compact:true,checkpoint:{objective:'A',expectedEvidence:'receipt-a'}});
 child.lastCompaction={id:compacted.id,status:'completed'};
 const recreated=new Map([['subagent',{...h.rawNative}]]);
 await installTaskDispatch({...h.ctx,tool:{transform:async fn=>fn({get:n=>recreated.get(n),update:(n,fn)=>fn(recreated.get(n)),add:tool=>recreated.set(tool.name,tool)})}},{registry:createRegistry(h.dir),globalRegistry:createRegistry(path.join(h.dir,'global-writers')),loadRoutingPolicy:()=>undefined,loadSessions:async()=>h.sessions,loadSources:async()=>['msg_user','msg_correction']});
 const status=JSON.parse((await recreated.get('task_dispatch_status').execute({taskId:'release'},{sessionID:'root'})).content);
 assert.equal(status.owners[0].state,'awaiting_continuation');assert.equal(status.owners[0].compactionOutcome.id,compacted.id);assert.deepEqual(status.owners[0].continuationOwner,{parentID:'root',childID:child.id,action:'resume_same_child'});assert.equal(h.calls.length,1);
});
test('status distinguishes an idle native worker from stale recorded running work without completing it',async t=>{
 const h=await harness(t);const result=await h.call({...base,background:true});const child=h.sessions.find(s=>s.id===result.metadata.sessionID);child.active=false;child.lastIdleOutcome='succeeded';
 const status=JSON.parse((await h.call({taskId:'release'},'task_dispatch_status')).content).owners[0];
 assert.equal(status.recordedState,'running');assert.equal(status.effectiveState,'awaiting_result_collection');assert.deepEqual(status.nativeExecution,{active:false,lastIdleOutcome:'succeeded'});assert.equal(h.calls.length,1);
});
test('status collection eligibility matches collect structural checks and reports the recorded parent',async t=>{
 const h=await harness(t);const started=await h.call({...base,background:true});const child=h.sessions.find(s=>s.id===started.metadata.sessionID);child.active=false;
 let owner=JSON.parse((await h.call({taskId:'release'},'task_dispatch_status')).content).owners[0];
 assert.equal(owner.collection.eligibleForInspection,true);assert.equal(owner.collection.blockedReason,undefined);assert.equal(owner.collection.responsibleParentID,'root');
 await h.registry('/project',async(state,save)=>{state.records[0].completionBinding.generation=99;await save();});owner=JSON.parse((await h.call({taskId:'release'},'task_dispatch_status')).content).owners[0];assert.equal(owner.collection.eligibleForInspection,false);assert.equal(owner.collection.blockedReason,'completion binding does not match the recorded generation');
 await h.registry('/project',async(state,save)=>{state.records[0].completionBinding.generation=state.records[0].admissionGeneration;await save();});
 child.agent='scout';owner=JSON.parse((await h.call({taskId:'release'},'task_dispatch_status')).content).owners[0];assert.equal(owner.collection.eligibleForInspection,false);assert.equal(owner.collection.blockedReason,'child role does not match the recorded role');
 child.agent='builder';child.model='openai/other#medium';owner=JSON.parse((await h.call({taskId:'release'},'task_dispatch_status')).content).owners[0];assert.equal(owner.collection.eligibleForInspection,false);assert.equal(owner.collection.blockedReason,'child model does not match the recorded model');
 child.model=undefined;await h.registry('/project',async(state,save)=>{state.records[0].intentRevision=2;await save();});owner=JSON.parse((await h.call({taskId:'release'},'task_dispatch_status')).content).owners[0];assert.equal(owner.collection.eligibleForInspection,false);assert.equal(owner.collection.blockedReason,'recorded intent is stale');
 owner=JSON.parse((await h.call({taskId:'release'},'task_dispatch_status',child.id)).content).owners[0];assert.equal(owner.collection.eligibleForInspection,false);assert.equal(owner.collection.blockedReason,'caller is not the recorded parent');
});
test('background collection requires an exact generation receipt and is idempotent',async t=>{
 let reads=0;const h=await harness(t,undefined,undefined,{loadCompletionReceipt:async()=>{reads++;return {promptID:'prompt',assistantID:'answer',assistantSeq:2,idleID:'idle',idleSeq:3};}});
 const started=await h.call({...base,background:true});const id=started.metadata.sessionID;h.sessions.find(s=>s.id===id).active=false;
 const collect={taskId:'release',workKey:'backend',sessionID:id,generation:1};
 const first=JSON.parse((await h.call(collect,'task_dispatch_collect')).content);assert.equal(first.status,'completed');assert.equal(reads,1);
 let status=JSON.parse((await h.call({taskId:'release'},'task_dispatch_status')).content).owners[0];assert.equal(status.collection.terminalEvidenceVerified,true);
 const second=JSON.parse((await h.call(collect,'task_dispatch_collect')).content);assert.equal(second.status,'completed');assert.equal(reads,1);
 await h.registry('/project',async(state,save)=>{state.records[0].completionReceipt.generation=0;await save();});status=JSON.parse((await h.call({taskId:'release'},'task_dispatch_status')).content).owners[0];assert.equal(status.collection.terminalEvidenceVerified,false);
 await assert.rejects(h.call({...collect,generation:2},'task_dispatch_collect'),/parent, task, work key, child, and generation exactly/);
});
test('background collection rejects foreign parent, active descendants, and legacy bindings',async t=>{
 const receipt=async()=>({promptID:'prompt',assistantID:'answer',assistantSeq:2,idleID:'idle',idleSeq:3});
 const h=await harness(t,undefined,undefined,{loadCompletionReceipt:receipt});const started=await h.call({...base,background:true}),id=started.metadata.sessionID;h.sessions.find(s=>s.id===id).active=false;
 const collect={taskId:'release',workKey:'backend',sessionID:id,generation:1};
 await assert.rejects(h.call(collect,'task_dispatch_collect',id),/parent, task, work key, child, and generation exactly/);
 h.sessions.push({id:'descendant',parentID:id,agent:'builder',directory:'/project',active:true});await assert.rejects(h.call(collect,'task_dispatch_collect'),/collectable terminal boundary/);h.sessions.pop();
 await h.registry('/project',async(state,save)=>{delete state.records[0].completionBinding;await save();});await assert.rejects(h.call(collect,'task_dispatch_collect'),/no collectable background completion binding/);
});
test('collected background receipts survive plugin recreation and stale native evidence blocks review',async t=>{
 let receipt={promptID:'prompt',assistantID:'answer',assistantSeq:2,idleID:'idle',idleSeq:3};
 const loadCompletionReceipt=async()=>receipt;
 const h=await harness(t,undefined,undefined,{loadCompletionReceipt});
 const author=await h.call({...base,background:true}),sessionID=author.metadata.sessionID;
 h.sessions.find(s=>s.id===sessionID).active=false;
 const args={taskId:'release',workKey:'backend',sessionID,generation:1};
 const before=JSON.parse((await h.call(args,'task_dispatch_collect')).content);
 h.tools.set('subagent',{...h.rawNative});
 await installTaskDispatch(h.ctx,{registry:createRegistry(h.dir),globalRegistry:createRegistry(path.join(h.dir,'global-writers')),loadSessions:async()=>h.sessions,loadSources:async()=>['msg_user'],loadRoutingPolicy:()=>undefined,loadCompletionReceipt});
 assert.deepEqual(JSON.parse((await h.call(args,'task_dispatch_collect')).content),before);
 receipt=null;
 await assert.rejects(h.call({...base,workKey:'review',operation:'inspect',agent:'builder',requiredCapabilities:['shell'],writePaths:[],routing:{complexity:'standard',risk:'normal',reviewOfChildID:sessionID,reviewIndependence:'preferred'}}),/receipt|evidence|generation/);
 assert.equal(h.calls.length,1,'collection and rejected review must not start inference');
});

test('native model steps cannot escape an unfinished managed root',async t=>{
 const h=await harness(t);await h.call({...base,background:true});
 await assert.rejects(h.hooks.get('model.request')({sessionID:'root',agent:'build'}),/managed task ownership/);
 h.sessions.push({id:'fresh-native',agent:'build',active:true});
 await h.hooks.get('model.request')({sessionID:'fresh-native',agent:'build'});
});

test('native Effect codec inputs use the pinned JSON contract without cloning functions',async t=>{
 const h=await harness(t,undefined,function EffectCodec(){});
 const event={agent:'build',sessionID:'root',tools:{subagent:{...h.tools.get('subagent')}},system:[]};
 await h.hooks.get('context')(event);
 assert.equal(event.tools.subagent.input.type,'object');assert.deepEqual(event.tools.subagent.input.required,['agent','description','prompt']);
 assert.ok(event.tools.subagent.input.properties.model.description.includes('explicitly'));
 const result=await h.tools.get('subagent').execute({agent:'explore',description:'Inspect files',prompt:'Inspect files'},{sessionID:'root',agent:'build',progress:async()=>{}});
 assert.equal(result.content,'OK');assert.equal(h.calls.length,1);
});

test('verify requires shell, preserves explicit model and reserves writes despite edit denial',async t=>{
 const h=await harness(t);const list=h.ctx.agent.list;
 h.ctx.agent.list=async()=>({data:[...(await list()).data,{id:'harness-verifier',model:'openai/fixture-strong#high',permissions:[{action:'edit',resource:'*',effect:'deny'},{action:'subagent',resource:'*',effect:'deny'}]}]});
 await assert.rejects(h.call({...base,agent:'scout',operation:'verify',requiredCapabilities:[],prompt:'Run the checks',writePaths:[]}),/cannot perform shell/);
 assert.equal(h.calls.length,0);
 await assert.rejects(h.call({...base,agent:'harness-verifier',operation:'inspect',requiredCapabilities:[],writePaths:[]}),/verifier requires operation verify/);
 const result=await h.call({...base,agent:'harness-verifier',operation:'verify',requiredCapabilities:[],prompt:'Run the checks',writePaths:[],model:'anthropic/fixture-opus#high'});
 assert.equal(result.content,'OK');assert.equal(h.calls[0].model,'anthropic/fixture-opus#high');
 await h.registry('/project',async state=>assert.deepEqual(state.records[0].writePaths,['.']));
});
test('scoped edit eligibility supports verifier artifact continuations without granting workspace access',async t=>{
 const scopedPermissions=[{action:'shell',resource:'*',effect:'allow'},{action:'edit',resource:'*',effect:'deny'},{action:'edit',resource:'artifacts/*',effect:'allow'},{action:'subagent',resource:'*',effect:'deny'}];
 assert.equal(hasCapability({permissions:scopedPermissions},'edit'),true);
 assert.equal(scopedPermissions.some(rule=>rule.action==='edit'&&rule.resource==='*'&&rule.effect==='allow'),false);
 const h=await harness(t);const list=h.ctx.agent.list;
 h.ctx.agent.list=async()=>({data:[...(await list()).data,{id:'harness-verifier',model:'openai/fixture-strong#high',permissions:scopedPermissions},{id:'harness-scoped-inspector',permissions:scopedPermissions},{id:'harness-readonly',permissions:[{action:'shell',resource:'*',effect:'allow'},{action:'edit',resource:'*',effect:'deny'}]}]});
 const verifier={...base,agent:'harness-verifier',operation:'verify',requiredCapabilities:['shell','edit'],prompt:'Verify artifact',writePaths:['artifacts/report.json'],background:true};
 const first=await h.call(verifier);const sessionID=first.metadata.sessionID;
 await h.registry('/project',async state=>assert.deepEqual(state.records[0].writePaths,['artifacts/report.json']));
 await h.call({action:'set',taskId:'release',expectedRevision:1,intent:{...intent,target:'Rebound artifact',sourceMessageIDs:['msg_correction']}},'task_intent');
 h.sessions.find(session=>session.id===sessionID).active=false;
 await h.call({...verifier,intentRevision:2,sessionID,writePaths:undefined});
 await h.registry('/project',async state=>assert.deepEqual(state.records[0].writePaths,['artifacts/report.json']));
 await h.call({...verifier,intentRevision:2,workKey:'artifact-next',writePaths:['artifacts/next.json']});
 await h.call({...base,intentRevision:2,workKey:'scoped-inspect',operation:'inspect',agent:'harness-scoped-inspector',requiredCapabilities:[],description:'Inspect artifact',prompt:'Inspect artifact',writePaths:undefined});
 await h.registry('/project',async state=>assert.deepEqual(state.records.find(record=>record.workKey==='scoped-inspect').writePaths,[]));
 const currentList=h.ctx.agent.list;
 h.ctx.agent.list=async()=>({data:(await currentList()).data.map(agent=>agent.id==='harness-verifier'?{...agent,permissions:[{action:'shell',resource:'*',effect:'allow'},{action:'edit',resource:'*',effect:'deny'}]}:agent)});
 await assert.rejects(h.call({...verifier,intentRevision:2,sessionID,writePaths:undefined}),error=>{
  assert.match(error.message,/existing same-identity assignment/);assert.match(error.message,/missing required capability: edit/);return true;
 });
 await assert.rejects(h.call({...base,workKey:'readonly-artifact',agent:'harness-readonly',operation:'verify',requiredCapabilities:['shell','edit'],prompt:'Verify without edit access',writePaths:['artifacts/readonly.json']}),error=>{
  assert.equal(error.code,'TASK_DISPATCH_CAPABILITY_MISMATCH');assert.match(error.message,/cannot perform edit/);return true;
 });
 assert.equal(h.calls.some(call=>call.agent==='harness-readonly'),false);
});
test('enabled routing policy requires assessment for new work but preserves admitted continuation',async t=>{
 const policy={version:1,enabled:true,roles:{}};
 const h=await harness(t,undefined,undefined,{loadRoutingPolicy:()=>policy,loadQuota:async()=>({})});
 await assert.rejects(h.call(base),/ROUTING_ASSESSMENT_REQUIRED/);
 assert.equal(h.calls.length,0);await h.registry('/project',async state=>assert.equal(state.records.length,0));
 const first=await h.call({...base,routing:{complexity:'standard',risk:'normal'}});
 const next=await h.call({...base,sessionID:first.metadata.sessionID});
 assert.equal(next.metadata.sessionID,first.metadata.sessionID);assert.equal(h.calls.length,2);
});

test('root status delivers nested current-generation recovery to its real parent only',async t=>{
 const h=await harness(t);const {quotaRecoveryReceipt,enqueueQuotaRecovery}=await import('../plugins/v2/quota-recovery.mjs');
 h.sessions.push({id:'coord',parentID:'root',agent:'coordinator',active:false},{id:'nested',parentID:'coord',agent:'builder',active:false});
 const error=Object.assign(new Error('fixture'),{code:'SUBSCRIPTION_QUOTA_CHECK_FAILED',quota:{category:'telemetry_failure'},detail:{reason:'timeout'}});
 await h.registry('/project',async(state,save)=>{
  state.records.push({key:'nested',rootID:'root',parentID:'coord',childID:'nested',taskId:'release',workKey:'nested',state:'failed',admissionGeneration:2});
  for(const generation of [1,2])enqueueQuotaRecovery(state,quotaRecoveryReceipt({error,parentID:'coord',childID:'nested',generation}));await save();
 });
 const notices=[];h.ctx.session.synthetic=async notice=>notices.push(notice);
 const status=JSON.parse((await h.call({},'task_dispatch_status')).content);
 assert.equal(notices.length,1);assert.equal(notices[0].sessionID,'coord');assert.equal(notices[0].resume,false);assert.equal(notices[0].metadata.generation,2);
 assert.equal(status.quotaRecoveryPending.length,0);assert.equal(h.calls.length,0);
 await h.call({},'task_dispatch_status');assert.equal(notices.length,1);
 await h.registry('/project',async state=>{assert.equal(state.quotaRecoveryOutbox[0].deliveredAt,undefined);assert.ok(state.quotaRecoveryOutbox[1].deliveredAt);});
});

test('routing assessment cannot mask an existing denial without a child',async t=>{
 const policy={version:1,enabled:true,roles:{}};
 const h=await harness(t,async()=>{throw new Error('Subagent denied: builder');},undefined,{loadRoutingPolicy:()=>policy,loadQuota:async()=>({})});
 await assert.rejects(h.call({...base,routing:{complexity:'standard',risk:'normal'}}),/Subagent denied/);
 await assert.rejects(h.call(base),/admission remains denied/);
 assert.equal(h.calls.length,1);
});

test('review provenance binds a completed implementation owner and rejects forged, stale, or active references',async t=>{
 const policy={version:1,enabled:true,roles:{reviewer:[{ref:'anthropic/reviewer#high'}]}};
 const healthy={checked_at:new Date().toISOString(),availability:'available',credit_risk:'none',financial:{extra_usage_enabled:false},windows:[{scope:'account',used_percent:20,remaining_percent:80,duration_minutes:10080,pace_delta:0,resets_at:new Date(Date.now()+60_000).toISOString()}]};
 const h=await harness(t,undefined,undefined,{loadRoutingPolicy:()=>policy,loadQuota:async()=>({catalog:[{providerID:'anthropic',id:'reviewer',variants:[{id:'high'}]}],pools:{anthropic:healthy}})});
 const list=h.ctx.agent.list;h.ctx.agent.list=async()=>({data:[...(await list()).data,{id:'reviewer',model:'anthropic/reviewer#high',permissions:[{action:'shell',resource:'*',effect:'allow'},{action:'edit',resource:'*',effect:'deny'},{action:'subagent',resource:'*',effect:'deny'}]}]});
 const author=await h.call({...base,model:'openai/author#medium',routing:{complexity:'standard',risk:'normal'}});
 const review={...base,taskId:'release',workKey:'review',operation:'inspect',agent:'reviewer',description:'Review implementation',prompt:'Review completed implementation',requiredCapabilities:['shell'],writePaths:[],routing:{complexity:'complex',risk:'high',reviewOfChildID:author.metadata.sessionID,reviewIndependence:'required'}};
 const accepted=await h.call(review);assert.equal(h.calls.at(-1).model,'anthropic/reviewer#high');
 await h.registry('/project',async state=>assert.deepEqual(state.records.find(record=>record.workKey==='review').routing.reviewProvenance,{childID:author.metadata.sessionID,model:'openai/author#medium',source:'admitted_route',generation:1}));
 const continued=await h.call({...review,sessionID:accepted.metadata.sessionID,routing:{complexity:'complex',risk:'high',reviewOfChildID:author.metadata.sessionID}});assert.equal(continued.metadata.sessionID,accepted.metadata.sessionID);assert.equal(h.calls.at(-1).model,'anthropic/reviewer#high');
 const authorIndex=h.sessions.findIndex(s=>s.id===author.metadata.sessionID),authorSession=h.sessions.splice(authorIndex,1)[0];
 await assert.rejects(h.call({...review,sessionID:accepted.metadata.sessionID}),/unknown, stale, or outside/);
 h.sessions.splice(authorIndex,0,authorSession);
 await h.registry('/project',async(state,save)=>{state.records.find(r=>r.childID===author.metadata.sessionID).admissionGeneration=2;await save();});
 await assert.rejects(h.call({...review,sessionID:accepted.metadata.sessionID}),/author generation changed/);
 await h.registry('/project',async(state,save)=>{state.records.find(r=>r.childID===author.metadata.sessionID).admissionGeneration=1;await save();});
 await assert.rejects(h.call({...review,sessionID:accepted.metadata.sessionID,routing:{complexity:'complex',risk:'high',reviewOfChildID:author.metadata.sessionID,reviewIndependence:'preferred'}}),/retain its admitted independence requirement/);
 await assert.rejects(h.call({...review,sessionID:accepted.metadata.sessionID,model:'openai/reviewer#high'}),/retain its admitted reviewer model/);
 await assert.rejects(h.call({...review,workKey:'injected',routing:{...review.routing,reviewProvenance:{childID:'forged',model:'anthropic/forged#high'}}}),/invalid routing assessment/);
 await assert.rejects(h.call({...review,workKey:'forged',routing:{...review.routing,reviewOf:'anthropic/forged#high'}}),/does not match/);
 await assert.rejects(h.call({...review,workKey:'stale',routing:{...review.routing,reviewOfChildID:'missing'}}),/unknown, stale, or outside/);
 h.sessions.find(session=>session.id===author.metadata.sessionID).active=true;
 await assert.rejects(h.call({...review,workKey:'active'}),/review author is still active/);
 h.sessions.find(session=>session.id===author.metadata.sessionID).active=false;
 await h.registry('/project',async(state,save)=>{state.records.find(record=>record.workKey==='backend').state='running';await save();});
 await assert.rejects(h.call({...review,workKey:'idle-without-completion'}),/no completed admitted implementation generation \(recorded state: running\)/);
 await assert.rejects(h.call({...review,workKey:'required-without-owner',routing:{complexity:'complex',risk:'high',reviewIndependence:'required'}}),/needs routing\.reviewOfChildID/);
 assert.equal(h.calls.length,3);
});
