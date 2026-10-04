import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createMilestoneStore,summarizeCheckpoint,overlayMilestones,milestoneSse,installMilestoneSignals} from '../plugins/v2/milestones.mjs';
const record=(status='passed')=>({scope:'checkpoint',sessionId:'ses_child',taskId:'release',status:status==='blocked'?'blocked':'completed',results:[{id:'installed-journey',status,evidence:'SECRET source payload'}],validationEvidence:['SECRET'],blocker:status==='blocked'?{kind:'environment',evidence:'SECRET',nextAction:'SECRET'}:undefined});
async function harness(t){let at=1000000;const directory=await fs.mkdtemp(path.join(os.tmpdir(),'milestones-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));const options={directory,now:()=>at,loadSessions:async()=>[{id:'ses_root',directory:'/project'},{id:'ses_child',parentID:'ses_root',agent:'builder'}]};return{store:createMilestoneStore(options),options,tick:n=>{at+=n;}};}
test('reports coalesce to five minutes, deduplicate and persist across reload',async t=>{
 const h=await harness(t);await h.store.record(record());assert.equal((await h.store.list('ses_root')).length,1);
 h.tick(1000);await h.store.record(record());assert.equal((await h.store.list('ses_root')).length,1);
 const next=record();next.results[0].id='review';await h.store.record(next);assert.equal((await h.store.list('ses_root')).length,1);
 h.tick(299000);const notes=await createMilestoneStore(h.options).list('ses_root');assert.equal(notes.length,2);assert.match(notes[1].text,/review: passed/);assert.equal(JSON.stringify(notes).includes('SECRET'),false);
 h.tick(900000);assert.equal((await h.store.list('ses_root')).length,2);
});
test('blockers publish sooner with a one-minute floor and no root self-echo',async t=>{
 const h=await harness(t);await h.store.record(record());h.tick(60000);await h.store.record(record('blocked'));assert.equal((await h.store.list('ses_root')).length,2);
 h.tick(1000);await h.store.record(record('blocked'));assert.equal((await h.store.list('ses_root')).length,2);
 await h.store.record({...record(),sessionId:'ses_root'});assert.equal((await h.store.list('ses_root')).length,2);
});
test('REST pagination/filter scope and SSE directory filtering preserve isolation',async t=>{
 const h=await harness(t);await h.store.record(record());
 const payload={data:[],cursor:{next:'native'}};assert.equal((await overlayMilestones(payload,'ses_root',h.store,{cursor:true})).data.length,0);
 assert.equal((await overlayMilestones({data:[]},'ses_other',h.store)).data.length,0);
 assert.equal((await overlayMilestones({data:[]},'ses_root',h.store)).data.length,1);
 assert.equal((await h.store.feed(0,'/other')).length,0);const events=await h.store.feed(0,'/project');assert.equal(events.length,1);assert.match(milestoneSse(events[0]),/harness.milestone/);assert.equal(milestoneSse(events[0]).includes('SECRET'),false);
});
test('ordinary in-progress bookkeeping does not generate heartbeat notes',()=>{
 assert.equal(summarizeCheckpoint({...record(),results:[],status:'in_progress'},'builder'),null);
 assert.equal(summarizeCheckpoint({...record(),scope:'task'},'router'),null);
});

test('native form envelope and permission signals stay sanitized; deletion clears notices',async t=>{
 const h=await harness(t);const records=[];let done;
 const finished=new Promise(resolve=>{done=resolve;});
 const stop=installMilestoneSignals({event:{async *subscribe(){
  yield {type:'form.created',id:'evt_form',data:{form:{sessionID:'ses_child',title:'SECRET'}}};
  yield {type:'permission.asked',id:'evt_permission',data:{sessionID:'ses_child',patterns:['SECRET']}};
  done();
 }}},{record:async r=>{records.push(r);},remove:async()=>{}});
 await finished;stop();assert.equal(records.length,2);assert.equal(records[0].sessionId,'ses_child');assert.equal(JSON.stringify(records).includes('SECRET'),false);
 await h.store.record(record());await h.store.remove('ses_root');assert.deepEqual(await h.store.list('ses_root'),[]);assert.deepEqual(await h.store.feed(0),[]);
});
