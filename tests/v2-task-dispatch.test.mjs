import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { installTaskDispatch, hasCapability } from '../plugins/v2/task-dispatch.mjs';
import { createV2TaskOutcomes } from '../plugins/v2/task-outcomes.mjs';
import { setIntent } from '../plugins/v2/task-intent.mjs';
import { createRegistry } from '../plugins/v2/dispatch-registry.mjs';
import { createWorkerProgress } from '../plugins/v2/worker-progress.mjs';
const agents = JSON.parse(fs.readFileSync(new URL('./fixtures/agents.json', import.meta.url)));
const intent = {outcome:'Working release',target:'Local backend',nonGoals:[],authorizedEffects:['Local changes'],assumptions:[],checks:[{id:'backend',description:'Actual backend check',mode:'local'}],sourceMessageIDs:['msg_user']};
const base = { intentRevision:1,checkIds:['backend'],taskId:'release',workKey:'backend',operation:'implement',agent:'builder',description:'Fix backend',prompt:'Implement requested backend checks',requiredCapabilities:['edit','shell'],writePaths:['backend'] };
async function harness(t, custom) {
 const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'dispatch-test-'));t.after(()=>fsp.rm(dir,{recursive:true,force:true}));
 const sessions=[{id:'root',agent:'router',directory:'/project',active:true}];const calls=[];const tools=new Map();
 const native={name:'subagent',description:'Native subagent',input:{},execute:async(input,context)=>{
  calls.push(input); if(custom)return custom(input,context,sessions,calls);
  const id=input.sessionID??`ses_${calls.length}`;let child=sessions.find(s=>s.id===id);
  if(!child){child={id,parentID:context.sessionID,agent:input.agent,directory:'/project',active:true};sessions.push(child);}
  await context.progress({sessionID:id,status:'running'});child.active=!!input.background;
  return {output:{sessionID:id,status:child.active?'running':'completed',output:'OK'},content:'OK',metadata:{sessionID:id,status:child.active?'running':'completed'}};
 }};const rawNative={...native};tools.set('subagent',native);
 const ctx={location:{directory:'/project'},agent:{list:async()=>({data:Object.entries(agents).map(([id,a])=>({id,...a}))})},tool:{transform:async fn=>fn({get:n=>tools.get(n),update:(n,fn)=>fn(tools.get(n)),add:tool=>tools.set(tool.name,tool)})}};
 const registry=createRegistry(dir);await registry('/project',async(state,save)=>{setIntent(state,{rootID:'root',taskId:'release',intent,expectedRevision:0,actorSessionID:'root'});await save();});
 const hooks=new Map();ctx.session={hook:async(name,fn)=>hooks.set(name,fn)};
 const runtime=await installTaskDispatch(ctx,{registry,loadSessions:async()=>sessions,loadSources:async()=>['msg_user','msg_correction']});
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
test('native permission errors propagate without retry',async t=>{
 const h=await harness(t,async()=>{throw new Error('native permission denied');});await assert.rejects(h.call(base),/native permission denied/);assert.equal(h.calls.length,1);
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
test('writers have disjoint ownership; deployment waits for existing writers',async t=>{
 const h=await harness(t);await h.call({...base,background:true});
 await assert.rejects(h.call({...base,workKey:'again',writePaths:['backend/api']}),/overlapping/);
 await h.call({...base,workKey:'mobile',writePaths:['mobile'],background:true});
 await assert.rejects(h.call({...base,workKey:'deploy',operation:'deploy',requiredCapabilities:['shell']}),/overlapping/);
 h.sessions.filter(s=>s.id!=='root').forEach(s=>s.active=false);
 await h.call({...base,workKey:'deploy',operation:'deploy',requiredCapabilities:['shell'],background:true});
 await assert.rejects(h.call({...base,workKey:'another-deploy',operation:'deploy',requiredCapabilities:['shell']}),/overlapping/);
});
test('legacy active workers block new writers; direct-child adoption preserves ownership',async t=>{
 const h=await harness(t);h.sessions.push({id:'legacy',parentID:'root',agent:'builder',directory:'/project',active:true});
 await assert.rejects(h.call(base),/untracked worker/);await h.call({...base,sessionID:'legacy',background:true});assert.equal(h.calls[0].sessionID,'legacy');
 await assert.rejects(h.call({...base,workKey:'changed',sessionID:'legacy'}),/retain that ownership identity/);
});
test('ownership survives plugin recreation and failed parents with active descendants',async t=>{
 const h=await harness(t);await h.call({...base,background:true});
 const recreated=new Map([['subagent',{...h.rawNative}]]);
 await installTaskDispatch({...h.ctx,tool:{transform:async fn=>fn({get:n=>recreated.get(n),update:(n,fn)=>fn(recreated.get(n)),add:t=>recreated.set(t.name,t)})}},{registry:createRegistry(h.dir),loadSessions:async()=>h.sessions});
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
 await assert.rejects(h.hooks.get('model.request')({sessionID:id}),/superseded/);
 await assert.rejects(h.call({...base,sessionID:id}),/revision/i);
 await assert.rejects(h.call({...base,intentRevision:2}),/explicitly resume/);
 await h.call({...base,intentRevision:2,sessionID:id,background:true});
 await h.hooks.get('model.request')({sessionID:id});assert.equal(h.calls[1].sessionID,id);assert.match(h.calls[1].prompt,/Physical phone/);
});
test('changed checks resend full intent to the same child',async t=>{
 const h=await harness(t);const id=(await h.call({...base,background:true})).metadata.sessionID;
 await h.call({...base,background:true,sessionID:id,checkIds:['backend']});assert.match(h.calls[1].prompt,/compact continuation/);
 await h.call({action:'set',taskId:'release',expectedRevision:1,intent:{...intent,checks:[...intent.checks,{id:'review',description:'Review the diff',mode:'synthetic'}],sourceMessageIDs:['msg_correction']}},'task_intent');
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
