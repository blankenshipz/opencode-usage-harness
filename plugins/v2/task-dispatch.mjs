import path from 'node:path';
import crypto from 'node:crypto';
import { createRegistry, runtimeSessions, runtimeIntentSources, lineage, descendant, overlaps } from './dispatch-registry.mjs';
import { intentSchema, getIntent, setIntent, bindIntent, renderIntent, renderIntentReference } from './task-intent.mjs';
import { packageRoot } from './paths.mjs';
import { createWorkerProgress } from './worker-progress.mjs';
import { admissionDenial, denialAdvice, receipt, suppression } from './denial-recovery.mjs';
// Eligibility is not a permission grant: the native executor still owns authorization and depth.
export function hasCapability(agent, capability) {
  const rules = agent.permissions ?? [], action = capability === 'delegate' ? 'subagent' : capability;
  const match = (pattern, value) => new RegExp(`^${pattern.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(value);
  const effect = resource => {
    let result = 'ask';
    for (const rule of rules) if (match(rule.action, action) && match(rule.resource, resource)) result = rule.effect;
    return result;
  };
  return capability === 'delegate' ? rules.some(r => r.action === action && r.resource !== '*' && effect(r.resource) !== 'deny') || effect('*') !== 'deny' : effect('*') !== 'deny';
}
const string = (value, name) => { if (typeof value !== 'string' || !value.trim() || value.length > 160 || /[\r\n\0]/.test(value)) throw new Error(`task-dispatch: valid ${name} is required`); return value; };
const operations = ['inspect', 'implement', 'deploy', 'coordinate'];
function recovery(sessions, workerID, callerID, records) {
  const worker = sessions.find(s => s.id === workerID);
  let direct = worker; const seen = new Set();
  while (direct && direct.parentID !== callerID && !seen.has(direct.id)) { seen.add(direct.id); direct = sessions.find(s => s.id === direct.parentID); }
  const owner = direct && records.find(r => r.childID === direct.id);
  return { workerID, parentID: worker?.parentID, action: direct ? 'resume_direct_child' : 'wait_for_other_parent',
    ...(direct ? { sessionID: direct.id, agent: direct.agent, ...(owner ? { taskId: owner.taskId, workKey: owner.workKey } : {}) } : {}),
    advice: direct ? 'Continue this direct child and ask it to coordinate the authorized follow-up after its active writers finish. Preserve ownership IDs when supplied.' : 'The owner is outside this child tree. Wait and recheck status; do not attempt cross-parent adoption.' };
}

const schema = { type: 'object', additionalProperties: false, properties: {
  taskId: { type: 'string', minLength: 1, maxLength: 160 }, workKey: { type: 'string', minLength: 1, maxLength: 160 },
  operation: { type: 'string', enum: operations },
  intentRevision: {type:'integer',minimum:1}, checkIds:{type:'array',minItems:1,maxItems:12,uniqueItems:true,items:{type:'string'}},
  agent: { type: 'string', minLength: 1 }, description: { type: 'string', minLength: 1 }, prompt: { type: 'string', minLength: 1 },
  requiredCapabilities: { type: 'array', uniqueItems: true, items: { type: 'string', enum: ['shell','edit','delegate'] } },
  writePaths: { type: 'array', maxItems: 30, items: { type: 'string', minLength: 1 } },
  sessionID: { type: 'string', minLength: 1 }, model: { type: 'string' }, background: { type: 'boolean' }, refreshIntent: { type: 'boolean' },
  recovery: { type: 'object', additionalProperties: false, properties: {
    kind: { type: 'string', enum: ['scope_changed','inputs_changed','authorization_changed'] }, scope: { type: 'string', minLength: 1, maxLength: 160 },
    inputs: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 160 } },
    authorization: { type: 'string', minLength: 1, maxLength: 240 }, explanation: { type: 'string', minLength: 1, maxLength: 240 }, reference: { type: 'string', minLength: 1, maxLength: 240 },
  }, required: ['kind','scope','inputs','authorization','explanation','reference'] },
}, required: ['taskId','workKey','operation','agent','description','prompt','requiredCapabilities'] };
const guidance = 'Keep taskId/workKey stable. Use sessionID to steer or resume the existing child; inspect task_dispatch_status after a failure. Set refreshIntent only to resend the full shared intent after child context compaction or loss. Never launch a replacement while its descendants remain active. Implement owns writePaths (omitted means whole workspace); deploy requires exclusive workspace ownership.';
const sameChecks = (left, right) => Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every(id => right.includes(id));
export async function installTaskDispatch(ctx, { registry = createRegistry(), loadSessions = runtimeSessions, loadSources = runtimeIntentSources } = {}) {
  if (!ctx.agent?.list) return;
  const workerProgress = createWorkerProgress(ctx, { loadSessions });
  const workspace = path.resolve(ctx.location?.directory ?? packageRoot);
  const paths = (input, agent) => {
    if (input.operation === 'deploy') return ['.'];
    if (input.operation !== 'implement' && !input.requiredCapabilities.includes('edit') && !hasCapability(agent, 'edit')) return [];
    return (input.writePaths?.length ? input.writePaths : ['.']).map(p => {
      const relative = path.relative(workspace, path.resolve(workspace, p));
      if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative) || /[*?\0]/.test(relative)) throw new Error('task-dispatch: writePaths must be literal workspace-relative paths or directories');
      return relative || '.';
    });
  };
  // A correction parks affected children at their next model request. Already-running tools finish;
  // the parent must explicitly resume that same child against the new revision.
  if (ctx.session?.hook) await ctx.session.hook('model.request', async event => registry(workspace, async state => {
    const owner = state.records.find(r => r.childID === event.sessionID && r.intentRevision);
    if (!owner) return;
    const current = getIntent(state,owner.rootID,owner.taskId);
    if (current && current.revision !== owner.intentRevision) throw new Error('task-intent: assignment superseded by user correction; parent must rebind this child to the current revision');
  }));
  await ctx.tool.transform(editor => {
    const native = editor.get('subagent');
    if (!native) throw new Error('task-dispatch: native subagent unavailable');
    const rawExecute = native.execute;
    const dispatch = async (input, context) => {
      string(input.taskId,'taskId'); string(input.workKey,'workKey');
      if (!operations.includes(input.operation) || !Array.isArray(input.requiredCapabilities) || input.requiredCapabilities.some(c => !['shell','edit','delegate'].includes(c))) throw new Error('task-dispatch: operation and requiredCapabilities are required');
      const catalog = await ctx.agent.list(), agents = catalog.data ?? catalog;
      const agent = agents.find(a => (a.id ?? a.name) === input.agent);
      if (!agent || agent.disabled) throw new Error(`task-dispatch: role ${input.agent} is unavailable`);
      const required = new Set(input.requiredCapabilities);
      if (input.operation === 'implement') required.add('edit');
      if (input.operation === 'deploy') required.add('shell');
      if (input.operation === 'coordinate') required.add('delegate');
      // Known executable requests cannot masquerade as file-only scouting.
      if (input.operation !== 'coordinate' && /\b(?:git history|commit history|git\s+(?:log|show|status|diff|rev-parse))\b/i.test(input.prompt)) required.add('shell');
      if (input.agent === 'coordinator' && (input.operation !== 'coordinate' || !required.has('delegate'))) throw new Error('task-dispatch: coordinator requires operation coordinate and terminal-worker delegation');
      const missing = [...required].filter(c => !hasCapability(agent,c));
      if (missing.length) throw new Error(`task-dispatch: ${input.agent} cannot perform ${missing.join(', ')}; use builder for executable inspection/implementation`);
      const writes = paths(input, agent), token = crypto.randomUUID();
      const admission = await registry(workspace, async (state, save) => {
        const sessions = await loadSessions(), rootID = lineage(sessions,context.sessionID);
        const key = `${rootID}\0${input.taskId}\0${input.workKey}`;
        let record = state.records.find(r => r.key === key);
        if (record?.inFlight && record.ownerPid !== process.pid) {
          let live = true; try { process.kill(record.ownerPid,0); } catch(e) { if(e.code === 'ESRCH') live=false; }
          if (!live) {
            if (!record.childID) {
              const candidates=sessions.filter(s=>s.parentID===record.parentID&&s.agent===record.agent&&s.title===record.description&&s.created>=record.startedAt);
              if(candidates.length>1&&!input.sessionID) throw new Error('task-dispatch: interrupted admission has multiple candidate children; inspect status and explicitly select its sessionID');
              record.childID=input.sessionID??candidates[0]?.id;
            }
            record.inFlight=null;record.state='paused';await save();
          }
        }
        const intent = getIntent(state,rootID,input.taskId);
        const summaryOnly = input.taskId === 'large-file-summary' && input.operation === 'inspect' && input.agent === 'scout' && input.requiredCapabilities.length === 0;
        if (intent) bindIntent(state,{rootID,taskId:input.taskId,intentRevision:input.intentRevision,checkIds:input.checkIds});
        else if (!summaryOnly && !record && !input.sessionID) throw new Error('task-intent: register the user outcome with task_intent before a new handoff; then pass intentRevision and checkIds');
        const requested = input.sessionID ?? record?.childID;
        if (requested) {
          const child = sessions.find(s => s.id === requested);
          if (!child || child.parentID !== context.sessionID || child.agent !== input.agent) throw new Error(`task-dispatch: continuation must be the same role and a direct child of this parent. Recovery: ${JSON.stringify(recovery(sessions,requested,context.sessionID,state.records))}`);
          const owner = state.records.find(r => r.childID === requested);
          if (owner && owner.key !== key) throw new Error(`task-dispatch: child belongs to taskId ${owner.taskId}, workKey ${owner.workKey}; retain that ownership identity`);
          if (record?.childID && record.childID !== requested) throw new Error('task-dispatch: workKey already owns another child; resume that child');
          if (child.active && !input.sessionID) {
            if (intent && record?.intentRevision !== intent.revision) throw new Error(`task-intent: explicitly resume child ${requested} with sessionID and the current revision to deliver the correction`);
            return { existing: requested };
          }
        }
        if (record?.inFlight) throw new Error(`task-dispatch: admission already in flight for ${input.workKey}; inspect task_dispatch_status`);
        const denied = suppression(record,input);
        if (denied) throw new Error(`task-dispatch: admission remains denied (${denied.category}). ${denialAdvice(denied.category)} Inspect task_dispatch_status for the receipt.`);
        // Include pre-upgrade tasks and all descendants, even when a parent failed quota admission.
        const busy = sessions.filter(s => s.active && s.directory === workspace && s.id !== requested && s.id !== context.sessionID && !descendant(sessions,context.sessionID,s.id));
        if (input.agent === 'coordinator' && !requested) {
          const duplicate = sessions.find(s => s.id !== requested && s.agent === 'coordinator' && lineage(sessions,s.id) === rootID && !descendant(sessions,context.sessionID,s.id) && (s.active || sessions.some(child => child.active && descendant(sessions,child.id,s.id))));
          if (duplicate) throw new Error(`task-dispatch: coordinator ${duplicate.id} already owns this task; resume it using its original parent, do not create another`);
          const pending = state.records.find(r => r.key !== key && r.rootID === rootID && r.agent === 'coordinator' && (r.inFlight || sessions.some(s => s.active && (s.id === r.childID || descendant(sessions,s.id,r.childID)))));
          if (pending) throw new Error(`task-dispatch: coordinator ownership already reserved for ${pending.childID ?? pending.workKey}`);
        }
        if (writes.length) {
          for (const other of state.records) {
            if (other.key === key || other.childID === context.sessionID || descendant(sessions,context.sessionID,other.childID)) continue;
            const active = other.inFlight || sessions.some(s => s.active && (s.id === other.childID || descendant(sessions,s.id,other.childID)));
            if (active && overlaps(writes, other.writePaths ?? [])) throw new Error(`task-dispatch: overlapping writes/deployment owned by ${other.childID ?? other.workKey}; wait for that owner and collect its evidence. Recovery: ${JSON.stringify(recovery(sessions,other.childID,context.sessionID,state.records))}`);
          }
          const legacy = busy.find(s => !state.records.some(r => r.childID === s.id) && agents.some(a => (a.id ?? a.name) === s.agent && hasCapability(a,'edit')));
          if (legacy) throw new Error(`task-dispatch: existing untracked worker ${legacy.id} may own workspace edits; finish or coordinate through its parent before starting another writer. Recovery: ${JSON.stringify(recovery(sessions,legacy.id,context.sessionID,state.records))}`);
        }
        if (!record) { record = { key,rootID,parentID:context.sessionID,taskId:input.taskId,workKey:input.workKey }; state.records.push(record); }
        const fullIntent = !!intent && (!requested || record.deliveredIntentRevision !== intent.revision || !sameChecks(record.deliveredCheckIds,input.checkIds) || input.refreshIntent === true);
        // Assignment binding starts at admission so an accepted child can record checkpoints while
        // its native call is still running. Delivery acknowledgement is tracked separately below.
        Object.assign(record,{ agent:input.agent,operation:input.operation,intentRevision:intent?.revision,checkIds:intent?input.checkIds:undefined,writePaths:writes,childID:requested,inFlight:token,ownerPid:process.pid,description:input.description,startedAt:Date.now(),state:'starting',updatedAt:Date.now() });
        await save(); return { key,childID:requested,intent,fullIntent };
      });
      if (admission.existing) return { content:`Existing child ${admission.existing} is still running. ${guidance}`, metadata:{sessionID:admission.existing,status:'running'}, output:{sessionID:admission.existing,status:'running',output:'Existing worker retained; no duplicate was launched.'} };
      const update = async patch => registry(workspace,async(state,save)=> { const r=state.records.find(r=>r.key===admission.key); if(r?.inFlight!==token) throw new Error('task-dispatch: ownership changed unexpectedly'); Object.assign(r,patch,{updatedAt:Date.now()});await save(); });
      let observed = admission.childID;
      const visible = workerProgress.attach(context.progress ?? (async () => {}));
      try {
        const handoff = !admission.intent ? input.prompt : admission.fullIntent
          ? `${renderIntent(admission.intent,input.checkIds)}\n\nWorker assignment:\n${input.prompt}`
          : `${renderIntentReference(admission.intent,input.checkIds)}\n\nNext action:\n${input.prompt}`;
        const result = await rawExecute({ agent:input.agent,description:input.description,prompt:handoff,...(admission.childID?{sessionID:admission.childID}:{}),...(input.model?{model:input.model}:{}),background:input.background??false }, {
          ...context, progress: async progress => {
            if(progress.sessionID) { observed=progress.sessionID;await update({childID:observed,state:'running'}); }
            return visible.native(progress);
          },
        });
        observed = result?.metadata?.sessionID ?? result?.output?.sessionID ?? observed;
        // A native return is the first durable evidence that it accepted this delivery. Until then,
        // retries deliberately resend the full intent rather than treating a progress event as an acknowledgement.
        const denied = admissionDenial(result);
        if (denied) {
          await update({childID:observed,state:'denied',denial:receipt(denied,input),inFlight:null});
          return {...result,content:`task-dispatch: native ${denied} recorded. ${denialAdvice(denied)}`,metadata:{...(result?.metadata??{}),denial:{category:denied}}};
        }
        await update({childID:observed,state:result?.metadata?.status ?? result?.output?.status ?? 'completed',denial:undefined,deliveredIntentRevision:admission.intent?.revision,deliveredCheckIds:admission.intent?input.checkIds:undefined,inFlight:null});
        return result;
      } catch(error) {
        const denied = admissionDenial(error);
        await update(denied ? {childID:observed,state:'denied',denial:receipt(denied,input),inFlight:null} : {childID:observed,state:observed?'paused':'not_started',inFlight:null});
        // Preserve original permission/guard error; never retry, change provider, or replace the child here.
        throw error;
      } finally { visible.close(); }
    };
    if (typeof editor.update !== 'function') throw new Error('task-dispatch: native tool transformation unavailable');
    editor.update('subagent',tool=>{tool.input=schema;tool.description+=`\nOwnership and capability checks apply to this native path too. ${guidance}`;tool.execute=dispatch;});
    editor.add({name:'task_dispatch',description:`Capability-checked durable handoff. ${guidance}`,input:schema,execute:async(input,context)=>{const {output,...rendered}=await dispatch(input,context);return rendered;}});
    editor.add({name:'task_intent',description:'Read or revise the shared user outcome for this root task. Get returns valid root user-message IDs. Only the root goal owner may set; use expectedRevision to avoid overwriting corrections. Never store secret values.',input:{type:'object',additionalProperties:false,properties:{taskId:{type:'string',minLength:1,maxLength:128},action:{type:'string',enum:['get','set']},expectedRevision:{type:'integer',minimum:0},intent:intentSchema},required:['taskId','action']},execute:async(input,context)=>registry(workspace,async(state,save)=>{
      string(input.taskId,'taskId');
      const sessions=await loadSessions(),rootID=lineage(sessions,context.sessionID);
      if (!sessions.some(s=>s.id===context.sessionID)) throw new Error('task-intent: current session metadata unavailable');
      if (input.action==='set') {
        if (context.sessionID!==rootID) throw new Error('task-intent: only the root goal owner may revise user intent; report corrections to the parent');
        const sources=await loadSources(rootID);
        if (!input.intent?.sourceMessageIDs?.length || input.intent.sourceMessageIDs.some(id=>!sources.includes(id))) throw new Error('task-intent: source IDs must refer to actual user messages in the root conversation');
        if (!input.intent.sourceMessageIDs.includes(sources.at(-1))) throw new Error('task-intent: include the latest user-message ID when establishing or revising intent');
        setIntent(state,{rootID,taskId:input.taskId,intent:input.intent,expectedRevision:input.expectedRevision,actorSessionID:context.sessionID});await save();
      } else if(input.action!=='get') throw new Error('task-intent: action must be get or set');
      const current=getIntent(state,rootID,input.taskId);
      const workers=state.records.filter(r=>r.rootID===rootID&&r.taskId===input.taskId).map(r=>({sessionID:r.childID,workKey:r.workKey,revision:r.intentRevision,checkIds:r.checkIds,state:r.state,needsRebind:!!current&&r.intentRevision!==current.revision}));
      return {content:JSON.stringify({current,workers,evidence:(state.intentEvidence??{})[JSON.stringify([rootID,input.taskId])],...(context.sessionID===rootID?{sourceMessageIDs:await loadSources(rootID)}:{})})};
    })});
    editor.add({name:'task_dispatch_status',description:'Read durable child ownership and current active descendants without launching or resuming work. Use after errors and before replacement.',input:{type:'object',additionalProperties:false,properties:{taskId:{type:'string'}}},execute:async(input,context)=>registry(workspace,async state=>{
      const sessions=await loadSessions(),rootID=lineage(sessions,context.sessionID);
      const owners=state.records.filter(r=>r.rootID===rootID&&(!input.taskId||r.taskId===input.taskId)).map(r=>({...r,key:undefined,inFlight:!!r.inFlight,denial:r.denial?{category:r.denial.category,action:denialAdvice(r.denial.category)}:undefined,needsRebind:!!r.intentRevision&&getIntent(state,rootID,r.taskId)?.revision!==r.intentRevision,activeDescendants:sessions.filter(s=>s.active&&(s.id===r.childID||descendant(sessions,s.id,r.childID))).map(s=>s.id)}));
      const legacy=sessions.filter(s=>s.active&&lineage(sessions,s.id)===rootID&&!state.records.some(r=>r.childID===s.id)).map(({id,parentID,agent})=>({id,parentID,agent}));
      const workspaceBlockers=sessions.filter(s=>s.active&&s.directory===workspace&&s.id!==context.sessionID&&agentsForStatus(s));
      function agentsForStatus(s) { return s.agent !== 'router' && !descendant(sessions,context.sessionID,s.id); }
      return {content:JSON.stringify({owners,existingUntracked:legacy,workspaceActive:workspaceBlockers.map(s=>({id:s.id,agent:s.agent,...recovery(sessions,s.id,context.sessionID,state.records)}))})};
    })});
  });
  return { dispose: () => workerProgress.dispose(), outcome: async (args,call,run) => !ctx.location?.directory ? run(null) : registry(workspace,async(state,save)=>{
    const sessions=await loadSessions(),rootID=lineage(sessions,call.sessionID),current=getIntent(state,rootID,args.taskId);
    if (!current) return run(null);
    if (args.intentRevision!==current.revision) throw new Error('task-intent: outcome requires the current intentRevision; stale results cannot complete a corrected objective');
    const owner=state.records.find(r=>r.childID===call.sessionID&&r.taskId===args.taskId&&r.rootID===rootID);
    if (call.sessionID!==rootID && (!owner || owner.intentRevision!==current.revision)) throw new Error('task-intent: child must be bound to this current root task before recording evidence');
    if (args.scope==='task' && call.sessionID!==rootID) throw new Error('task-intent: only the root goal owner can record full-task status; workers record checkpoints');
    const allowed=new Map(current.intent.checks.map(c=>[c.id,c]));
    for(const r of args.results??[]) {
      const check=allowed.get(r.id);
      if(!check || (owner && !owner.checkIds.includes(r.id)) || r.mode!==check.mode) throw new Error('task-intent: evidence must match an assigned check and its required verification mode');
    }
    if(args.scope==='task'&&args.status==='completed') {
      const busy=state.records.some(r=>r.rootID===rootID&&r.taskId===args.taskId&&(r.inFlight||sessions.some(s=>s.active&&(s.id===r.childID||descendant(sessions,s.id,r.childID)))));
      if(busy) throw new Error('task-intent: collect active workers before completing the full user outcome');
    }
    const answer=await run({goal:current.intent.outcome,authorization:current.intent.authorizedEffects.join('; ')||'No external effects authorized',checks:current.intent.checks});
    state.intentEvidence??={};const key=JSON.stringify([rootID,args.taskId]);
    const prior=state.intentEvidence[key];const evidence=prior?.revision===current.revision?prior:{revision:current.revision,checks:{}};
    for(const r of args.results??[]) evidence.checks[r.id]={...r,sessionID:call.sessionID,recordedAt:Date.now(),selfReported:true};
    evidence.lastStatus=args.status;evidence.lastScope=args.scope;state.intentEvidence[key]=evidence;await save();return answer;
  })};
}
