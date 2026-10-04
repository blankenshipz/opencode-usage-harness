import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRegistry, runtimeSessions, lineage } from './dispatch-registry.mjs';
import { statePath } from './paths.mjs';
const validID=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(x);
const label=x=>typeof x==='string'&&/^[a-z][a-z0-9-]{0,63}$/.test(x)&&!/^sk-/.test(x)?x:'check';
const digest=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const roles=new Set(['router','coordinator','builder','builder-high','quick-builder','scout','reviewer','architect','deep-debugger','deep-debugger-high','maximum','maximum-max']);
const kinds=new Set(['authorization','tool_permission','environment','credential','implementation']);
export function summarizeCheckpoint(record,actor) {
  if(record.scope!=='checkpoint'||!validID(record.sessionId))return null;
  const checks=(record.results??[]).filter(x=>['passed','failed','blocked'].includes(x.status)).map(x=>({id:label(x.id),status:x.status})).slice(0,12).sort((a,b)=>a.id.localeCompare(b.id));
  if(!checks.length&&!['completed','blocked','failed'].includes(record.status))return null;
  const role=roles.has(actor)?actor:'worker', blocker=kinds.has(record.blocker?.kind)?record.blocker.kind:null;
  const urgent=record.status==='blocked'||record.status==='failed'||!!blocker;
  const status=['completed','blocked','failed','in_progress'].includes(record.status)?record.status:'in_progress';
  const parts=checks.slice(0,4).map(x=>`${x.id}: ${x.status}`);
  if(checks.length>4)parts.push(`${checks.length-4} more checks reported`);
  if(blocker)parts.push(`blocker: ${blocker.replace('_',' ')}`);
  return {workerID:record.sessionId,task:label(record.taskId),urgent,signature:digest([record.sessionId,record.taskId,status,checks,blocker,record.notificationKey??null,(record.results??[]).map(x=>x.artifact??null)]),text:`${role} — ${parts.join('; ')||`checkpoint ${status}`}.`};
}
export function createMilestoneStore({directory=statePath('milestones'),loadSessions=runtimeSessions,now=()=>Date.now(),interval=300000,urgentInterval=60000}={}) {
 const registry=createRegistry(directory);
 const flush=(s,at)=>{
  const pending=Object.values(s.pending??{});if(!pending.length)return false;
  const urgent=pending.some(x=>x.urgent);
  if(at-(s.lastPublished??0)<(urgent?urgentInterval:interval))return false;
  const latest=pending.sort((a,b)=>a.observedAt-b.observedAt).slice(-4);
  const text=latest.map(x=>x.text).join('\n')+(pending.length>4?`\n${pending.length-4} additional worker checkpoints recorded.`:'');
  const msg={id:`msg_harness_${digest([s.rootID,at,latest.map(x=>x.signature)]).slice(0,28)}`,type:'synthetic',time:{created:at},description:'Worker-reported update',metadata:{source:'harness-milestone',selfReported:true,workerID:latest.at(-1).workerID},text};
  s.messages=[...(s.messages??[]),msg].slice(-40);s.pending={};s.lastPublished=at;return true;
 };
 return {
  async record(record) {
   const sessions=await loadSessions(),actor=sessions.find(x=>x.id===record.sessionId);if(!actor)return;
   const rootID=lineage(sessions,actor.id);if(rootID===actor.id)return;
   const item=summarizeCheckpoint(record,actor.agent);if(!item)return;
   await registry(rootID,async(s,save)=>{
    s.rootID=rootID;s.directory=sessions.find(x=>x.id===rootID)?.directory;
    const key=digest([item.workerID,item.task]);s.seen??={};if(s.seen[key]===item.signature)return;
    s.seen[key]=item.signature;const keys=Object.keys(s.seen);for(const k of keys.slice(0,Math.max(0,keys.length-256)))delete s.seen[k];
    s.pending??={};s.pending[key]={...item,observedAt:now()};const pending=Object.keys(s.pending);for(const k of pending.slice(0,Math.max(0,pending.length-64)))delete s.pending[k];
    flush(s,now());await save();
   });
  },
  async remove(rootID) {
   if(!validID(rootID))return;
   await registry(rootID,async(s,save)=>{s.messages=[];s.pending={};s.seen={};delete s.rootID;await save();});
  },
  async list(rootID) {
   if(!validID(rootID))return [];
   // Avoid creating empty files/directories on ordinary message requests.
   const filename=path.join(directory,crypto.createHash('sha256').update(rootID).digest('hex')+'.json');
   try{await fs.access(filename);}catch{return [];}
   return registry(rootID,async(s,save)=>{if(s.rootID!==rootID)return [];if(flush(s,now()))await save();return s.messages??[];});
  },
  async feed(since,directoryFilter=null) {
   let files;try{files=(await fs.readdir(directory)).filter(x=>x.endsWith('.json')).slice(0,1000);}catch{return [];}
   const out=[];
   for(const file of files){try{
    const full=path.join(directory,file);if((await fs.stat(full)).size>262144)continue;
    const s=JSON.parse(await fs.readFile(full,'utf8'));if(!validID(s.rootID)||typeof s.directory!=='string'||(directoryFilter&&s.directory!==directoryFilter))continue;
    for(const message of await this.list(s.rootID))if(message.time.created>=since)out.push({sessionID:s.rootID,directory:s.directory,message});
   }catch{/* One bad record must not stop status delivery. */}}
   return out;
  },
 };
}
// Pagination cursors remain OpenCode-owned. Overlay only the newest unfiltered page.
export async function overlayMilestones(payload,sessionID,store,{cursor=false,order='desc',filtered=false}={}) {
 if(cursor||filtered||order!=='desc'||!Array.isArray(payload?.data))return payload;
 const notes=await store.list(sessionID);if(!notes.length)return payload;
 const ids=new Set(payload.data.map(x=>x.id));payload.data.push(...notes.filter(x=>!ids.has(x.id)));
 payload.data.sort((a,b)=>b.time.created-a.time.created);return payload;
}
export function milestoneSse(item) {
 return `data: ${JSON.stringify({directory:item.directory,payload:{id:item.message.id.replace(/^msg_/,'evt_'),type:'harness.milestone',created:item.message.time.created,data:{sessionID:item.sessionID,message:item.message}}})}\n\n`;
}

export function installMilestoneSignals(ctx,store) {
 const controller=new AbortController();
 if(ctx.event?.subscribe)void(async()=>{try{for await(const event of ctx.event.subscribe({signal:controller.signal})){
  if(controller.signal.aborted)break;
  try {
   if(event.type==='session.deleted')await store.remove(event.data.sessionID);
   if(event.type==='permission.asked'||event.type==='form.created')await store.record({
    scope:'checkpoint',sessionId:event.type==='form.created'?event.data.form?.sessionID:event.data.sessionID,taskId:'input-request',status:'blocked',notificationKey:event.id,
    blocker:{kind:event.type==='permission.asked'?'tool_permission':'authorization'},results:[],
   });
  }catch{/* No event contents logged or reflected. */}
 }}catch{/* Status stream is best effort. */}})();
 return ()=>controller.abort();
}
