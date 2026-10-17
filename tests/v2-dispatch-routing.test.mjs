import test from 'node:test';
import assert from 'node:assert/strict';
import {selectDispatchModel,quotaPace,modelReference} from '../plugins/v2/dispatch-routing.mjs';
const agent={id:'builder',model:{providerID:'demo',id:'balanced',variant:'medium'}};
const agents=[agent,{id:'quick-builder',model:{providerID:'demo',id:'fast',variant:'low'}}];
const quota={checked_at:new Date().toISOString(),buckets:[{windows:[{pace_delta:60,remaining_percent:34}]}]};
const base={input:{agent:'builder'},agent,agents,record:{},child:{model:{providerID:'demo',id:'strong',variant:'high'}},quota};
test('continuation supplies configured model rather than inheriting stale child choice',()=>{
 assert.equal(selectDispatchModel(base).selected,'demo/balanced#medium');
 assert.equal(modelReference('bad model'),undefined);
});
test('explicit override persists and a subsequent observed manual switch wins',()=>{
 let r=selectDispatchModel({...base,input:{agent:'builder',model:'demo/strong#high'}});
 assert.equal(r.modelOverride,'demo/strong#high');
 r=selectDispatchModel({...base,record:{modelOverride:r.modelOverride,routing:r},child:{model:'demo/custom#high'}});
 assert.equal(r.selected,'demo/custom#high');
 assert.equal(selectDispatchModel({...base,input:{agent:'builder',resetModel:true},record:{modelOverride:'demo/strong#high'}}).selected,'demo/balanced#medium');
});
test('only explicitly routine normal risk work is paced down within provider',()=>{
 assert.equal(selectDispatchModel({...base,input:{agent:'builder',routing:{complexity:'routine',risk:'normal'}}}).selected,'demo/fast#low');
 for (const routing of [{complexity:'complex',risk:'normal'},{complexity:'routine',risk:'high'}]) assert.equal(selectDispatchModel({...base,input:{agent:'builder',routing}}).selected,'demo/balanced#medium');
 assert.equal(selectDispatchModel({...base,input:{agent:'builder',routing:{complexity:'routine',risk:'normal'}},agents:[agent,{id:'quick-builder',model:'other/fast#low'}]}).selected,'demo/balanced#medium');
});
test('missing/stale quota and short-window pressure are handled conservatively',()=>{
 assert.equal(quotaPace(null),'unknown');
 assert.equal(quotaPace({...quota,checked_at:'2000-01-01'}),'unknown');
 assert.equal(quotaPace({...quota,buckets:[{windows:[{pace_delta:-30,remaining_percent:90},{pace_delta:11,remaining_percent:20}]}]}),'ahead');
});
