import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRegistry } from './dispatch-registry.mjs';
import { statePath } from './paths.mjs';
const id = x => typeof x === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(x);
const tool = x => typeof x === 'string' && /^[a-z][a-z0-9_.-]{0,47}$/i.test(x);
const key = (session, message, call) => JSON.stringify([session, message, call]);
export function sanitizeProgress(value) {
  if (!value || !id(value.sessionID) || !['working','blocked'].includes(value.workerProgress?.state)) return null;
  const p=value.workerProgress, phase=['reasoning','responding'].includes(p.phase)?p.phase:undefined;
  if (!Number.isFinite(p.updatedAt) || p.updatedAt<0 || p.updatedAt>8640000000000000) return null;
  const name=tool(p.tool)?p.tool:phase??'subagent', blocked=p.state==='blocked';
  return {sessionID:value.sessionID,status:'running',toolCalls:[{tool:name,status:blocked?'error':'running'}],
    summary:[{id:`worker:${value.sessionID}`,tool:name,state:{status:blocked?'error':'running',title:blocked?'Blocked':phase??'Active'}}],
    workerProgress:{state:p.state,...(phase?{phase}:{}),...(tool(p.tool)?{tool:p.tool}:{}),updatedAt:p.updatedAt}};
}
export function createProgressStore(directory=statePath('progress-snapshots')) {
  const registry=createRegistry(directory);
  return {
    async observe(event) {
      const d=event?.data??{};
      if (![d.sessionID,d.assistantMessageID,d.id].every(id)) return;
      const terminal=['session.tool.success','session.tool.failed'].includes(event.type);
      const metadata=event.type==='session.tool.progress'?sanitizeProgress(d.metadata):null;
      if (!terminal&&!metadata) return;
      const at=typeof event.created==='number'?event.created:metadata?.workerProgress.updatedAt;
      if (!Number.isFinite(at)) return;
      await registry(key(d.sessionID,d.assistantMessageID,d.id),async(s,save)=>{
        if (terminal && !s.snapshot) return;
        if (s.snapshot?.at>=at) return;
        // Existing snapshots receive terminal tombstones; REST terminal state always wins.
        if (s.snapshot?.terminal) return;
        s.snapshot={sessionID:d.sessionID,messageID:d.assistantMessageID,callID:d.id,at,terminal,...(metadata?{metadata}:{})};await save();
      });
    },
    async read(session,message,call) {
      if (![session,message,call].every(id)) return null;
      try {
        const file=path.join(directory,crypto.createHash('sha256').update(key(session,message,call)).digest('hex')+'.json');
        const stat=await fs.stat(file);if(stat.size>16384)return null;
        const s=JSON.parse(await fs.readFile(file,'utf8')).snapshot;
        if(s?.sessionID!==session||s.messageID!==message||s.callID!==call||s.terminal)return null;
        return sanitizeProgress(s.metadata);
      } catch {return null;}
    },
  };
}
export function installProgressSnapshots(ctx,{store=createProgressStore()}={}) {
  const controller=new AbortController();
  if(ctx.event?.subscribe)void(async()=>{try{for await(const e of ctx.event.subscribe({signal:controller.signal})) {
    if(controller.signal.aborted)break;
    if(e.type==='session.tool.progress'||e.type==='session.tool.success'||e.type==='session.tool.failed') {
      try{await store.observe(e);}catch{/* Display persistence must not stop work or log payloads. */}
    }
  }}catch{/* Reconnection display is best effort. */}})();
  return ()=>controller.abort();
}
// Runs only after the existing server has authorized and returned these messages.
// It never enumerates sessions or adds messages that weren't already accessible.
export async function hydrateProgress(payload,sessionID,store=createProgressStore(),now=Date.now()) {
  if(!id(sessionID))return payload;
  const messages=Array.isArray(payload?.data)?payload.data:payload?.data?[payload.data]:[];
  for(const msg of messages) {
    if(msg.type!=='assistant'||!id(msg.id))continue;
    for(const part of msg.content??[]) {
      if(part.type!=='tool'||!['running','streaming'].includes(part.state?.status)||!id(part.id))continue;
      const saved=await store.read(sessionID,msg.id,part.id);if(!saved)continue;
      if((part.state.metadata?.workerProgress?.updatedAt??0)>saved.workerProgress.updatedAt)continue;
      saved.workerProgress.restored=true;saved.workerProgress.ageMs=Math.max(0,now-saved.workerProgress.updatedAt);
      saved.summary[0].state.title=`Last observed ${new Date(saved.workerProgress.updatedAt).toISOString()}: ${saved.summary[0].state.title}`;
      part.state.metadata={...part.state.metadata,...saved};
    }
  }
  return payload;
}
