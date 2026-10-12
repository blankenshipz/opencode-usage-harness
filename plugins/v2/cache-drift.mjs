// Passive shared-context fingerprints, inspired by Headroom's drift detector.
// No request rewriting, provider auth access, wire interception or inference.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { statePath } from './paths.mjs';
const validID = x => typeof x === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(x);

function canonical(value, budget = { remaining: 2 * 1024 * 1024, nodes: 50000 }, depth = 0) {
  if (--budget.nodes < 0 || depth > 64) throw Error('observer budget');
  if (value === null || ['string','number','boolean'].includes(typeof value)) {
    const out = JSON.stringify(value); budget.remaining -= out.length;
    if (budget.remaining < 0) throw Error('observer budget'); return out;
  }
  if (Array.isArray(value)) return '['+value.map(x=>canonical(x === undefined ? null : x,budget,depth+1)).join(',')+']';
  if (!value || typeof value !== 'object') throw Error('unsupported context');
  return '{'+Object.keys(value).filter(k=>value[k] !== undefined).sort().map(k=>canonical(k,budget,depth+1)+':'+canonical(value[k],budget,depth+1)).join(',')+'}';
}
function visiblePart(part) {
  if (!part || typeof part !== 'object') return part;
  const { cache, metadata, providerMetadata, providerState, ...visible } = part;
  return visible; // Do not strip similarly named keys inside opaque tool data.
}
export function createCacheDriftObserver({ capacity = 128, now = Date.now } = {}) {
  const states = new Map(), compactions = new Set(), secret = crypto.randomBytes(32);
  const hash = value => crypto.createHmac('sha256', secret).update(canonical(value)).digest('hex');
  const compaction = event => {
    if (!validID(event.sessionID)) return;
    if (compactions.size >= capacity) compactions.delete(compactions.values().next().value);
    compactions.add(event.sessionID);
  };
  const observe = event => {
    if (!validID(event.sessionID)) return;
    const started = performance.now(), session_id = event.sessionID;
    const record = { version:1, session_id, created_ms:now(), type:'context_observation' };
    try {
      if (!Array.isArray(event.system) || !Array.isArray(event.messages) || !event.tools || !event.model) throw Error('unsupported context');
      const route = hash([event.agent ?? null,event.model.providerID ?? null,event.model.id ?? null,event.model.variant ?? null]);
      const system = hash(event.system.map(visiblePart));
      // Preserve tool array order, while normalizing object-key order in schemas.
      const tools = hash(Object.entries(event.tools));
      const early = event.messages.slice(0,Math.min(3,Math.max(0,event.messages.length-1)))
        .map(m=>hash({role:m.role,content:Array.isArray(m.content)?m.content.map(visiblePart):m.content}));
      const current = { route, system, tools, early, length:event.messages.length };
      const previous = states.get(session_id); let reason='baseline',dimensions=[];
      if (compactions.delete(session_id)) reason='compaction_boundary';
      else if (previous?.route !== undefined && previous.route !== route) reason='route_changed';
      else if (previous && current.length < previous.length) reason='history_shortened';
      else if (previous) {
        if (previous.system !== system) dimensions.push('system');
        if (previous.tools !== tools) dimensions.push('tools');
        if (previous.early.some((v,i)=>early[i] !== v)) dimensions.push('early_messages');
        reason=dimensions.length?'drift_observed':'stable';
      }
      states.delete(session_id); states.set(session_id,current);
      while(states.size>capacity)states.delete(states.keys().next().value);
      return {...record,reason,dimensions,processing_ms:performance.now()-started};
    } catch { return {...record,reason:'observation_unavailable',dimensions:[],processing_ms:performance.now()-started}; }
  };
  return { observe, compaction, clear:()=>{states.clear();compactions.clear();} };
}

// Bounded best-effort queue. A full/unavailable sink never stalls model admission.
export function createCacheDriftSink(file = statePath('telemetry','cache-drift.jsonl'), { io=fs, maxBytes=16*1024*1024 }={}) {
  let queue=[], timer, draining, stopped=false, dropped=0;
  const flush = () => {
    if(draining)return draining;
    if(!queue.length)return Promise.resolve();
    const batch=queue.splice(0,64), lost=dropped; dropped=0;
    if(lost)batch[0]={...batch[0],observer_dropped:lost};
    draining=(async()=>{try{
      await io.mkdir(path.dirname(file),{recursive:true,mode:0o700});
      let stat;try{stat=await io.lstat(file);}catch(e){if(e.code!=='ENOENT')throw e;}
      if(stat?.isSymbolicLink())throw Error('sink unavailable');
      if((stat?.size??0)>=maxBytes)await io.rename(file,file+'.1');
      await io.appendFile(file,batch.map(x=>JSON.stringify(x)).join('\n')+'\n',{mode:0o600});
      await io.chmod(file,0o600);
    }catch{dropped+=batch.length+lost;}finally{draining=undefined;if(queue.length&&!stopped)schedule();}})();
    return draining;
  };
  const schedule=()=>{if(!timer){timer=setTimeout(()=>{timer=undefined;void flush();},25);timer.unref?.();}};
  return { emit(record){if(stopped||!record)return;if(queue.length>=256){dropped++;return;}queue.push(record);schedule();},flush,
    stop(){stopped=true;clearTimeout(timer);timer=undefined;void flush();} };
}
export async function installCacheDrift(ctx, { observer=createCacheDriftObserver(), sink=createCacheDriftSink() }={}) {
  if(typeof ctx.session?.hook!=='function')return ()=>{};
  let stopped=false;
  await ctx.session.hook('context',event=>{
    if(stopped)return;
    try{sink.emit(observer.observe(event));}catch{/* Observer errors never affect inference. */}
  });
  await ctx.session.hook('compaction',event=>{if(!stopped)try{observer.compaction(event);}catch{}});
  return ()=>{stopped=true;observer.clear();sink.stop?.();};
}
