import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createProgressStore,hydrateProgress} from '../plugins/v2/progress-snapshots.mjs';
const event=(at=10)=>({type:'session.tool.progress',created:at,data:{sessionID:'ses_parent',assistantMessageID:'msg_a',id:'call_a',metadata:{sessionID:'ses_older_child',raw:'SECRET',workerProgress:{state:'working',phase:'reasoning',updatedAt:at,raw:'SECRET'}}}});
const payload=(status='running')=>({data:[{id:'msg_a',type:'assistant',content:[{type:'tool',id:'call_a',state:{status,metadata:{}}}]}]});
test('progress reconnect restores exact older child mapping, only sanitized metadata',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'progress-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 await createProgressStore(dir).observe(event());const store=createProgressStore(dir);
 const body=await hydrateProgress(payload(),'ses_parent',store,100);
 assert.equal(body.data[0].content[0].state.metadata.sessionID,'ses_older_child');
 assert.equal(body.data[0].content[0].state.metadata.workerProgress.ageMs,90);
 assert.equal(JSON.stringify(body).includes('SECRET'),false);
 assert.deepEqual(await hydrateProgress(payload(),'ses_other',store),payload());
 assert.deepEqual(await hydrateProgress(payload('completed'),'ses_parent',store),payload('completed'));
 await store.observe({...event(20),type:'session.tool.success'});await store.observe(event(19));
 assert.equal(await store.read('ses_parent','msg_a','call_a'),null);
});
test('out of order observations do not replace newer state; corrupt snapshots fail open for display',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'progress-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const store=createProgressStore(dir);
 await Promise.all([store.observe(event(20)),store.observe(event(10))]);assert.equal((await store.read('ses_parent','msg_a','call_a')).workerProgress.updatedAt,20);
 for(const file of await fs.readdir(dir))if(file.endsWith('.json'))await fs.writeFile(path.join(dir,file),'bad');
 assert.deepEqual(await hydrateProgress(payload(),'ses_parent',store),payload());
});
