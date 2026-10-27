import test from 'node:test';
import assert from 'node:assert/strict';
import {selectDispatchModel,quotaPace,modelReference} from '../plugins/v2/dispatch-routing.mjs';
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
function pool(provider,delta=0){return {checked_at:new Date().toISOString(),availability:'available',credit_risk:'none',financial:{extra_usage_enabled:false},windows:[{scope:'account',used_percent:20,duration_minutes:10080,pace_delta:delta}]};}
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
 const q=multi();q.pools.openai=pool('openai',-40);q.pools.anthropic=pool('anthropic',0);
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
test('cross-family review is optional and a single healthy pool remains useful',()=>{
 const q=multi();delete q.pools.openai;q.catalog=q.catalog.filter(m=>m.providerID==='anthropic');
 const result=selectDispatchModel({...base,agent:{model:'anthropic/opus#high'},input:{agent:'reviewer',routing:{complexity:'complex',risk:'high',reviewOf:'anthropic/sonnet#high'}},quota:q});
 assert.equal(result.selected,'anthropic/opus#high');assert.equal(result.source,'subscription_pool_selection');
});
