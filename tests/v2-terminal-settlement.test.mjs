import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTerminalSettler } from '../plugins/v2/terminal-settlement.mjs';
import { setIntent } from '../plugins/v2/task-intent.mjs';

test('partial global release retries preserve one settlement, denial and unrelated leases',async()=>{
 const record={key:'root\0task\0work',rootID:'root',taskId:'task',workKey:'work',parentID:'root',childID:'child',agent:'builder',state:'denied',admissionGeneration:1,intentRevision:1,denial:{category:'native_permission'},routing:{selected:'openai/model#medium'},completionBinding:{generation:1,background:true,marker:'marker',promptHash:'hash',prefixedPromptHash:'prefixed'}};
 let local={records:[record]},global={leases:[{workspace:'/project',key:record.key,parentID:'root',childID:'child'},{workspace:'/other',key:'foreign',childID:'other'}]};
 const intent={outcome:'Stop old work',target:'project',nonGoals:[],authorizedEffects:[],assumptions:[],checks:[{id:'check',description:'Verify corrected task',mode:'local'}],sourceMessageIDs:['msg_user']};
 setIntent(local,{rootID:'root',taskId:'task',intent,expectedRevision:0,actorSessionID:'root'});
 setIntent(local,{rootID:'root',taskId:'task',intent:{...intent,outcome:'Corrected task'},expectedRevision:1,actorSessionID:'root'});
 let fail=true;
 const registry=async(_,fn)=>{const copy=structuredClone(local);return fn(copy,async()=>{local=structuredClone(copy);});};
 const globalRegistry=async(_,fn)=>{const copy=structuredClone(global);return fn(copy,async()=>{if(fail){fail=false;throw new Error('simulated durable save failure');}global=structuredClone(copy);});};
 const sessions=[{id:'root'},{id:'child',parentID:'root',active:false,agent:'builder',model:'openai/model#medium'}];
 const settle=createTerminalSettler({registry,globalRegistry,workspace:'/project',canonicalWorkspace:async()=>'/project',loadSessions:async()=>sessions,loadTerminalReceipt:async()=>({outcome:'failed',promptID:'prompt',idleID:'idle',idleSeq:2}),now:()=>123});
 const input={taskId:'task',workKey:'work',sessionID:'child',generation:1},context={sessionID:'root'};
 await assert.rejects(settle(input,context),/durable save failure/);
 assert.equal(local.records[0].state,'settled');assert.equal(local.records[0].terminalHistory.length,1);assert.equal(global.leases.length,2);
 const result=JSON.parse((await settle(input,context)).content);
 assert.equal(result.acceptedForCurrentIntent,false);assert.equal(result.inferenceStarted,false);
 assert.equal(local.records[0].terminalHistory.length,1);assert.deepEqual(local.records[0].denial,{category:'native_permission'});
 assert.deepEqual(global.leases,[{workspace:'/other',key:'foreign',childID:'other'}]);
});
