import test from 'node:test';
import assert from 'node:assert/strict';
import {createCacheDriftObserver,installCacheDrift,createCacheDriftSink} from '../plugins/v2/cache-drift.mjs';
const event=()=>({sessionID:'session',agent:'worker',model:{providerID:'any-family',id:'a'},system:[{type:'text',text:'private instructions'}],tools:{read:{description:'read',input:{type:'object'}}},messages:[{role:'user',content:[{type:'text',text:'private question'}]},{role:'assistant',content:[{type:'text',text:'last still growing'}]}]});
test('append growth stays stable; prior content and configuration changes are distinguished',()=>{
 const o=createCacheDriftObserver();const e=event();assert.equal(o.observe(e).reason,'baseline');
 e.messages.at(-1).content[0].text+=' ongoing';assert.equal(o.observe(e).reason,'stable');
 e.messages.push({role:'user',content:[{type:'text',text:'next'}]});assert.equal(o.observe(e).reason,'stable');
 e.system[0].text+='changed';assert.deepEqual(o.observe(e).dimensions,['system']);
 e.tools.read.input={type:'string'};assert.deepEqual(o.observe(e).dimensions,['tools']);
 e.messages[0].content[0].text='edited';assert.deepEqual(o.observe(e).dimensions,['early_messages']);
});
test('routes, compaction attempts, shortening and bounded eviction reset baselines',()=>{
 const o=createCacheDriftObserver({capacity:1}),e=event();o.observe(e);e.model.id='b';assert.equal(o.observe(e).reason,'route_changed');
 o.compaction(e);assert.equal(o.observe(e).reason,'compaction_boundary');e.messages.pop();assert.equal(o.observe(e).reason,'history_shortened');
 o.observe({...event(),sessionID:'other'});assert.equal(o.observe(e).reason,'baseline');
});
test('cache metadata ignored, opaque payload metadata preserved, no fingerprints/content emitted',()=>{
 const o=createCacheDriftObserver(),e=event();o.observe(e);e.system[0].cache={type:'ephemeral'};assert.equal(o.observe(e).reason,'stable');
 e.messages[0].content[0].metadata={changing:true};const result=o.observe(e);assert.equal(result.reason,'stable');
 assert.ok(!JSON.stringify(result).includes('private'));assert.deepEqual(Object.keys(result).sort(),['created_ms','dimensions','processing_ms','reason','session_id','type','version']);
});
test('installed hooks preserve frozen request identity and swallow observer failures',async()=>{
 const hooks={},records=[];const stop=await installCacheDrift({session:{hook:async(n,f)=>{hooks[n]=f;}}},{sink:{emit:r=>records.push(r)}});
 const e=event(),before=JSON.stringify(e);Object.freeze(e);hooks.context(e);assert.equal(JSON.stringify(e),before);assert.equal(records[0].reason,'baseline');stop();
 await installCacheDrift({session:{hook:async(n,f)=>{hooks[n]=f;}}},{observer:{observe(){throw Error('fail');},compaction(){throw Error('fail');},clear(){}},sink:{emit(){throw Error('write');}}});assert.doesNotThrow(()=>hooks.context(e));assert.doesNotThrow(()=>hooks.compaction(e));
});
test('oversized context returns unavailable without modifying context',()=>{
 const e=event();e.system[0].text='x'.repeat(3*1024*1024);assert.equal(createCacheDriftObserver().observe(e).reason,'observation_unavailable');assert.equal(e.system[0].text.length,3*1024*1024);
});
test('failed telemetry storage does not reject or retain unlimited queued work',async()=>{
 const sink=createCacheDriftSink('/unused',{io:{mkdir:async()=>{throw Error('offline');}}});for(let i=0;i<300;i++)sink.emit({reason:'stable'});await assert.doesNotReject(sink.flush());sink.stop();
});
test('native optional fields do not disable observation; tool payload fields remain meaningful',()=>{
 const o=createCacheDriftObserver(),e=event();
 e.messages[0].content=[{type:'tool-call',providerExecuted:undefined,input:{metadata:{value:1}}}];
 assert.equal(o.observe(e).reason,'baseline');delete e.messages[0].content[0].providerExecuted;assert.equal(o.observe(e).reason,'stable');
 e.messages[0].content[0].input.metadata.value=2;assert.deepEqual(o.observe(e).dimensions,['early_messages']);
});
test('telemetry rotates with bounded retention and continues observing',async t=>{
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cache-observer-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'events.jsonl'),sink=createCacheDriftSink(file,{maxBytes:1});
 sink.emit({reason:'first'});await sink.flush();sink.emit({reason:'second'});await sink.flush();sink.emit({reason:'third'});await sink.flush();sink.stop();
 assert.equal(JSON.parse((await fs.readFile(file,'utf8')).trim()).reason,'third');assert.equal(JSON.parse((await fs.readFile(file+'.1','utf8')).trim()).reason,'second');
 assert.equal((await fs.stat(file)).mode & 0o777,0o600);
});
