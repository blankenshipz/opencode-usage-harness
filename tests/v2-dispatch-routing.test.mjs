import test from 'node:test';
import assert from 'node:assert/strict';
import {selectDispatchModel,quotaPace,modelReference,validateTaskFitPolicy,taskTypeFor,readRoutingPolicy,readRoutingQuota} from '../plugins/v2/dispatch-routing.mjs';
const agent={id:'builder',model:{providerID:'openai',id:'balanced',variant:'medium'}};
const agents=[agent,{id:'quick-builder',model:{providerID:'openai',id:'fast',variant:'low'}}];
const quota={checked_at:new Date().toISOString(),buckets:[{windows:[{pace_delta:60,remaining_percent:34}]}]};
const base={input:{agent:'builder'},agent,agents,record:{},child:{model:{providerID:'openai',id:'strong',variant:'high'}},quota};
test('continuation supplies configured model rather than inheriting stale child choice',()=>{
 assert.equal(selectDispatchModel(base).selected,'openai/balanced#medium');
 assert.equal(modelReference('bad model'),undefined);
});
test('explicit override persists and a subsequent observed manual switch wins',()=>{
 let r=selectDispatchModel({...base,input:{agent:'builder',model:'openai/strong#high'}});
 assert.equal(r.modelOverride,'openai/strong#high');
 r=selectDispatchModel({...base,record:{modelOverride:r.modelOverride,routing:r},child:{model:'openai/custom#high'}});
 assert.equal(r.selected,'openai/custom#high');
 assert.equal(selectDispatchModel({...base,input:{agent:'builder',resetModel:true},record:{modelOverride:'openai/strong#high'}}).selected,'openai/balanced#medium');
});
test('only explicitly routine normal risk work is paced down within provider',()=>{
 assert.equal(selectDispatchModel({...base,input:{agent:'builder',routing:{complexity:'routine',risk:'normal'}}}).selected,'openai/fast#low');
 for (const routing of [{complexity:'complex',risk:'normal'},{complexity:'routine',risk:'high'}]) assert.equal(selectDispatchModel({...base,input:{agent:'builder',routing}}).selected,'openai/balanced#medium');
 assert.equal(selectDispatchModel({...base,input:{agent:'builder',routing:{complexity:'routine',risk:'normal'}},agents:[agent,{id:'quick-builder',model:'other/fast#low'}]}).selected,'openai/balanced#medium');
});
test('missing/stale quota and short-window pressure are handled conservatively',()=>{
 assert.equal(quotaPace(null),'unknown');
 assert.equal(quotaPace({...quota,checked_at:'2000-01-01'}),'unknown');
 assert.equal(quotaPace({...quota,buckets:[{windows:[{pace_delta:-30,remaining_percent:90},{pace_delta:11,remaining_percent:20}]}]}),'ahead');
});

const policy = {version:1,enabled:true,reservePercent:2,roles:{builder:[{ref:'openai/sol#medium',profile:'openai-sol'},{ref:'anthropic/sonnet#high',profile:'claude-sonnet'}],reviewer:[{ref:'openai/sol#high'},{ref:'anthropic/opus#high'}]}};
const catalog=[['openai','sol','medium'],['openai','sol','high'],['anthropic','sonnet','high'],['anthropic','opus','high']].map(([providerID,id,v])=>({providerID,id,variants:[{id:v},...(id==='sol'?[{id:'high'}]:[])]}));
function weekly(delta=0,remaining=.5,extra={}){
 const duration=10080,target=100*(1-remaining),used=target+delta;
 return {scope:'account',used_percent:used,remaining_percent:100-used,duration_minutes:duration,pace_delta:delta,resets_at:new Date(Date.now()+remaining*duration*60_000).toISOString(),...extra};
}
function pool(provider,delta=0,remaining=.5){
 return {checked_at:new Date().toISOString(),availability:'available',credit_risk:'none',financial:{extra_usage_enabled:false},windows:[weekly(delta,remaining)]};
}
function multi(){return {routingPolicy:policy,catalog,pools:{openai:pool('openai'),anthropic:pool('anthropic',-40)}};}
test('new capable task can prefer expiring Claude allowance, admitted continuation stays pinned',()=>{
 const q=multi(),input={agent:'builder',routing:{complexity:'standard',risk:'normal'}};
 const first=selectDispatchModel({...base,agent:{model:'openai/sol#medium'},input,quota:q});
 assert.equal(first.selected,'anthropic/sonnet#high');
 q.pools.anthropic.availability='unavailable';
 const continued=selectDispatchModel({...base,input,quota:q,record:{routing:first},child:{model:first.selected}});
 assert.equal(continued.selected,first.selected);assert.equal(continued.source,'continuation_affinity');
});
test('comparable review prefers other family only with eligible healthy pool',()=>{
 const q=multi();q.pools.openai=pool('openai',-5);q.pools.anthropic=pool('anthropic',0);
 const input={agent:'reviewer',routing:{complexity:'complex',risk:'high',reviewOf:'openai/sol#medium'}};
 assert.equal(selectDispatchModel({...base,input,quota:q}).selected,'anthropic/opus#high');
 q.pools.anthropic.financial.extra_usage_enabled=true;
 assert.equal(selectDispatchModel({...base,input,quota:q}).selected,'openai/sol#high');
});
test('explicit model beats balancing; stale pools and unadvertised models cannot be automatically selected',()=>{
 const q=multi(),input={agent:'builder',model:'openai/sol#medium',routing:{complexity:'standard',risk:'normal'}};
 assert.equal(selectDispatchModel({...base,input,quota:q}).selected,input.model);
 delete input.model;q.pools.anthropic.checked_at='2000-01-01';
 assert.equal(selectDispatchModel({...base,input,quota:q}).selected,'openai/sol#medium');
 q.catalog=[];assert.equal(selectDispatchModel({...base,input,quota:q}).selected,base.agent.model.providerID+'/balanced#medium');
});
test('Fable scoped exhaustion does not exclude ordinary Claude routes',()=>{
 const q=multi();q.pools.anthropic.windows.push({scope:'model',model:'Fable',used_percent:100,pace_delta:100});
 assert.equal(selectDispatchModel({...base,input:{agent:'builder',routing:{complexity:'standard',risk:'normal'}},quota:q}).selected,'anthropic/sonnet#high');
});

test('reset clears override metadata but cannot reroute an admitted generation',()=>{
 const result=selectDispatchModel({...base,quota:multi(),input:{agent:'builder',resetModel:true,routing:{complexity:'standard',risk:'normal'}},record:{modelOverride:'openai/sol#medium',routing:{selected:'openai/sol#medium'}},child:{model:'openai/sol#medium'}});
 assert.equal(result.selected,'openai/sol#medium');assert.equal(result.modelOverride,undefined);assert.equal(result.source,'continuation_affinity');
});

test('routine single-pool pacing uses that role provider rather than another subscription',()=>{
 const q=multi();q.pools.anthropic=pool('anthropic',20);q.pools.openai=pool('openai',-40);delete q.routingPolicy;
 const a={id:'builder',model:'anthropic/sonnet#high'},fast={id:'quick-builder',model:'anthropic/haiku#medium'};
 const input={agent:'builder',routing:{complexity:'routine',risk:'normal'}};
 assert.equal(selectDispatchModel({...base,agent:a,agents:[a,fast],input,quota:q}).selected,'anthropic/haiku#medium');
 q.pools.anthropic=pool('anthropic',0);q.pools.openai=pool('openai',40);
 assert.equal(selectDispatchModel({...base,agent:a,agents:[a,fast],input,quota:q}).selected,'anthropic/sonnet#high');
});
test('prefixed visible roles retain canonical pacing and old policy keys',()=>{
 const q={...multi()}; delete q.routingPolicy;
 const a={id:'harness-builder',model:'openai/sol#medium'},fast={id:'harness-quick-builder',model:'openai/fast#low'};
 const input={agent:'harness-builder',routing:{complexity:'routine',risk:'normal'}};
 assert.equal(selectDispatchModel({...base,agent:a,agents:[a,fast],input,quota:{...q,pools:{openai:pool('openai',20)}}}).selected,'openai/fast#low');
});
test('cross-family review is optional and a single healthy pool remains useful',()=>{
 const q=multi();delete q.pools.openai;q.catalog=q.catalog.filter(m=>m.providerID==='anthropic');
 const result=selectDispatchModel({...base,agent:{model:'anthropic/opus#high'},input:{agent:'reviewer',routing:{complexity:'complex',risk:'high',reviewOf:'anthropic/sonnet#high'}},quota:q});
 assert.equal(result.selected,'anthropic/opus#high');assert.equal(result.source,'subscription_pool_selection');
});

test('far-behind pools rank continuously instead of provider order',()=>{
 const q=multi();q.pools.openai=pool('openai',-25,.5);q.pools.anthropic=pool('anthropic',-45,.5);
 const result=selectDispatchModel({...base,input:{agent:'builder',routing:{complexity:'standard',risk:'normal'}},quota:q});
 assert.equal(result.selected,'anthropic/sonnet#high');
 assert.equal(result.poolPacing.provider,'anthropic');
 assert.equal(result.poolPacing.limitingWeeklyPaceDelta,-45);
});
test('every applicable weekly window constrains selection regardless of source order',()=>{
 const input={agent:'builder',routing:{complexity:'standard',risk:'normal'}};
 for (const windows of [[weekly(-40,.5),weekly(5,.5)],[weekly(5,.5),weekly(-40,.5)]]) {
  const q=multi();q.pools.openai.windows=windows;q.pools.anthropic=pool('anthropic',-10,.5);
  assert.equal(selectDispatchModel({...base,input,quota:q}).selected,'anthropic/sonnet#high');
 }
});
test('equal limiting deltas use the earliest reset regardless of source order',()=>{
 const input={agent:'builder',routing:{complexity:'standard',risk:'normal'}};
 for (const windows of [[weekly(-10,.8),weekly(-10,.2)],[weekly(-10,.2),weekly(-10,.8)]]) {
  const q=multi();q.pools.openai.windows=windows;q.pools.anthropic=pool('anthropic',-9,.5);
  const result=selectDispatchModel({...base,input,quota:q});
  assert.equal(result.selected,'openai/sol#medium');
  assert.equal(result.poolPacing.limitingWeeklyPaceDelta,-10);
  assert.equal(result.poolPacing.limitingWeeklyResetsAt,windows.find(w=>w.used_percent===70).resets_at);
 }
});
test('equal weekly deficits favor the pool whose own allowance resets sooner',()=>{
 const q=multi();q.pools.openai=pool('openai',-20,.2);q.pools.anthropic=pool('anthropic',-20,.8);
 assert.equal(selectDispatchModel({...base,input:{agent:'builder',routing:{complexity:'standard',risk:'normal'}},quota:q}).selected,'openai/sol#medium');
});
test('on-pace weekly usage below reserve remains healthy near its reset',()=>{
 const q=multi();q.pools.openai=pool('openai',0,.05);q.pools.anthropic.availability='unavailable';
 const result=selectDispatchModel({...base,input:{agent:'builder',routing:{complexity:'standard',risk:'normal'}},quota:q});
 assert.equal(result.selected,'openai/sol#medium');
 assert.equal(result.pace,'normal');
});
test('on-pace weekly usage near reset does not demote routine single-pool work',()=>{
 const q=multi();delete q.routingPolicy;q.pools.anthropic=pool('anthropic',0,.05);
 const a={id:'builder',model:'anthropic/sonnet#high'},fast={id:'quick-builder',model:'anthropic/haiku#medium'};
 assert.equal(selectDispatchModel({...base,agent:a,agents:[a,fast],input:{agent:'builder',routing:{complexity:'routine',risk:'normal'}},quota:q}).selected,'anthropic/sonnet#high');
});
test('short-window pressure loses to a healthy peer even with weekly deficit',()=>{
 const q=multi();q.pools.openai=pool('openai',-40,.5);
 q.pools.openai.windows.push({scope:'account',used_percent:95,remaining_percent:5,duration_minutes:300,pace_delta:-20,resets_at:new Date(Date.now()+60*60_000).toISOString()});
 q.pools.anthropic=pool('anthropic',-1,.5);
 assert.equal(selectDispatchModel({...base,input:{agent:'builder',routing:{complexity:'standard',risk:'normal'}},quota:q}).selected,'anthropic/sonnet#high');
});
test('ahead weekly pace is pressured even below the usage reserve',()=>{
 const q=multi();q.pools.openai=pool('openai',15,.5);q.pools.anthropic=pool('anthropic',-1,.5);
 assert.equal(selectDispatchModel({...base,input:{agent:'builder',routing:{complexity:'standard',risk:'normal'}},quota:q}).selected,'anthropic/sonnet#high');
});
test('independent pool usages and resets are never combined',()=>{
 const q=multi();q.pools.openai=pool('openai',0,.05);q.pools.anthropic=pool('anthropic',-5,.2);
 // The two reported usages add past 100%, but they are separate subscriptions.
 assert.ok(q.pools.openai.windows[0].used_percent+q.pools.anthropic.windows[0].used_percent>100);
 assert.equal(selectDispatchModel({...base,input:{agent:'builder',routing:{complexity:'standard',risk:'normal'}},quota:q}).selected,'anthropic/sonnet#high');
});
test('scoped exhaustion excludes only candidates matching that scope',()=>{
 const q=multi();q.catalog.push({providerID:'anthropic',id:'fable',variants:[{id:'high'}]});
 q.routingPolicy={...policy,roles:{builder:[{ref:'anthropic/fable#high'},{ref:'openai/sol#medium'}]}};
 q.pools.anthropic.windows.push({...weekly(0,.5),scope:'model',model:'Fable',used_percent:100,remaining_percent:0});
 assert.equal(selectDispatchModel({...base,input:{agent:'builder',routing:{complexity:'standard',risk:'normal'}},quota:q}).selected,'openai/sol#medium');
});
test('required scoped quota needs a current matching meter',()=>{
 const input={agent:'builder',routing:{complexity:'standard',risk:'normal'}};
 for (const scoped of [
  {...weekly(-20,.5),scope:'model',model:'Fable'},
  {scope:'model',model:'Fable',used_percent:20,remaining_percent:80},
  {...weekly(-20,.5),scope:'model',model:'Fable',resets_at:new Date(Date.now()-60_000).toISOString()},
 ]) {
  const q=multi();q.catalog.push({providerID:'anthropic',id:'fable',variants:[{id:'high'}]});
  q.routingPolicy={...policy,roles:{builder:[{ref:'anthropic/fable#high',requiresScopedQuota:true},{ref:'openai/sol#medium'}]}};
  q.pools.anthropic.windows.push(scoped);
  const selected=selectDispatchModel({...base,input,quota:q}).selected;
  if (scoped.resets_at && Date.parse(scoped.resets_at)>Date.now()) assert.equal(selected,'anthropic/fable#high');
  else assert.equal(selected,'openai/sol#medium');
 }
});
test('one available pool with an unknown reset falls back to the configured role',()=>{
 const q=multi();delete q.pools.anthropic;q.pools.openai.windows=[{scope:'account',used_percent:20,remaining_percent:80}];
 assert.equal(selectDispatchModel({...base,input:{agent:'builder',routing:{complexity:'standard',risk:'normal'}},quota:q}).selected,'openai/balanced#medium');
});

function fitPolicy() {
 return {version:1,enabled:true,roles:{builder:[
  {ref:'openai/sol#medium',taskFit:{implementation:{band:'preferred',evidence_status:'supported',evidence_ref:'benchmark-42'}}},
  {ref:'anthropic/sonnet#high',taskFit:{implementation:{band:'acceptable',evidence_status:'supported'}}}
 ]}};
}
test('standard work ranks supported fit ahead of larger healthy spare quota, while routine balances quota',()=>{
 const q=multi();q.routingPolicy=fitPolicy();q.pools.openai=pool('openai',-5);q.pools.anthropic=pool('anthropic',-50);
 const standard=selectDispatchModel({...base,input:{agent:'builder',routing:{complexity:'standard',risk:'normal'}},quota:q});
 assert.equal(standard.selected,'openai/sol#medium');
 assert.equal(standard.explanation,'supported_task_fit_preference');
 assert.deepEqual(standard.taskFit,{taskType:'implementation',band:'preferred',evidenceStatus:'supported',reason:'supported_preferred'});
 assert.equal(selectDispatchModel({...base,input:{agent:'builder',routing:{complexity:'routine',risk:'normal'}},quota:q}).selected,'anthropic/sonnet#high');
});
test('a healthy acceptable route can replace a pressured preferred route for standard new work',()=>{
 const q=multi();q.routingPolicy=fitPolicy();q.pools.openai=pool('openai',20);q.pools.anthropic=pool('anthropic',0);
 const result=selectDispatchModel({...base,input:{agent:'builder',routing:{complexity:'standard',risk:'normal'}},quota:q});
 assert.equal(result.selected,'anthropic/sonnet#high');
 assert.equal(result.explanation,'healthy_acceptable_over_pressured_preferred');
});
test('complex/high-risk work rejects lower fit but permits an exact preferred configured fallback',()=>{
 const q=multi();q.routingPolicy=fitPolicy();q.pools.openai.availability='unavailable';
 const input={agent:'builder',routing:{complexity:'complex',risk:'high'}};
 assert.throws(()=>selectDispatchModel({...base,input,quota:q}),error=>error.code==='ROUTING_TASK_FIT_UNAVAILABLE');
 const configured={id:'builder',model:'openai/sol#medium'};
 const fallback=selectDispatchModel({...base,agent:configured,input,quota:q});
 assert.equal(fallback.selected,'openai/sol#medium');
 assert.deepEqual(fallback.taskFit,{taskType:'implementation',band:'preferred',evidenceStatus:'supported',reason:'supported_preferred'});
});
test('provisional preferred is neutral and task type inference remains backward compatible',()=>{
 const q=multi();q.routingPolicy=fitPolicy();q.routingPolicy.roles.builder[0].taskFit.implementation={band:'preferred',evidence_status:'provisional'};
 q.pools.openai=pool('openai',-5);q.pools.anthropic=pool('anthropic',-50);
 assert.equal(selectDispatchModel({...base,input:{agent:'builder',routing:{complexity:'standard',risk:'normal'}},quota:q}).selected,'anthropic/sonnet#high');
 assert.equal(taskTypeFor({agent:'scout',routing:{}}),'exploration');
 assert.equal(taskTypeFor({agent:'harness-builder-high',routing:{}}),'implementation');
 assert.equal(taskTypeFor({agent:'deep-debugger-high',routing:{}}),'debugging');
 assert.equal(taskTypeFor({agent:'reviewer',routing:{}}),'review');
});
test('task-fit policy validation rejects malformed evidence without leaking it',()=>{
 const valid={version:1,enabled:true,roles:{builder:[{ref:'openai/sol#medium',taskFit:{}}]}};
 const badEvidence=structuredClone(valid);badEvidence.roles.builder[0].taskFit.implementation={band:'preferred',evidence_status:'supported',evidence_ref:'secret\nraw'};
 const badType=structuredClone(valid);badType.roles.builder[0].taskFit.unknown={band:'acceptable',evidence_status:'provisional'};
 assert.throws(()=>validateTaskFitPolicy(badEvidence),error=>error.code==='ROUTING_POLICY_INVALID' && !error.message.includes('secret'));
 assert.throws(()=>validateTaskFitPolicy(badType),error=>error.code==='ROUTING_POLICY_INVALID');
 assert.throws(()=>readRoutingPolicy({readFile:()=>'{bad json'}),error=>error.code==='ROUTING_POLICY_INVALID' && !error.message.includes('json'));
});
test('disabled preferred candidates do not restrict selection, and continuations retain admitted fit metadata',()=>{
 const q=multi();q.routingPolicy=fitPolicy();q.routingPolicy.roles.builder[0].enabled=false;
 q.pools.openai.availability='unavailable';
 const input={agent:'builder',routing:{complexity:'complex',risk:'high'}};
 assert.equal(selectDispatchModel({...base,input,quota:q}).selected,'anthropic/sonnet#high');
 const admitted={selected:'openai/sol#medium',taskFit:{taskType:'implementation',band:'preferred',evidenceStatus:'supported',reason:'supported_preferred'}};
 const continued=selectDispatchModel({...base,input:{agent:'builder',routing:{complexity:'routine',risk:'normal',taskType:'mechanical'}},quota:q,record:{routing:admitted},child:{model:admitted.selected}});
 assert.deepEqual(continued.taskFit,admitted.taskFit);
});
test('disabled policy is neutral, and task fit outranks cross-family review affinity',()=>{
 const q=multi();q.routingPolicy={...fitPolicy(),enabled:false};q.pools.openai=pool('openai',-5);q.pools.anthropic=pool('anthropic',-50);
 assert.equal(selectDispatchModel({...base,input:{agent:'builder',routing:{complexity:'standard',risk:'normal'}},quota:q}).selected,'openai/balanced#medium');
 q.routingPolicy={version:1,enabled:true,roles:{reviewer:[
  {ref:'openai/sol#high',taskFit:{review:{band:'preferred',evidence_status:'supported',evidence_ref:'review-evidence'}}},
  {ref:'anthropic/opus#high',taskFit:{review:{band:'acceptable',evidence_status:'supported'}}}
 ]}};
 q.pools.openai=pool('openai',0);q.pools.anthropic=pool('anthropic',0);
 assert.equal(selectDispatchModel({...base,input:{agent:'reviewer',routing:{complexity:'standard',risk:'normal',reviewOf:'openai/sol#medium'}},quota:q}).selected,'openai/sol#high');
});
test('policy is retained when catalog or telemetry reads fail',async()=>{
 const policy=fitPolicy();
 const catalogFailure=await readRoutingQuota({model:{list:async()=>{throw new Error('offline');}}},{readPolicy:()=>policy});
 assert.equal(catalogFailure.routingPolicy,policy);assert.deepEqual(catalogFailure.pools,{});
 const telemetryFailure=await readRoutingQuota({model:{list:async()=>({data:catalog})}},{readPolicy:()=>policy,readQuota:async()=>{throw new Error('offline');}});
 assert.equal(telemetryFailure.routingPolicy,policy);assert.deepEqual(telemetryFailure.pools,{});
});

test('policy reader rejects unsupported or malformed provider references',()=>{
 for (const ref of ['other/model#high','openai/nested/model#high','anthropic/model','openai/model#bad effort']) {
  assert.throws(()=>readRoutingPolicy({readFile:()=>JSON.stringify({version:1,enabled:true,roles:{builder:[{ref}]}})}),error=>error.code==='ROUTING_POLICY_INVALID' && !error.message.includes(ref));
 }
});
