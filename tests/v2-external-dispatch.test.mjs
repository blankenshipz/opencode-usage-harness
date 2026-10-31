import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installTaskDispatch } from '../plugins/v2/task-dispatch.mjs';
import { createRegistry } from '../plugins/v2/dispatch-registry.mjs';
import { setIntent } from '../plugins/v2/task-intent.mjs';
import { canonicalExternalPath } from '../plugins/v2/external-write-grant.mjs';

const agents=JSON.parse(fs.readFileSync(new URL('./fixtures/agents.json',import.meta.url)));
const intent={outcome:'fixture',target:'fixture',nonGoals:[],authorizedEffects:['local'],assumptions:[],checks:[{id:'check',description:'fixture',mode:'local'}],sourceMessageIDs:['msg_user']};
const input=(workKey,writePaths)=>({taskId:'task',workKey,operation:'implement',agent:'builder',description:'fixture',prompt:'make fixture change',requiredCapabilities:['edit','shell'],intentRevision:1,checkIds:['check'],background:true,writePaths});

async function setup(t) {
 const base=await fsp.mkdtemp(path.join(os.tmpdir(),'external-dispatch-'));t.after(()=>fsp.rm(base,{recursive:true,force:true}));
 const source=path.join(base,'source'),destination=path.join(base,'destination'),config=path.join(base,'config');await Promise.all([fsp.mkdir(source),fsp.mkdir(destination),fsp.mkdir(config)]);
 const sessions=[];const globalRegistry=createRegistry(path.join(base,'global'));
 const install=async (directory,rootID) => {
  sessions.push({id:rootID,agent:'router',directory,active:false});const tools=new Map(), calls=[];
  let nativeFailure;
  const native={name:'subagent',description:'native',input:{type:'object',properties:{agent:{},description:{},prompt:{},sessionID:{},background:{}},required:['agent','description','prompt']},execute:async(args,context)=>{
   calls.push(args);if(nativeFailure) throw nativeFailure;const id=args.sessionID ?? `${rootID}-child`;let child=sessions.find(s=>s.id===id);if(!child){child={id,parentID:context.sessionID,agent:args.agent,directory,active:true};sessions.push(child);} child.active=true;
   await context.progress({sessionID:id,status:'running'});return {content:'ok',metadata:{sessionID:id,status:'running'},output:{sessionID:id,status:'running'}};
  }};tools.set('subagent',native);
  const ctx={location:{directory},agent:{list:async()=>({data:Object.entries(agents).map(([id,value])=>({id,...value}))})},tool:{transform:async fn=>fn({get:n=>tools.get(n),update:(n,fn)=>fn(tools.get(n)),add:item=>tools.set(item.name,item)})},session:{hook:async()=>{}}};
  const registry=createRegistry(path.join(base,`${rootID}-registry`));await registry(directory,async(state,save)=>{setIntent(state,{rootID,taskId:'task',intent,expectedRevision:0,actorSessionID:rootID});await save();});
  await installTaskDispatch(ctx,{registry,globalRegistry,loadSessions:async()=>sessions,loadSources:async()=>['msg_user'],loadRoutingPolicy:()=>undefined,grantPath:path.join(config,'external-write-grants.json'),configRoot:config});
  return {directory,rootID,tools,calls,registry,failNative:error=>{nativeFailure=error;},call:args=>tools.get('task_dispatch').execute(args,{sessionID:rootID,agent:'router',progress:async()=>{}})};
 };
 const sourceHarness=await install(source,'source-root'), destinationHarness=await install(destination,'destination-root');
 const grant=async ({childID,revoked=false})=>{const doc={version:1,grants:[{version:1,grantID:'migration-grant',workspace:await canonicalExternalPath(source),rootID:'source-root',parentID:'source-root',childID,taskId:'task',workKey:'source',intentRevision:1,checkIds:['check'],agent:'builder',operation:'implement',externalRoot:await canonicalExternalPath(destination),expiresAt:'2099-01-01T00:00:00.000Z',revoked}]};const file=path.join(config,'external-write-grants.json');await fsp.writeFile(file,JSON.stringify(doc),{mode:0o600});await fsp.chmod(file,0o600);};
 return {source,destination,sessions,globalRegistry,sourceHarness,destinationHarness,grant};
}

test('an exact existing-child grant admits an external write and a revoked retained path is denied before native',async t=>{
 const h=await setup(t);const initial=await h.sourceHarness.call(input('source',['local']));const childID=initial.metadata.sessionID;await h.grant({childID});
 await h.sourceHarness.call({...input('source',[path.join(h.destination,'migrated')]),sessionID:childID,externalWriteGrantID:'migration-grant'});
 await h.sourceHarness.registry(h.source,async state=>{assert.equal(state.records[0].externalGrant.grantID,'migration-grant');assert.deepEqual(state.records[0].externalWrites,[await canonicalExternalPath(path.join(h.destination,'migrated'))]);});
 const calls=h.sourceHarness.calls.length;await h.grant({childID,revoked:true});
 await assert.rejects(h.sourceHarness.call({...input('source',undefined),sessionID:childID}),/revoked/);assert.equal(h.sourceHarness.calls.length,calls);
});
test('an absolute external path has no default admission',async t=>{
 const h=await setup(t);await assert.rejects(h.sourceHarness.call(input('source',[path.join(h.destination,'no-grant')])),/require an operator external write grant/);assert.equal(h.sourceHarness.calls.length,0);
});
test('an external-only continuation retains its empty local scope when writePaths is omitted',async t=>{
 const h=await setup(t);const initial=await h.sourceHarness.call(input('source',['local']));const childID=initial.metadata.sessionID;await h.grant({childID});
 await h.sourceHarness.call({...input('source',[path.join(h.destination,'external-only')]),sessionID:childID,externalWriteGrantID:'migration-grant'});
 await h.sourceHarness.call({...input('source',undefined),sessionID:childID});
 await h.sourceHarness.registry(h.source,async state=>assert.deepEqual(state.records[0].writePaths,[]));
});
test('an active untracked destination session blocks an external grant',async t=>{
 const h=await setup(t);const initial=await h.sourceHarness.call(input('source',['local']));const childID=initial.metadata.sessionID;await h.grant({childID});
 h.sessions.push({id:'pre-upgrade-destination',parentID:'foreign-root',agent:'builder',directory:h.destination,active:true});
 await assert.rejects(h.sourceHarness.call({...input('source',[path.join(h.destination,'blocked')]),sessionID:childID,externalWriteGrantID:'migration-grant'}),/untracked|pre-upgrade|destination/);
});
test('a native denial before child identity releases the global lease for unrelated same-path work',async t=>{
 const h=await setup(t);const initial=await h.sourceHarness.call(input('source',['local']));const childID=initial.metadata.sessionID;await h.grant({childID});
 h.destinationHarness.failNative(new Error('Subagent denied: fixture'));
 await assert.rejects(h.destinationHarness.call(input('destination',['released'])),/Subagent denied/);
 await h.sourceHarness.call({...input('source',[path.join(h.destination,'released')]),sessionID:childID,externalWriteGrantID:'migration-grant'});
});
async function interruptedAdmission(h, { foreignOwner=false }={}) {
 const token='dead-admission-token', key='source-root\0task\0source', childID='recovered-child';
 h.sessions.push({id:childID,parentID:'source-root',agent:'builder',title:'fixture',created:1,directory:h.source,active:true});
 await h.sourceHarness.registry(h.source,async(state,save)=>{
  state.records.push({key,rootID:'source-root',parentID:'source-root',taskId:'task',workKey:'source',agent:'builder',description:'fixture',intentRevision:1,checkIds:['check'],writePaths:[],inFlight:token,ownerPid:999999999,state:'starting',startedAt:0});
  if(foreignOwner) state.records.push({key:'foreign-owner',rootID:'source-root',parentID:'source-root',taskId:'other',workKey:'other',agent:'builder',childID,state:'running'});
  await save();
 });
 const workspace=await canonicalExternalPath(h.source);
 await h.globalRegistry('all-writers',async(state,save)=>{state.leases=[{token,key,workspace,parentID:'source-root',childID:undefined,paths:[workspace],inFlight:true,ownerPid:999999999}];await save();});
 return {token,key,childID};
}
test('a dead childless admission binds its matching active recovered child to the old lease before existing return',async t=>{
 const h=await setup(t);const prior=await interruptedAdmission(h);
 const result=await h.sourceHarness.call(input('source',[]));assert.equal(result.metadata.sessionID,prior.childID);assert.equal(result.metadata.status,'running');
 await h.globalRegistry('all-writers',async state=>{const lease=state.leases.find(item=>item.token===prior.token);assert.equal(lease.childID,prior.childID);});
});
test('a candidate already owned by another record rejects without reassigning the old lease',async t=>{
 const h=await setup(t);const prior=await interruptedAdmission(h,{foreignOwner:true});
 await assert.rejects(h.sourceHarness.call(input('source',[])),/interrupted child identity does not match/);
 await h.globalRegistry('all-writers',async state=>{const lease=state.leases.find(item=>item.token===prior.token);assert.equal(lease.childID,undefined);});
});
for (const order of ['source-first','destination-first']) test(`global writer admission serializes destination and granted source (${order})`,async t=>{
 const h=await setup(t);const initial=await h.sourceHarness.call(input('source',['local']));const childID=initial.metadata.sessionID;await h.grant({childID});
 const sourceCall=()=>h.sourceHarness.call({...input('source',[path.join(h.destination,'shared')]),sessionID:childID,externalWriteGrantID:'migration-grant'});
 const destinationCall=()=>h.destinationHarness.call(input('destination',['shared']));
 const first=order==='source-first'?sourceCall:destinationCall, second=order==='source-first'?destinationCall:sourceCall;
 const results=await Promise.allSettled([first(),second()]);
 assert.equal(results.filter(result=>result.status==='fulfilled').length,1);const denied=results.find(result=>result.status==='rejected');assert.match(denied.reason.message,/global overlapping writer lease/);
 // Repeating the admitted source owner is a continuity operation, not a
 // cross-owner collision.
 if(order==='source-first') await h.sourceHarness.call({...input('source',undefined),sessionID:childID});
});
