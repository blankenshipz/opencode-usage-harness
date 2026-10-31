import { readRoutingQuota, readRoutingPolicy, selectDispatchModel, modelReference, TASK_TYPES } from './dispatch-routing.mjs';
import { observeAdmission, convergenceAdvice, userActions, recordProgress, normalizeProgressEvidence } from './convergence.mjs';
import { checkpointSchema, normalizeCheckpoint, beginCheckpoint, acknowledgeTaskReview, normalizeReviewAcknowledgement, prepareCheckpoint, checkpointStatus, checkpointReminder, checkpointHandoff, backgroundDispatch } from './work-checkpoint.mjs';
import { recordAttempt, attemptStatus } from './verification-attempt.mjs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRegistry, runtimeSessions, runtimeIntentSources, runtimeCompletionReceipt, lineage, descendant, overlaps } from './dispatch-registry.mjs';
import { intentSchema, getIntent, setIntent, bindIntent, renderIntent, renderIntentReference } from './task-intent.mjs';
import { packageRoot } from './paths.mjs';
import { createWorkerProgress } from './worker-progress.mjs';
import { admissionDenial, denialAdvice, receipt, suppression } from './denial-recovery.mjs';
import { quotaRecoveryReceipt, enqueueQuotaRecovery, deliverQuotaRecovery, pendingQuotaRecovery, quotaRecoverySyntheticInput } from './quota-recovery.mjs';
import { guardNativeDispatch, isHarnessDispatchInput, isNativeAgent, canonicalHarnessRole } from './agent-mode.mjs';
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
const operations = ['inspect', 'verify', 'implement', 'deploy', 'coordinate'];
const routingKeys = new Set(['complexity','risk','taskType','reviewOf','reviewOfChildID','reviewIndependence']);
const capabilityMismatch = (agent, missing) => Object.assign(
  new Error(`task-dispatch: TASK_DISPATCH_CAPABILITY_MISMATCH: ${agent} cannot perform ${missing.join(', ')}; assignment validation failure; not native permission denial. No child was launched and no native execution, permission, or provider admission was attempted for this dispatch. Correct a new, unadmitted assignment by selecting an eligible role within the authorized scope; preserve any explicitly requested model. This does not clear previous denials; do not drop required capabilities, loosen permissions, or replace/resume an existing child under another role.`),
  { code: 'TASK_DISPATCH_CAPABILITY_MISMATCH', category: 'assignment_validation' },
);
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
  checkpoint: checkpointSchema,
  compact: {type:'boolean'}, resetModel: {type:'boolean'}, continuationEffort:{type:'string',enum:['reassess']},
  workReview: {type:'object',additionalProperties:false,properties:{hypothesis:{type:'string',minLength:1,maxLength:500},evidenceReference:{type:'string',minLength:1,maxLength:500}},required:['hypothesis','evidenceReference']},
  routing: {type:'object',additionalProperties:false,properties:{complexity:{type:'string',enum:['routine','standard','complex']},risk:{type:'string',enum:['normal','high']},taskType:{type:'string',enum:TASK_TYPES},reviewOf:{type:'string',minLength:3,maxLength:240},reviewOfChildID:{type:'string',minLength:1,maxLength:240},reviewIndependence:{type:'string',enum:['preferred','required']}},required:['complexity','risk']},
  recovery: { type: 'object', additionalProperties: false, properties: {
    kind: { type: 'string', enum: ['scope_changed','inputs_changed','authorization_changed'] }, scope: { type: 'string', minLength: 1, maxLength: 160 },
    inputs: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 160 } },
    authorization: { type: 'string', minLength: 1, maxLength: 240 }, explanation: { type: 'string', minLength: 1, maxLength: 240 }, reference: { type: 'string', minLength: 1, maxLength: 240 },
  }, required: ['kind','scope','inputs','authorization','explanation','reference'] },
}, required: ['taskId','workKey','operation','agent','description','prompt','requiredCapabilities'] };
// Mirrors the stock OpenCode subagent input (see core/tool/plugin/subagent.ts).
// Keep it separate from the harness schema so built-in callers retain their
// ordinary tool contract while configured harness roles still validate the
// durable task fields before dispatch.
const nativeSubagentSchema = { type:'object', additionalProperties:false, properties:{
  agent:{type:'string',minLength:1}, description:{type:'string',minLength:1}, prompt:{type:'string',minLength:1},
  model:{type:'string',minLength:1,description:'Set only when the user explicitly requests a model or variant. Discover its exact provider/model#variant ID.'}, sessionID:{type:'string',minLength:1}, background:{type:'boolean'},
}, required:['agent','description','prompt'] };
const guidance = 'Keep taskId/workKey stable. Use sessionID to steer or resume the existing child; inspect task_dispatch_status after a failure. Set refreshIntent only to resend the full shared intent after child context compaction or loss. Never launch a replacement while its descendants remain active. A new implement assignment with omitted writePaths owns the workspace; an explicit same-child continuation with omitted writePaths retains its admitted paths. Deploy requires exclusive workspace ownership.';
const sameChecks = (left, right) => Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every(id => right.includes(id));
// A corrected outcome may need a new assignment, but it may never silently
// widen or replace an already admitted child's ownership.  This is deliberately
// descriptive only: the parent still chooses the checks and explicitly resumes.
function rebindRecovery(record, current) {
  if (!record?.childID || !current || record.intentRevision === current.revision) return undefined;
  return {
    action: 'rebind_same_child', parentID: record.parentID, childID: record.childID,
    taskId: record.taskId, workKey: record.workKey, agent: record.agent, operation: record.operation,
    writePaths: record.writePaths ?? [], previousIntentRevision: record.intentRevision,
    intentRevision: current.revision, availableCheckIds: current.intent.checks.map(check => check.id),
    advice: 'The recorded parent must explicitly call task_dispatch with this sessionID, taskId/workKey, agent, operation, current intentRevision, and selected current checkIds. Omit writePaths to retain these paths; explicit paths remain subject to ownership checks. This does not authorize execution.',
  };
}
// `reviewOf` predates durable worker provenance and remains a routing hint for
// compatible callers.  A child ID is the only way a managed dispatch may make
// a verified family claim or require cross-family review.
async function validateBackgroundReceipt(owner, child, loadCompletionReceipt) {
  const receipt=owner.completionReceipt,binding=owner.completionBinding;
  if (!binding?.background) return;
  if (!receipt || receipt.generation!==owner.admissionGeneration || receipt.generation!==binding.generation || receipt.marker!==binding.marker || receipt.promptHash!==binding.promptHash || !receipt.promptID || !receipt.assistantID || !receipt.idleID)
    throw new Error('task-dispatch: review author completion receipt is missing or does not bind its admitted background generation');
  const observed=await loadCompletionReceipt({sessionID:owner.childID,marker:binding.marker,promptHash:`${binding.promptHash},${binding.prefixedPromptHash}`});
  if (!observed || ['promptID','assistantID','assistantSeq','idleID','idleSeq'].some(key=>observed[key]!==receipt[key]))
    throw new Error('task-dispatch: review author completion receipt no longer matches the native terminal chain');
}
async function resolveReviewProvenance({ input, state, sessions, rootID, record, requested, loadCompletionReceipt }) {
  const routing=input.routing;
  const persisted=record?.routing?.reviewProvenance;
  if (requested===record?.childID && persisted?.childID && modelReference(persisted.model) && record.routing?.reviewIndependence==='required') {
    if (routing?.reviewOfChildID && routing.reviewOfChildID!==persisted.childID)
      throw new Error('task-dispatch: review continuation must retain its admitted author reference');
    if (routing?.reviewIndependence && routing.reviewIndependence!=='required')
      throw new Error('task-dispatch: review continuation must retain its admitted independence requirement');
    if (routing?.reviewOf && modelReference(routing.reviewOf)!==persisted.model)
      throw new Error('task-dispatch: review continuation must retain its admitted author model');
    if (input.model && modelReference(input.model)!==record.routing.selected)
      throw new Error('task-dispatch: required review continuation must retain its admitted reviewer model');
    const validated=await resolveReviewProvenance({input:{...input,routing:{...(routing ?? {}),reviewOf:persisted.model,reviewOfChildID:persisted.childID,reviewIndependence:'required'}},state,sessions,rootID,loadCompletionReceipt});
    if (validated.routing.reviewProvenance.generation!==persisted.generation)
      throw new Error('task-dispatch: review continuation author generation changed; inspect current evidence before a new review assignment');
    return validated;
  }
  if (!routing?.reviewOfChildID) {
    if (routing?.reviewIndependence === 'required') {
      throw new Error('task-dispatch: required cross-family review needs routing.reviewOfChildID from an admitted implementation worker');
    }
    return input;
  }
  if (record?.routing?.reviewProvenance && requested===record.childID && routing.reviewOfChildID!==record.routing.reviewProvenance.childID)
    throw new Error('task-dispatch: review continuation must retain its admitted author reference');
  const owner=state.records.find(record=>record.rootID===rootID && record.childID===routing.reviewOfChildID);
  const child=sessions.find(session=>session.id===routing.reviewOfChildID);
  if (!owner || !child || lineage(sessions,child.id)!==rootID || child.parentID!==owner.parentID || child.agent!==owner.agent)
    throw new Error('task-dispatch: review author reference is unknown, stale, or outside this root owner tree');
  if (owner.operation!=='implement')
    throw new Error('task-dispatch: review author must be an admitted implementation worker');
  if (owner.inFlight)
    throw new Error('task-dispatch: review author admission is still in flight; wait for its admitted generation to finish before dispatching review');
  if (child.active)
    throw new Error('task-dispatch: review author is still active; wait for the worker to become idle and for its admitted dispatch to record completion before dispatching review');
  if (owner.state!=='completed')
    throw new Error(`task-dispatch: review author has no completed admitted implementation generation (recorded state: ${owner.state ?? 'unknown'}); explicit generation-bound completion evidence is required before dispatching review`);
  await validateBackgroundReceipt(owner,child,loadCompletionReceipt);
  const selected=modelReference(owner.routing?.selected), observed=modelReference(child.model);
  if (!selected || (observed && observed!==selected))
    throw new Error('task-dispatch: review author model evidence is missing or disagrees with its admitted route');
  if (routing.reviewOf !== undefined && modelReference(routing.reviewOf)!==selected)
    throw new Error('task-dispatch: reviewOf does not match the admitted implementation worker model');
  const provenance={childID:owner.childID,model:selected,source:'admitted_route'};
  if (Number.isInteger(owner.admissionGeneration) && owner.admissionGeneration>0) provenance.generation=owner.admissionGeneration;
  return {...input,routing:{...routing,reviewOf:selected,reviewProvenance:provenance}};
}
// Native runtime data only exposes the latest compaction.  Keep each observed
// terminal generation separately so a prior failure cannot describe a later
// successful request, and never infer an outcome from a different native ID.
function reconcileCompaction(record, child, now) {
  if (!record) return false;
  let changed = false;
  if ('compactionFailed' in record) {
    // Older records did not retain a native generation. Preserve that limited
    // fact without allowing it to describe the current generation.
    if (record.compactionFailed === true && !(record.legacyCompactionHistory ?? []).some(item => item.status === 'failed'))
      (record.legacyCompactionHistory ??= []).push({ status:'failed', legacy:true });
    delete record.compactionFailed;
    changed = true;
  }
  const native = child?.lastCompaction, id = record?.compactionID;
  if (!id || native?.id !== id || !['completed','failed'].includes(native.status)) return changed;
  const outcome = { id, status:native.status, observedAt:now() };
  if (record.compactionOutcome?.id !== id || record.compactionOutcome.status !== native.status) {
    record.compactionOutcome = outcome;
    const history = record.compactionHistory ??= [];
    if (!history.some(item => item.id === id)) history.push(outcome);
    changed = true;
  }
  if (!child.active && record.state === 'compacting') {
    record.state = native.status === 'failed' ? 'awaiting_recovery' : 'awaiting_continuation';
    record.continuationOwner = { parentID:record.parentID, childID:record.childID };
    changed = true;
  }
  return changed;
}
export function taskWorkStatus(state,rootID,taskId) {
  const records=state.records.filter(r=>r.rootID===rootID&&r.taskId===taskId);
  const totals=records.reduce((a,r)=>({steps:a.steps+(r.workAccounting?.preparedSteps??r.workCheckpoint?.preparedSteps??0),continuations:a.continuations+(r.workAccounting?.continuations??0)}),{steps:0,continuations:0});
  const review=(state.workReviews??[]).find(r=>r.rootID===rootID&&r.taskId===taskId);
  return {...totals,due:totals.steps-(review?.steps??0)>=240 || totals.continuations-(review?.continuations??0)>=12,limits:{steps:240,continuations:12}};
}
export async function installTaskDispatch(ctx, { registry = createRegistry(), loadSessions = runtimeSessions, loadSources = runtimeIntentSources, loadCompletionReceipt = runtimeCompletionReceipt, now = Date.now, loadQuota = readRoutingQuota, loadRoutingPolicy = readRoutingPolicy } = {}) {
  if (!ctx.agent?.list) return;
  const workerProgress = createWorkerProgress(ctx, { loadSessions });
  const workspace = path.resolve(ctx.location?.directory ?? packageRoot);
  const quotaNotifier = async notice => {
    if (typeof ctx.session?.synthetic !== 'function') throw new Error('task-dispatch: synthetic notification unavailable');
    await ctx.session.synthetic(quotaRecoverySyntheticInput(notice));
  };
  const queueQuotaRecovery = async ({ error, parentID, childID, generation, requestKind, compactionID }) => {
    const recorded = await registry(workspace,async(state,save) => {
      const receipt = quotaRecoveryReceipt({error,parentID,childID,generation,requestKind,compactionID,now});
      if (!receipt) return;
      enqueueQuotaRecovery(state,receipt); await save(); return receipt;
    });
    if (!recorded) return;
    try {
      await registry(workspace,async(state,save) => {
        const result = await deliverQuotaRecovery({state,target:recorded.target,notify:quotaNotifier,now});
        if (result.delivered.length) await save();
      });
    } catch { /* durable pending receipt is retried at a later explicit status boundary */ }
  };
  const paths = (input, agent) => {
    if (input.operation === 'deploy') return ['.'];
    // Executable checks may mutate via shell even when the edit tool is denied.
    if (input.operation === 'verify' && !input.writePaths?.length) return ['.'];
    if (input.operation !== 'implement' && input.operation !== 'verify' && !input.requiredCapabilities.includes('edit') && !hasCapability(agent, 'edit')) return [];
    return (input.writePaths?.length ? input.writePaths : ['.']).map(p => {
      const relative = path.relative(workspace, path.resolve(workspace, p));
      if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative) || /[*?\0]/.test(relative)) throw new Error('task-dispatch: writePaths must be literal workspace-relative paths or directories');
      return relative || '.';
    });
  };
  // A correction parks affected children at their next model request. Already-running tools finish;
  // the parent must explicitly resume that same child against the new revision.
  if (ctx.session?.hook) await ctx.session.hook('model.request', async event => registry(workspace, async state => {
    const sessions=await loadSessions();
    const historical=sessions.find(s=>s.id===event.sessionID)?.canonicalSessionID;
    if (historical) throw new Error(`Historical transcript only: continue canonical session ${historical}; no inference admitted for this copy.`);
    if (isNativeAgent(event.agent)) {
      const rootID = lineage(sessions,event.sessionID);
      if (state.records.some(r => r.childID === event.sessionID || (r.rootID === rootID && r.state !== 'completed')))
        throw new Error('task-dispatch: native mode cannot bypass existing managed task ownership; continue its recorded owner or start an independent fresh native chat.');
    }
    const owner = state.records.find(r => r.childID === event.sessionID && r.intentRevision);
    if (!owner) return;
    const current = getIntent(state,owner.rootID,owner.taskId);
    if (current && current.revision !== owner.intentRevision) throw new Error(`task-intent: assignment superseded by user correction; parent must rebind this child to the current revision. Recovery: ${JSON.stringify(rebindRecovery(owner,current))}`);
  }));
  // Native context is prepared only for primary model steps, not titles/compaction.
  // Inject a stable reminder on an existing request; never interrupt a tool or
  // manufacture a request just to observe elapsed time.
  if (ctx.session?.hook) await ctx.session.hook('context', async event => {
    const checkpoint = await registry(workspace, async (state, save) => {
      const owner = state.records.find(r => r.childID === event.sessionID && r.workCheckpoint);
      if (!owner || !['starting', 'running'].includes(owner.state) ||
          getIntent(state, owner.rootID, owner.taskId)?.revision !== owner.intentRevision) return;
      const status = prepareCheckpoint(owner, now());
      await save();
      return status;
    });
    if (checkpoint?.due && Array.isArray(event.system) && !event.system.some(p => p.text === checkpointReminder)) {
      event.system.push({ type: 'text', text: checkpointReminder });
    }
  });
  let stockInput = nativeSubagentSchema, stockDescription = 'Launch or resume a native subagent.';
  if (ctx.session?.hook) await ctx.session.hook('context', async event => {
    if (!event.tools?.subagent) return;
    event.tools.subagent.input = isNativeAgent(event.agent) ? structuredClone(stockInput) : schema;
    if (isNativeAgent(event.agent)) event.tools.subagent.description = stockDescription;
  });
  await ctx.tool.transform(editor => {
    const native = editor.get('subagent');
    if (!native) throw new Error('task-dispatch: native subagent unavailable');
    const rawExecute = native.execute;
    // Core may expose an Effect codec (functions), not cloneable JSON. The
    // pinned-runtime fallback mirrors its supported stock contract.
    stockInput = structuredClone(native.input?.type === 'object' && native.input?.properties ? native.input : nativeSubagentSchema);
    stockDescription = native.description ?? stockDescription;
    const dispatch = async (input, context) => {
      const checkpoint = normalizeCheckpoint(input.checkpoint);
      const review = input.workReview === undefined ? undefined : normalizeReviewAcknowledgement(input.workReview);
      if (input.compact !== undefined && typeof input.compact !== 'boolean') throw new Error('task-dispatch: invalid compact');
      if (input.routing && (!['routine','standard','complex'].includes(input.routing.complexity) || !['normal','high'].includes(input.routing.risk) || Object.keys(input.routing).some(key=>!routingKeys.has(key)) || (input.routing.taskType !== undefined && !TASK_TYPES.includes(input.routing.taskType)) || (input.routing.reviewOf !== undefined && !modelReference(input.routing.reviewOf)) || (input.routing.reviewOfChildID !== undefined && (typeof input.routing.reviewOfChildID!=='string' || !input.routing.reviewOfChildID.trim() || input.routing.reviewOfChildID.length>240 || /[\r\n\0]/.test(input.routing.reviewOfChildID))) || (input.routing.reviewIndependence !== undefined && !['preferred','required'].includes(input.routing.reviewIndependence)))) throw new Error('task-dispatch: invalid routing assessment');
      if (input.background !== undefined && typeof input.background !== 'boolean') throw new Error('task-dispatch: invalid background');
      string(input.taskId,'taskId'); string(input.workKey,'workKey');
      if (!operations.includes(input.operation) || !Array.isArray(input.requiredCapabilities) || input.requiredCapabilities.some(c => !['shell','edit','delegate'].includes(c))) throw new Error('task-dispatch: operation and requiredCapabilities are required');
      if (input.model !== undefined && !modelReference(input.model)) throw new Error('task-dispatch: invalid explicit model reference');
      if (input.resetModel !== undefined && typeof input.resetModel !== 'boolean') throw new Error('task-dispatch: invalid resetModel');
      if (input.continuationEffort !== undefined && input.continuationEffort !== 'reassess') throw new Error('task-dispatch: invalid continuationEffort');
      const catalog = await ctx.agent.list(), agents = catalog.data ?? catalog;
      const agent = agents.find(a => (a.id ?? a.name) === input.agent);
      if (!agent || agent.disabled) throw new Error(`task-dispatch: role ${input.agent} is unavailable`);
      const required = new Set(input.requiredCapabilities);
      if (input.operation === 'implement') required.add('edit');
      if (['deploy','verify'].includes(input.operation)) required.add('shell');
      if (input.operation === 'coordinate') required.add('delegate');
      // Known executable requests cannot masquerade as file-only scouting.
      if (input.operation !== 'coordinate' && /\b(?:git history|commit history|git\s+(?:log|show|status|diff|rev-parse))\b/i.test(input.prompt)) required.add('shell');
      const role = canonicalHarnessRole(input.agent) ?? input.agent;
      if (role === 'verifier' && input.operation !== 'verify') throw new Error('task-dispatch: verifier requires operation verify and retained write ownership');
      if (role === 'coordinator' && (input.operation !== 'coordinate' || !required.has('delegate'))) throw new Error('task-dispatch: coordinator requires operation coordinate and terminal-worker delegation');
      const missing = [...required].filter(c => !hasCapability(agent,c));
      if (missing.length) {
        // Capability correction is only safe before an assignment has an owner.
        // This lookup deliberately does not reconcile, save, admit, or read quota.
        const existing = await registry(workspace, async state => {
          const sessions = await loadSessions(), rootID = lineage(sessions,context.sessionID);
          const key = `${rootID}\0${input.taskId}\0${input.workKey}`;
          const record = state.records.find(item => item.key === key);
          const requested = input.sessionID ?? record?.childID;
          const child = requested && sessions.find(session => session.id === requested);
          const owner = requested && state.records.find(item => item.childID === requested);
          if (requested) {
            if (!child || child.parentID !== context.sessionID || child.agent !== input.agent)
              return { message:`task-dispatch: continuation must be the same role and a direct child of this parent. Recovery: ${JSON.stringify(recovery(sessions,requested,context.sessionID,state.records))}` };
            if (owner && owner.key !== key)
              return { message:`task-dispatch: child belongs to taskId ${owner.taskId}, workKey ${owner.workKey}; retain that ownership identity` };
            if (record?.childID && record.childID !== requested)
              return { message:'task-dispatch: workKey already owns another child; resume that child' };
          }
          if (record?.denial)
            return { message:`task-dispatch: admission remains denied (${record.denial.category}). ${denialAdvice(record.denial.category)} Inspect task_dispatch_status for the receipt.` };
          if (record || owner || child)
            return { message:`task-dispatch: existing assignment ${input.taskId}/${input.workKey} already has recorded ownership; preserve its child and role identity.` };
        });
        if (existing) throw new Error(existing.message);
        throw capabilityMismatch(input.agent, missing);
      }
      let writes = paths(input, agent);
      // Optional planning telemetry is advisory only. Read it after all local
      // assignment validation so an impossible request has no quota side effect.
      const routingPolicy = loadRoutingPolicy();
      if (routingPolicy?.enabled === true && !input.routing) {
        // Existing admitted work keeps its route; only new managed assignments
        // must supply the assessment that enables pacing and quality floors.
        const admitted = await registry(workspace, async state => {
          const sessions = await loadSessions(), rootID = lineage(sessions, context.sessionID);
          const key = `${rootID}\0${input.taskId}\0${input.workKey}`;
          const record = state.records.find(r => r.key === key);
          const denied = suppression(record, input);
          if (denied) throw new Error(`task-dispatch: admission remains denied (${denied.category}). ${denialAdvice(denied.category)} Inspect task_dispatch_status for the receipt.`);
          return Boolean(record?.childID && (!input.sessionID || input.sessionID === record.childID));
        });
        if (!admitted) throw new Error('ROUTING_ASSESSMENT_REQUIRED: new managed assignments require routing complexity and risk; no work was admitted.');
      }
      let quota;
      if (input.routing) { try { quota = await loadQuota(ctx); } catch (error) {
        if (error?.code === 'ROUTING_POLICY_INVALID') throw error;
        // Unknown telemetry never erases the local task-fit policy.
      } }
      quota = { ...(quota ?? {}), routingPolicy: routingPolicy ?? quota?.routingPolicy };
      const token = crypto.randomUUID();
      const admission = await registry(workspace, async (state, save) => {
        const sessions = await loadSessions(), rootID = lineage(sessions,context.sessionID);
        const historical=sessions.find(s=>s.id===context.sessionID)?.canonicalSessionID ?? sessions.find(s=>s.id===rootID)?.canonicalSessionID;
        if (historical) throw new Error(`task-dispatch: historical transcript only; continue canonical session ${historical}. Do not adopt workers or retry in this copy.`);
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
        const summaryOnly = input.taskId === 'large-file-summary' && input.operation === 'inspect' && role === 'scout' && input.requiredCapabilities.length === 0;
        if (intent) bindIntent(state,{rootID,taskId:input.taskId,intentRevision:input.intentRevision,checkIds:input.checkIds});
        else if (!summaryOnly && !record && !input.sessionID) throw new Error('task-intent: register the user outcome with task_intent before a new handoff; then pass intentRevision and checkIds');
        const requested = input.sessionID ?? record?.childID;
        const staleRebind = Boolean(intent && record && requested && record.intentRevision !== intent.revision);
        if (requested) {
          const child = sessions.find(s => s.id === requested);
          if (!child || child.parentID !== context.sessionID || child.agent !== input.agent) throw new Error(`task-dispatch: continuation must be the same role and a direct child of this parent. Recovery: ${JSON.stringify(recovery(sessions,requested,context.sessionID,state.records))}`);
          const owner = state.records.find(r => r.childID === requested);
          if (owner && owner.key !== key) throw new Error(`task-dispatch: child belongs to taskId ${owner.taskId}, workKey ${owner.workKey}; retain that ownership identity`);
          if (record?.childID && record.childID !== requested) throw new Error('task-dispatch: workKey already owns another child; resume that child');
          if (reconcileCompaction(record, child, now)) await save();
          // A continuation cannot silently widen a non-empty ownership set by
          // omitting paths. An empty prior inspect scope must not suppress the
          // fresh workspace reservation for implement/verify, and deploy always
          // retains its exclusive workspace reservation. Explicit path changes
          // still take the normal overlap and ownership route below.
          if (record && input.sessionID && input.writePaths === undefined && record.operation === input.operation && input.operation !== 'deploy' && ((record.writePaths?.length ?? 0) > 0 || writes.length === 0)) writes = record.writePaths ?? writes;
          if (staleRebind) {
            if (!input.sessionID) throw new Error(`task-intent: explicitly resume child ${requested} with sessionID and the current revision to deliver the correction. Recovery: ${JSON.stringify(rebindRecovery(record,intent))}`);
            if (child.active) throw new Error(`task-intent: child ${requested} is still active on a superseded revision; wait for it to become idle before explicitly rebinding. Recovery: ${JSON.stringify(rebindRecovery(record,intent))}`);
          }
          if (record?.state === 'compacting') {
            const settled=record.compactionOutcome?.id===record.compactionID;
            if (!settled || child.active) return {existing:requested,compacting:true};
          }
          if (child.active && !input.sessionID) {
            return { existing: requested };
          }
        }
        if (record?.inFlight) throw new Error(`task-dispatch: admission already in flight for ${input.workKey}; inspect task_dispatch_status`);
        const denied = suppression(record,input);
        if (denied) throw new Error(`task-dispatch: admission remains denied (${denied.category}). ${denialAdvice(denied.category)} Inspect task_dispatch_status for the receipt.`);
        // Include pre-upgrade tasks and all descendants, even when a parent failed quota admission.
        const busy = sessions.filter(s => s.active && s.directory === workspace && s.id !== requested && s.id !== context.sessionID && !descendant(sessions,context.sessionID,s.id));
        if (role === 'coordinator' && !requested) {
          const duplicate = sessions.find(s => s.id !== requested && canonicalHarnessRole(s.agent) === 'coordinator' && lineage(sessions,s.id) === rootID && !descendant(sessions,context.sessionID,s.id) && (s.active || sessions.some(child => child.active && descendant(sessions,child.id,s.id))));
          if (duplicate) throw new Error(`task-dispatch: coordinator ${duplicate.id} already owns this task; resume it using its original parent, do not create another`);
          const pending = state.records.find(r => r.key !== key && r.rootID === rootID && canonicalHarnessRole(r.agent) === 'coordinator' && (r.inFlight || sessions.some(s => s.active && (s.id === r.childID || descendant(sessions,s.id,r.childID)))));
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
        const child = sessions.find(s=>s.id===requested);
        if ((checkpointStatus(record,now())?.taskReview.due || taskWorkStatus(state,rootID,input.taskId).due) && !review && !child?.active)
          throw new Error('task-dispatch: cumulative work review due; supply workReview {hypothesis,evidenceReference} from retained results before continuing this same owner. No human permission is required.');
        if (review) {
          acknowledgeTaskReview(record,review,now());
          const total=taskWorkStatus(state,rootID,input.taskId);
          state.workReviews=(state.workReviews??[]).filter(r=>r.rootID!==rootID||r.taskId!==input.taskId);
          state.workReviews.push({rootID,taskId:input.taskId,steps:total.steps,continuations:total.continuations,...review,at:now()});
        }
        const routedInput=await resolveReviewProvenance({input,state,sessions,rootID,record,requested,loadCompletionReceipt});
        const routing=selectDispatchModel({input:routedInput,agent,agents,record,child,quota,
          hasActiveDescendant:Boolean(requested && sessions.some(session=>session.active&&descendant(sessions,session.id,requested)))});
        if (routedInput.routing?.reviewProvenance) routing.reviewProvenance=routedInput.routing.reviewProvenance;
        if (routedInput.routing?.reviewIndependence) routing.reviewIndependence=routedInput.routing.reviewIndependence;
        if (input.compact) {
          if (!requested || !checkpoint || !ctx.session?.compact) throw new Error('task-dispatch: compaction requires an existing worker, retained checkpoint and supported native compact API');
          if (sessions.some(s=>s.active&&(s.id===requested||descendant(sessions,s.id,requested)))) throw new Error('task-dispatch: wait for this worker and its descendants before checkpoint compaction');
          if (!child.lastAssistantID || child.lastAssistantID===record.compactedThrough) throw new Error('task-dispatch: no new observed context to compact');
        }
        const contextAdvice=checkpointStatus(record,now(),{knownContext:{tokens:child?.contextTokens}})?.highContext;
        // Native delivery has not yet acknowledged the corrected assignment.
        // Preserve the old gate so a failed or denied delivery cannot let the
        // existing child infer against a revision it never received.
        const restoreBinding = staleRebind ? {
          intentRevision: record.intentRevision, checkIds: record.checkIds,
          deliveredIntentRevision: record.deliveredIntentRevision, deliveredCheckIds: record.deliveredCheckIds,
        } : undefined;
        Object.assign(record,{routing,modelOverride:routing.modelOverride});
        const convergence = observeAdmission(record,state,input,rootID);
        const fullIntent = !!intent && (!requested || record.deliveredIntentRevision !== intent.revision || !sameChecks(record.deliveredCheckIds,input.checkIds) || input.refreshIntent === true);
        // Assignment binding starts at admission so an accepted child can record checkpoints while
        // its native call is still running. Delivery acknowledgement is tracked separately below.
        const generation=(record.admissionGeneration ?? 0)+1;
        Object.assign(record,{ agent:input.agent,operation:input.operation,intentRevision:intent?.revision,checkIds:intent?input.checkIds:undefined,writePaths:writes,childID:requested,inFlight:token,ownerPid:process.pid,description:input.description,startedAt:Date.now(),state:'starting',updatedAt:Date.now(),admissionGeneration:generation });
        beginCheckpoint(record, checkpoint, now());
        await save(); return { key,childID:requested,intent,fullIntent,convergence,routing,contextAdvice,lastAssistantID:child?.lastAssistantID,generation,restoreBinding };
      });
      if (admission.existing) return { content:`Existing child ${admission.existing} is still running or awaiting its admitted compaction outcome. ${guidance}`, metadata:{sessionID:admission.existing,status:'running'}, output:{sessionID:admission.existing,status:'running',output:'Existing worker retained; no duplicate was launched.'} };
      const update = async patch => registry(workspace,async(state,save)=> { const r=state.records.find(r=>r.key===admission.key); if(r?.inFlight!==token) throw new Error('task-dispatch: ownership changed unexpectedly'); Object.assign(r,patch,{updatedAt:Date.now()});await save(); });
      let observed = admission.childID;
      let compactionID;
      const visible = workerProgress.attach(context.progress ?? (async () => {}));
      try {
        if (input.compact) {
          compactionID='msg_'+crypto.randomUUID().replaceAll('-','');
          await update({state:'compacting',compactionID,compactionOutcome:undefined,compactionFailed:undefined,continuationOwnerID:admission.childID});
          await ctx.session.compact({sessionID:admission.childID,id:compactionID});
          await update({state:'compacting',inFlight:null,compactedThrough:admission.lastAssistantID,deliveredIntentRevision:undefined,deliveredCheckIds:undefined});
          return {content:'Native same-session compaction admitted. Wait for idle, then resume this worker; full intent will be refreshed. No replacement worker created.',metadata:{sessionID:admission.childID,status:'compacting'}};
        }
        const handoff = !admission.intent ? input.prompt : admission.fullIntent
          ? `${renderIntent(admission.intent,input.checkIds)}\n\nWorker assignment:\n${input.prompt}`
          : `${renderIntentReference(admission.intent,input.checkIds)}\n\nNext action:\n${input.prompt}`;
        const marker=`task-dispatch-generation-${crypto.randomUUID()}`;
        const baseHandoff = `${handoff}\n\n${checkpointHandoff(checkpoint)}${admission.contextAdvice ? "\nHigh context: at the next completed boundary retain a concise checkpoint and ask the parent for same-session compact:true before further work." : ""}`;
        const markedHandoff = `${baseHandoff}\n\nDispatch completion marker: ${marker}`;
        const boundedHandoff = admission.convergence ? `${markedHandoff}\n\nConvergence advisory: ${admission.convergence.advisory}` : markedHandoff;
        const promptHash=crypto.createHash('sha256').update(boundedHandoff).digest('hex');
        const prefixedPromptHash=crypto.createHash('sha256').update(`You are a subagent spawned by another session.\n${boundedHandoff}`).digest('hex');
        const completionBinding={generation:admission.generation,marker,promptHash,prefixedPromptHash,background:backgroundDispatch(input)};
        await update({completionBinding,completionReceipt:undefined});
        const result = await rawExecute({ agent:input.agent,description:input.description,prompt:boundedHandoff,...(admission.childID?{sessionID:admission.childID}:{}),...(admission.routing.selected?{model:admission.routing.selected}:{}),background:backgroundDispatch(input) }, {
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
          await update({childID:observed,state:'denied',denial:receipt(denied,input),inFlight:null,...(admission.restoreBinding ?? {})});
          return {...result,content:`task-dispatch: native ${denied} recorded. ${denialAdvice(denied)}`,metadata:{...(result?.metadata??{}),denial:{category:denied}}};
        }
        await update({childID:observed,state:result?.metadata?.status ?? result?.output?.status ?? 'completed',denial:undefined,deliveredIntentRevision:admission.intent?.revision,deliveredCheckIds:admission.intent?input.checkIds:undefined,inFlight:null});
        return {...result, metadata:{...(result.metadata ?? {}),routing:admission.routing,...(admission.contextAdvice?{contextAdvice:admission.contextAdvice}:{}),...(admission.convergence?{convergence:admission.convergence}:{})}};
      } catch(error) {
        const denied = admissionDenial(error);
        await update(denied ? {childID:observed,state:'denied',denial:receipt(denied,input),inFlight:null,...(admission.restoreBinding ?? {})} : {childID:observed,state:observed?'paused':'not_started',inFlight:null,...(admission.restoreBinding ?? {})});
        try { await queueQuotaRecovery({error,parentID:context.sessionID,childID:observed,generation:admission.generation,requestKind:input.compact?'compaction':'dispatch',compactionID}); } catch { /* recovery reporting cannot replace the native admission failure */ }
        // Preserve original permission/guard error; never retry, change provider, or replace the child here.
        throw error;
      } finally { visible.close(); }
    };
    if (typeof editor.update !== 'function') throw new Error('task-dispatch: native tool transformation unavailable');
    editor.update('subagent',tool=>{
      // Built-in agents use the stock subagent schema.  Harness roles enter
      // through task_dispatch (or a harness-shaped call) and retain the full
      // durable ownership contract.
      tool.description+=`\nHarness callers use task_dispatch for ownership and capability checks. ${guidance}`;
      tool.input={type:'object',additionalProperties:false,properties:{...stockInput.properties,...schema.properties},required:stockInput.required ?? ['agent','description','prompt']};
      tool.execute=async(input,context)=>{
        if (isNativeAgent(context?.agent) && !isHarnessDispatchInput(input)) {
          await guardNativeDispatch({ registry, workspace, loadSessions, context, input, lineage });
          return rawExecute(input,context);
        }
        return dispatch(input,context);
      };
    });
    editor.add({name:'task_dispatch',description:`Capability-checked durable handoff. ${guidance}`,input:schema,execute:async(input,context)=>{const {output,...rendered}=await dispatch(input,context);return rendered;}});
    editor.add({name:'task_dispatch_collect',description:'Collect an exact terminal receipt for one admitted background generation without inference. Legacy or unbound generations are not collectable.',input:{type:'object',additionalProperties:false,properties:{taskId:{type:'string',minLength:1},workKey:{type:'string',minLength:1},sessionID:{type:'string',minLength:1},generation:{type:'integer',minimum:1}},required:['taskId','workKey','sessionID','generation']},execute:async(input,context)=>registry(workspace,async(state,save)=>{
      const sessions=await loadSessions(),rootID=lineage(sessions,context.sessionID),key=`${rootID}\0${input.taskId}\0${input.workKey}`,record=state.records.find(r=>r.key===key),child=sessions.find(s=>s.id===input.sessionID);
      if (!record || record.parentID!==context.sessionID || record.childID!==input.sessionID || record.admissionGeneration!==input.generation) throw new Error('task-dispatch: collection must name the recorded parent, task, work key, child, and generation exactly');
      const binding=record.completionBinding,current=getIntent(state,rootID,input.taskId);
      if (!binding?.background || binding.generation!==input.generation) throw new Error('task-dispatch: this generation has no collectable background completion binding');
      if (record.state==='completed' && record.completionReceipt?.generation===input.generation) return {content:JSON.stringify({sessionID:input.sessionID,generation:input.generation,status:'completed',receipt:record.completionReceipt})};
      if (record.state!=='running' || record.inFlight || !child || lineage(sessions,input.sessionID)!==rootID || child.active || child.parentID!==record.parentID || child.agent!==record.agent || (modelReference(child.model)&&modelReference(child.model)!==modelReference(record.routing?.selected)) || current?.revision!==record.intentRevision || sessions.some(s=>s.active&&descendant(sessions,s.id,input.sessionID))) throw new Error('task-dispatch: generation is not at a collectable terminal boundary');
      const receipt=await loadCompletionReceipt({sessionID:input.sessionID,marker:binding.marker,promptHash:`${binding.promptHash},${binding.prefixedPromptHash}`});
      if (!receipt) throw new Error('task-dispatch: no exact terminal receipt exists for this background generation; idle alone is not completion');
      record.state='completed';record.completionReceipt={generation:input.generation,marker:binding.marker,promptHash:binding.promptHash,...receipt};record.updatedAt=Date.now();await save();
      return {content:JSON.stringify({sessionID:input.sessionID,generation:input.generation,status:'completed',receipt:record.completionReceipt})};
    })});
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
    editor.add({name:'task_dispatch_status',description:'Read durable child ownership and current active descendants without launching or resuming work. Use after errors and before replacement.',input:{type:'object',additionalProperties:false,properties:{taskId:{type:'string'}}},execute:async(input,context)=>registry(workspace,async(state,save)=>{
      const sessions=await loadSessions(),rootID=lineage(sessions,context.sessionID);
      let reconciled = false;
      for (const record of state.records.filter(record=>record.rootID===rootID)) if (reconcileCompaction(record,sessions.find(s=>s.id===record.childID),now)) reconciled = true;
      if (reconciled) await save();
      try {
        let delivered=false;
        for (const record of state.records.filter(r=>r.rootID===rootID&&r.parentID&&r.childID&&r.admissionGeneration)) {
          const recovered = await deliverQuotaRecovery({state,target:{parentID:record.parentID,childID:record.childID,generation:record.admissionGeneration},notify:quotaNotifier,now});
          delivered ||= recovered.delivered.length > 0;
        }
        if (delivered) await save();
      } catch { /* status remains read-safe; the durable receipt stays pending for a later explicit retry */ }
      const owners=state.records.filter(r=>r.rootID===rootID&&(!input.taskId||r.taskId===input.taskId)).map(r=>{const native=sessions.find(s=>s.id===r.childID),current=getIntent(state,rootID,r.taskId),rebind=rebindRecovery(r,current);const awaiting=r.state==='running'&&native?.active===false,eligibleForInspection=!!(r.completionBinding?.background&&awaiting&&!r.inFlight&&!sessions.some(s=>s.active&&descendant(sessions,s.id,r.childID)));return {...r,key:undefined,recordedState:r.state,effectiveState:awaiting?'awaiting_result_collection':r.state,collection:r.completionBinding?.background?{action:'task_dispatch_collect',eligibleForInspection,terminalEvidenceVerified:false,taskId:r.taskId,workKey:r.workKey,sessionID:r.childID,generation:r.admissionGeneration}:undefined,nativeExecution:{active:native?.active??null,lastIdleOutcome:native?.lastIdleOutcome},workCheckpoint:checkpointStatus(r,now()),verificationAttempt:r.attemptIntentRevision===current?.revision?attemptStatus(r,now()):undefined,convergence:convergenceAdvice(r),inFlight:!!r.inFlight,denial:r.denial?{category:r.denial.category,action:denialAdvice(r.denial.category)}:undefined,needsRebind:!!rebind,rebind,continuationOwner:['awaiting_continuation','awaiting_recovery'].includes(r.state)?{...(r.continuationOwner ?? {parentID:r.parentID,childID:r.childID}),action:r.state==='awaiting_recovery'?'recover_same_child':'resume_same_child'}:undefined,activeDescendants:sessions.filter(s=>s.active&&(s.id===r.childID||descendant(sessions,s.id,r.childID))).map(s=>s.id)};});
      const legacy=sessions.filter(s=>s.active&&lineage(sessions,s.id)===rootID&&!state.records.some(r=>r.childID===s.id)).map(({id,parentID,agent})=>({id,parentID,agent}));
      const workspaceBlockers=sessions.filter(s=>s.active&&s.directory===workspace&&s.id!==context.sessionID&&agentsForStatus(s));
      function agentsForStatus(s) { return canonicalHarnessRole(s.agent) !== 'router' && !descendant(sessions,context.sessionID,s.id); }
      const currentRecovery = entry => state.records.some(r => r.rootID===rootID && r.parentID===entry.target.parentID && r.childID===entry.target.childID && r.admissionGeneration===entry.target.generation);
      return {content:JSON.stringify({owners,quotaRecoveryPending:pendingQuotaRecovery(state).filter(currentRecovery),taskWork:input.taskId?taskWorkStatus(state,rootID,input.taskId):undefined,userActions:state.records.filter(r=>r.rootID===rootID&&(!input.taskId||r.taskId===input.taskId)).flatMap(r=>userActions([r],getIntent(state,rootID,r.taskId)?.revision)),existingUntracked:legacy,workspaceActive:workspaceBlockers.map(s=>({id:s.id,agent:s.agent,...recovery(sessions,s.id,context.sessionID,state.records)}))})};
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
    const progressEvidence = normalizeProgressEvidence(args.progressEvidence);
    // Validate on a copy before accepting/recording an outcome. A rejected outcome
    // must not advance durable attempt state or semantic progress.
    const stagedOwner = owner ? structuredClone(owner) : undefined;
    if (args.attempt !== undefined) {
      if (!stagedOwner) throw new Error('task-dispatch: verification attempts require a bound worker owner');
      if (stagedOwner.attemptIntentRevision !== current.revision) delete stagedOwner.verificationAttempt;
      recordAttempt(stagedOwner, args.attempt, now());
      stagedOwner.attemptIntentRevision = current.revision;
    }
    const answer=await run({goal:current.intent.outcome,authorization:current.intent.authorizedEffects.join('; ')||'No external effects authorized',checks:current.intent.checks});
    if (owner && progressEvidence) recordProgress(owner, progressEvidence);
    if (owner && args.attempt !== undefined) {
      owner.verificationAttempt = stagedOwner.verificationAttempt;
      owner.attemptIntentRevision = stagedOwner.attemptIntentRevision;
    }
    state.intentEvidence??={};const key=JSON.stringify([rootID,args.taskId]);
    const prior=state.intentEvidence[key];const evidence=prior?.revision===current.revision?prior:{revision:current.revision,checks:{}};
    for(const r of args.results??[]) evidence.checks[r.id]={...r,sessionID:call.sessionID,recordedAt:Date.now(),selfReported:true};
    if (owner) owner.attention = args.progressState === 'needs_user_action' ? {intentRevision:current.revision,progressState:'needs_user_action',nextAction:args.blocker?.nextAction,recordedAt:Date.now(),selfReported:true} : undefined;
    evidence.lastStatus=args.status;evidence.lastScope=args.scope;state.intentEvidence[key]=evidence;await save();return answer;
  })};
}
