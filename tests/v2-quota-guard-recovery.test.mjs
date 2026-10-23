import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createV2Guard } from '../plugins/v2/subscription-guard.mjs';
import { createRegistry } from '../plugins/v2/dispatch-registry.mjs';
import { quotaRecoveryReceipt } from '../plugins/v2/quota-recovery.mjs';

const good = { auth_mode:'chatgpt', tokens:{account_id:'same-account'} };
const financial = { auto_top_up_off:true, automatic_reload_off:true, purchased_credit_balance_ui:0, verified_at:'2026-09-08' };
const failure = () => Object.assign(new Error('timeout'), { status:null, code:'ETIMEDOUT', signal:'SIGTERM', killed:true });
function setup({ state, synthetic, registry: injectedRegistry }) {
  const hooks=new Map();
  const registry=injectedRegistry ?? (async (_workspace,run)=>run(state,async()=>{}));
  const guard=createV2Guard({registry,readJSON:file=>file.includes('auth.json')?good:financial,env:{},runQuota:async()=>{throw failure();},append:()=>{},recordCompletion:async()=>{}});
  const ctx={location:{directory:'/project'},provider:{transform:async()=>{},get:async()=>({data:{package:'@opencode/ai/providers/openai',settings:{baseURL:'https://chatgpt.com/backend-api/codex'}}})},model:{list:async()=>({data:[]})},tool:{transform:async fn=>fn({add:()=>{}})},session:{hook:async(name,fn)=>hooks.set(name,fn),synthetic},integration:{connection:{active:async()=>({type:'credential',method:'oauth'}),resolve:async()=>({type:'oauth',methodID:'chatgpt-headless',metadata:{accountID:'same-account'}})}},event:{subscribe:()=>({async *[Symbol.asyncIterator](){}})}};
  return guard.setup(ctx).then(cleanup=>({hooks,cleanup}));
}
test('guard compaction quota failure persists and delivers one exact non-resuming parent receipt across restart',async()=>{
  const state={records:[{parentID:'root',childID:'child',admissionGeneration:4,compactionID:'msg_compact_a'}]};const notices=[];
  let h=await setup({state,synthetic:async input=>notices.push(input)});
  const event={sessionID:'child',agent:'builder',kind:'compaction',model:{providerID:'openai',id:'gpt',variant:'high'},headers:{}};
  await assert.rejects(h.hooks.get('model.request')(event),error=>error.code==='SUBSCRIPTION_QUOTA_CHECK_FAILED');h.cleanup();
  assert.equal(notices.length,1);assert.equal(notices[0].sessionID,'root');assert.equal(notices[0].resume,false);assert.equal(notices[0].metadata.generation,4);assert.equal(notices[0].metadata.compactionID,'msg_compact_a');assert.equal(state.quotaRecoveryOutbox[0].target.compactionID,'msg_compact_a');
  h=await setup({state,synthetic:async input=>notices.push(input)});await assert.rejects(h.hooks.get('model.request')(event));h.cleanup();assert.equal(notices.length,1);
});
test('rejected synthetic delivery remains pending for a later guard restart',async()=>{
  const state={records:[{parentID:'root',childID:'child',admissionGeneration:1,compactionID:'msg_compact_a'}]};
  let h=await setup({state,synthetic:async()=>{throw new Error('offline');}});await assert.rejects(h.hooks.get('model.request')({sessionID:'child',agent:'builder',kind:'compaction',model:{providerID:'openai',id:'gpt'},headers:{}}));h.cleanup();assert.equal(state.quotaRecoveryOutbox[0].deliveredAt,undefined);
  const notices=[];h=await setup({state,synthetic:async input=>notices.push(input)});await assert.rejects(h.hooks.get('model.request')({sessionID:'child',agent:'builder',kind:'compaction',model:{providerID:'openai',id:'gpt'},headers:{}}));h.cleanup();assert.equal(notices.length,1);assert.ok(state.quotaRecoveryOutbox[0].deliveredAt>=0);
});
test('file-backed registry retains a rejected notice across a guard restart',async t=>{
 const directory=await fsp.mkdtemp(path.join(os.tmpdir(),'quota-guard-restart-'));t.after(()=>fsp.rm(directory,{recursive:true,force:true}));const registry=createRegistry(directory);
 await registry('/project',async(state,save)=>{state.records=[{parentID:'root',childID:'child',admissionGeneration:2,compactionID:'msg_compact_file'}];await save();});
 const event={sessionID:'child',agent:'builder',kind:'compaction',model:{providerID:'openai',id:'gpt'},headers:{}};
 let h=await setup({state:undefined,registry,synthetic:async()=>{throw new Error('offline');}});await assert.rejects(h.hooks.get('model.request')(event));h.cleanup();
 const restartedRegistry=createRegistry(directory);await restartedRegistry('/project',async state=>assert.equal(state.quotaRecoveryOutbox.length,1));
 const notices=[];h=await setup({state:undefined,registry:restartedRegistry,synthetic:async input=>notices.push(input)});await assert.rejects(h.hooks.get('model.request')(event));h.cleanup();
 await restartedRegistry('/project',async state=>assert.ok(state.quotaRecoveryOutbox[0].deliveredAt>=0));assert.equal(notices.length,1);assert.equal(notices[0].resume,false);
});
test('full recovery outbox preserves the original quota admission failure',async()=>{
 const error=Object.assign(new Error('timeout'),{code:'SUBSCRIPTION_QUOTA_CHECK_FAILED',quota:{category:'telemetry_failure'},detail:{reason:'timeout'}});
 const state={records:[{parentID:'root',childID:'child',admissionGeneration:1,compactionID:'msg_cap'}],quotaRecoveryOutbox:Array.from({length:32},(_,n)=>quotaRecoveryReceipt({error,parentID:'root',childID:'child',generation:n+2,requestKind:'compaction',compactionID:`msg_${n}`}))};
 const h=await setup({state,synthetic:async()=>{}});await assert.rejects(h.hooks.get('model.request')({sessionID:'child',agent:'builder',kind:'compaction',model:{providerID:'openai',id:'gpt'},headers:{}}),value=>value.code==='SUBSCRIPTION_QUOTA_CHECK_FAILED');h.cleanup();assert.equal(state.quotaRecoveryOutbox.length,32);
});
