import { workerObservation } from './worker-observation.mjs';
import { readRoutingQuota, readRoutingPolicy, selectDispatchModel, modelReference, TASK_TYPES } from './dispatch-routing.mjs';
import { waitForCompactionIdle } from './compaction-wait.mjs';

import { observeAdmission, convergenceAdvice, userActions, recordProgress, normalizeProgressEvidence } from './convergence.mjs';
import { checkpointSchema, normalizeCheckpoint, observedContext, contextMaintenance, beginCheckpoint, acknowledgeTaskReview, normalizeReviewAcknowledgement, prepareCheckpoint, checkpointStatus, checkpointReminder, checkpointHandoff, backgroundDispatch } from './work-checkpoint.mjs';
import { recordAttempt, attemptStatus } from './verification-attempt.mjs';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import { createRegistry, runtimeSessions, runtimeIntentSources, runtimeCompletionReceipt, runtimeTerminalReceipt, runtimeFinalText, runtimeDeliveryEvidence, lineage, descendant, overlaps } from './dispatch-registry.mjs';
import { authorizeExternalWrites } from './external-write-grant.mjs';
import { reserveWriterLease, finishWriterLease, writerPathsOverlap } from './global-write-lease.mjs';
import { intentSchema, getIntent, setIntent, inferIntent, resolveIntentBinding, renderIntent, renderIntentReference } from './task-intent.mjs';
import { packageRoot, statePath } from './paths.mjs';
import { createWorkerProgress } from './worker-progress.mjs';
import { admissionDenial, denialAdvice, receipt, suppression } from './denial-recovery.mjs';
import { quotaRecoveryReceipt, enqueueQuotaRecovery, deliverQuotaRecovery, pendingQuotaRecovery, quotaRecoverySyntheticInput } from './quota-recovery.mjs';
import { guardNativeDispatch, isHarnessDispatchInput, isNativeAgent, canonicalHarnessRole } from './agent-mode.mjs';
import { beginHandoffTiming, acceptHandoffTiming, collectHandoffTiming, handoffTimingStatus } from './handoff-timing.mjs';
import { summarizeTaskDispatchStatus } from './task-dispatch-status-summary.mjs';
import { integrationAssignmentTemplate } from './integration-assignment.mjs';
import { rootProgressStatus, rootProgressReminder } from './root-progress.mjs';
import { createTerminalSettler, terminalSettlementEligibility } from './terminal-settlement.mjs';
import { createDispatchCanceller, cancelInputSchema } from './task-dispatch-cancel.mjs';
import { createResultDelivery } from './result-delivery.mjs';
import { createStaleReconciler } from './dispatch-reconcile.mjs';
import { midRunCompactionEnabled, midRunCompactionDecision, settleMidRunCompaction, admitMidRunCompaction, recordAdmitted, recordAdmissionFailure, recordBaseline, buildContinuation, activeContinuation, midRunCompactionStatus, pendingCompactionPreservation, BRIEF_LIMIT } from './mid-run-compaction.mjs';

const readContextCatalog = async ctx => {
  try { return (await ctx.model?.list())?.data; } catch { return undefined; }
};
// Ordinary workspace aliases remain supported; containment is checked after
// resolving the nearest existing ancestor. External grants use stricter checks.
async function canonicalWriterPath(value) {
  let current=path.resolve(value);const missing=[];
  for(;;) {
    try{return path.join(await realpath(current),...missing);}
    catch(error){if(error.code!=='ENOENT')throw error;const parent=path.dirname(current);if(parent===current)throw error;missing.unshift(path.basename(current));current=parent;}
  }
}
function capabilityEligibility(agent, capability) {
  const rules = agent.permissions ?? [], action = capability === 'delegate' ? 'subagent' : capability;
  const match = (pattern, value) => new RegExp(`^${pattern.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(value);
  const effect = resource => {
    let result = 'ask';
    for (const rule of rules) if (match(rule.action, action) && match(rule.resource, resource)) result = rule.effect;
    return result;
  };
  return {
    unrestricted: effect('*') !== 'deny',
    scoped: rules.some(rule => match(rule.action, action) && rule.resource !== '*' && effect(rule.resource) !== 'deny'),
  };
}
// Eligibility is not a permission grant: it only establishes that a role has
// some non-denied capability. Scoped rules are useful for continuing work that
// already owns that scope, but the native executor still authorizes each exact
// resource (and this check never turns a scoped rule into workspace access).
export function hasCapability(agent, capability) {
  const eligibility = capabilityEligibility(agent, capability);
  // This mirrors the existing delegate eligibility rule for every capability:
  // an explicitly scoped, non-denied rule is potential capability even when a
  // catch-all deny prevents unrestricted access. Exact native authorization is
  // intentionally left to the executor rather than reimplemented here.
  return eligibility.unrestricted || eligibility.scoped;
}
const hasUnrestrictedCapability = (agent, capability) => capabilityEligibility(agent, capability).unrestricted;
const execFileAsync = promisify(execFile);
const string = (value, name) => { if (typeof value !== 'string' || !value.trim() || value.length > 160 || /[\r\n\0]/.test(value)) throw new Error(`task-dispatch: valid ${name} is required`); return value; };
const contained = (root, candidate) => candidate === root || candidate.startsWith(root + path.sep);
const relativeLiteralDirectory = (workspace, value) => {
  if (typeof value !== 'string' || !value.trim() || /[*?\r\n\0]/.test(value) || path.isAbsolute(value)) throw new Error('task-dispatch: publish requires publication.checkout as a literal workspace-relative directory');
  const absolute=path.resolve(workspace,value), relative=path.relative(workspace,absolute);
  if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) throw new Error('task-dispatch: publish requires publication.checkout as a literal workspace-relative directory');
  return { absolute, relative: relative || '.' };
};
const gitEnvironment = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
async function gitPath(cwd, argument) {
  try {
    const { stdout } = await execFileAsync('git',['rev-parse',argument],{cwd,env:gitEnvironment(),timeout:2000,maxBuffer:8192,windowsHide:true});
    const value=stdout.trim();
    if (!value || /[\r\n\0]/.test(value)) throw new Error('invalid');
    return value;
  } catch { throw new Error('task-dispatch: publish Git scope discovery is unavailable'); }
}
export async function resolvePublicationScope({ workspace, checkout }) {
  const requested=relativeLiteralDirectory(workspace,checkout);
  let realWorkspace, realCheckout;
  try {
    [realWorkspace,realCheckout]=await Promise.all([realpath(workspace),realpath(requested.absolute)]);
    if (!contained(realWorkspace,realCheckout)) throw new Error('outside');
  } catch { throw new Error('task-dispatch: publish Git scope is unavailable or outside the workspace'); }
  const [root, commonOutput]=await Promise.all([gitPath(requested.absolute,'--show-toplevel'),gitPath(requested.absolute,'--git-common-dir')]);
  try {
    const [realRoot,realCommon]=await Promise.all([
      realpath(root), realpath(path.isAbsolute(commonOutput) ? commonOutput : path.resolve(requested.absolute,commonOutput)),
    ]);
    if (!contained(realWorkspace,realCheckout) || !contained(realWorkspace,realRoot) || !contained(realWorkspace,realCommon) || realRoot !== realCheckout)
      throw new Error('outside');
    return { checkout:path.relative(realWorkspace,realCheckout) || '.', commonGit:path.relative(realWorkspace,realCommon) || '.' };
  } catch { throw new Error('task-dispatch: publish Git scope is unavailable or outside the workspace'); }
}
const operations = ['inspect', 'verify', 'implement', 'deploy', 'publish', 'coordinate'];
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

// Registering the shared intent first is recommended, not required: a handoff
// without it (or with a stale revision or unknown check ids) still proceeds with
// an inferred or corrected binding and a warning, because a rejected handoff
// forces the model to regenerate its whole (often large) prompt.
export const INTENT_FIRST_HELP = "Recommended before the first handoff of a taskId: task_intent({taskId, action:'set', expectedRevision:0, intent:{outcome, target, nonGoals:[], authorizedEffects:[], assumptions:[], checks:[{id:'tests', description:'...', mode:'local'}], sourceMessageIDs:['<latest root user msg_ id from task_intent get>']}}), then pass intentRevision:<current.revision> and checkIds:['tests'] in the handoff. Without it the handoff still runs: the harness infers an intent from description/prompt (or binds the current revision and checks) and returns a warning.";
const INTENT_REVISION_HELP = `Recommended for every new handoff; a missing or stale value binds to the current revision with a warning. ${INTENT_FIRST_HELP}`;
export function intentWarning(taskId, notes) {
  const id = JSON.stringify(typeof taskId === 'string' ? taskId : '<taskId>');
  return `Intent warning (handoff proceeded): ${notes.join('; ')}. To register or correct it: task_intent({taskId:${id}, action:'get'}), then task_intent({taskId:${id}, action:'set', expectedRevision:<current.revision or 0>, intent:{...}}) and pass intentRevision/checkIds on later handoffs.`;
}
const schema = { type: 'object', additionalProperties: false, properties: {
  taskId: { type: 'string', minLength: 1, maxLength: 160 }, workKey: { type: 'string', minLength: 1, maxLength: 160 },
  operation: { type: 'string', enum: operations },
  intentRevision: {type:'integer',minimum:1,description:INTENT_REVISION_HELP}, checkIds:{type:'array',minItems:1,maxItems:12,uniqueItems:true,items:{type:'string'},description:'Recommended with intentRevision: 1-12 check ids from the current task_intent checks that this worker must satisfy. Unknown ids are dropped; none selects every current check.'},
  agent: { type: 'string', minLength: 1 }, description: { type: 'string', minLength: 1 },
  requiredCapabilities: { type: 'array', uniqueItems: true, items: { type: 'string', enum: ['shell','edit','delegate'] } },
  writePaths: { type: 'array', maxItems: 30, items: { type: 'string', minLength: 1 } },
  publication: { type: 'object', additionalProperties: false, properties: { revision: { type: 'string', minLength: 40, maxLength: 64 }, checkout: { type: 'string', minLength: 1, maxLength: 500 } }, required: ['revision','checkout'] },
  sessionID: { type: 'string', minLength: 1 }, model: { type: 'string' }, background: { type: 'boolean' }, refreshIntent: { type: 'boolean' }, externalWriteGrantID: { type: 'string', minLength: 1, maxLength: 160 },
  checkpoint: checkpointSchema,
  compact: {type:'boolean'}, resetModel: {type:'boolean'}, continuationEffort:{type:'string',enum:['reassess']},
  workReview: {type:'object',additionalProperties:false,properties:{hypothesis:{type:'string',minLength:1,maxLength:500},evidenceReference:{type:'string',minLength:1,maxLength:500}},required:['hypothesis','evidenceReference']},
  routing: {type:'object',additionalProperties:false,properties:{complexity:{type:'string',enum:['routine','standard','complex']},risk:{type:'string',enum:['normal','high']},taskType:{type:'string',enum:TASK_TYPES},reviewOf:{type:'string',minLength:3,maxLength:240},reviewOfChildID:{type:'string',minLength:1,maxLength:240},reviewIndependence:{type:'string',enum:['preferred','required']}},required:['complexity','risk']},
  recovery: { type: 'object', additionalProperties: false, properties: {
    kind: { type: 'string', enum: ['scope_changed','inputs_changed','authorization_changed'] }, scope: { type: 'string', minLength: 1, maxLength: 160 },
    inputs: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 160 } },
    authorization: { type: 'string', minLength: 1, maxLength: 240 }, explanation: { type: 'string', minLength: 1, maxLength: 240 }, reference: { type: 'string', minLength: 1, maxLength: 240 },
  }, required: ['kind','scope','inputs','authorization','explanation','reference'] },
  // Keep the large free-text prompt last so short identity/intent fields are
  // generated (and corrected) before a long assignment body.
  prompt: { type: 'string', minLength: 1, description: 'Worker assignment text. Write it after the short identity/intent fields; a rejected handoff must be re-sent in full.' },
}, required: ['taskId','workKey','operation','agent','description','prompt','requiredCapabilities'] };
// Mirrors the stock OpenCode subagent input (see core/tool/plugin/subagent.ts).
// Keep it separate from the harness schema so built-in callers retain their
// ordinary tool contract while configured harness roles still validate the
// durable task fields before dispatch.
const nativeSubagentSchema = { type:'object', additionalProperties:false, properties:{
  agent:{type:'string',minLength:1}, description:{type:'string',minLength:1}, prompt:{type:'string',minLength:1},
  model:{type:'string',minLength:1,description:'Set only when the user explicitly requests a model or variant. Discover its exact provider/model#variant ID.'}, sessionID:{type:'string',minLength:1}, background:{type:'boolean'},
}, required:['agent','description','prompt'] };
const guidance = 'Keep taskId/workKey stable. Use sessionID to steer or resume the existing child; inspect task_dispatch_status summary:true at continuation boundaries and after a failure. If nextDispatch.workReview.requiredWhenIdle is true, include workReview {hypothesis,evidenceReference} before the next idle admission; this reassessment needs no human approval. Set refreshIntent only to resend the full shared intent after child context compaction or loss. Never launch a replacement while its descendants remain active. A new implement assignment with omitted writePaths owns the workspace; an explicit same-child continuation with omitted writePaths retains its admitted paths. Deploy requires exclusive workspace ownership. Publish requires explicit scoped paths and an exact frozen revision.';
// OpenCode records a tool's terminal event with metadata validated as strict
// JSON (Schema.Json). A nested `undefined` (for example routing.modelOverride),
// NaN or a class instance makes that durable publish fail after core has marked
// the call settled: the tool part stays "running" and the parent model receives
// no result. Every harness dispatch result therefore carries plain JSON only.
export function jsonMetadata(value) {
  if (value === undefined || value === null) return undefined;
  try {
    const plain = JSON.parse(JSON.stringify(value));
    return plain && typeof plain === 'object' && !Array.isArray(plain) ? plain : undefined;
  } catch { return undefined; }
}
export const HANDOFF_RESULT_LIMIT = 16000;
export function boundedReport(value, limit = HANDOFF_RESULT_LIMIT) {
  const text = typeof value === 'string' ? value : '';
  if (text.length <= limit) return { text, truncated:false, length:text.length };
  return { text:`${text.slice(0, limit)}\n[harness: final report truncated at ${limit} of ${text.length} characters]`, truncated:true, length:text.length };
}
// Native results always carry output.status; harness-only states (compacting,
// awaiting_continuation) are not task completion and map to running.
const nativeStatus = result => (result?.output?.status ?? result?.metadata?.status) === 'completed' ? 'completed' : 'running';
const nativeReport = result => {
  if (typeof result?.output?.output === 'string') return result.output.output;
  if (typeof result?.content === 'string') return result.content.replace(/^<subagent [^>]*>\n?/, '').replace(/\n?<\/subagent>$/, '');
  if (Array.isArray(result?.content)) return result.content.filter(item => item?.type === 'text').map(item => item.text).join('\n');
  return '';
};
const collectArguments = ({ taskId, workKey, sessionID, generation }) => ({ taskId, workKey, sessionID, generation });
// The native subagent tool declares {sessionID,status,output}; core rejects a
// result without it. Harness-only returns (compaction, retained child) are
// normalized here so they still settle.
export function settleSubagentResult(result) {
  const metadata = jsonMetadata(result?.metadata);
  const text = typeof result?.content === 'string' ? result.content : nativeReport(result);
  const sessionID = result?.output?.sessionID ?? metadata?.sessionID;
  const settled = { ...result, content: text || 'task-dispatch: no textual result', metadata };
  if (metadata === undefined) delete settled.metadata;
  if (typeof sessionID === 'string' && sessionID) settled.output = { sessionID, status: nativeStatus({ output:result?.output, metadata }), output: typeof result?.output?.output === 'string' ? result.output.output : text };
  return settled;
}
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
function collectionEligibility({ record, child, sessions, rootID, current, callerID }) {
  if (!record.completionBinding?.background || record.completionBinding.generation !== record.admissionGeneration) return { eligible: false, blockedReason: 'completion binding does not match the recorded generation' };
  if (record.state !== 'running') return { eligible: false, blockedReason: `recorded state is ${record.state ?? 'unknown'}` };
  if (record.inFlight) return { eligible: false, blockedReason: 'admission is in flight' };
  if (!child) return { eligible: false, blockedReason: 'child session is unavailable' };
  if (record.parentID !== callerID) return { eligible: false, blockedReason: 'caller is not the recorded parent' };
  if (lineage(sessions, child.id) !== rootID) return { eligible: false, blockedReason: 'child is outside the recorded root' };
  if (child.active) return { eligible: false, blockedReason: 'child is active' };
  if (child.parentID !== record.parentID) return { eligible: false, blockedReason: 'child parent does not match the recorded parent' };
  if (child.agent !== record.agent) return { eligible: false, blockedReason: 'child role does not match the recorded role' };
  if (modelReference(child.model) && modelReference(child.model) !== modelReference(record.routing?.selected)) return { eligible: false, blockedReason: 'child model does not match the recorded model' };
  if (current?.revision !== record.intentRevision) return { eligible: false, blockedReason: 'recorded intent is stale' };
  if (sessions.some(s => s.active && descendant(sessions, s.id, child.id))) return { eligible: false, blockedReason: 'an active descendant remains' };
  return { eligible: true };
}
// `reviewOf` predates durable worker provenance and remains a routing hint for
// compatible callers.  A child ID is the only way a managed dispatch may make
// a verified family claim or require cross-family review.
async function validateBackgroundReceipt(owner, child, loadCompletionReceipt, purpose = 'review author') {
  const receipt=owner.completionReceipt,binding=owner.completionBinding;
  if (!binding?.background) return;
  if (!receipt || receipt.generation!==owner.admissionGeneration || receipt.generation!==binding.generation || receipt.marker!==binding.marker || receipt.promptHash!==binding.promptHash || !receipt.promptID || !receipt.assistantID || !receipt.idleID)
    throw new Error(`task-dispatch: ${purpose} completion receipt is missing or does not bind its admitted background generation`);
  const observed=await loadCompletionReceipt({sessionID:owner.childID,marker:binding.marker,promptHash:`${binding.promptHash},${binding.prefixedPromptHash}`});
  if (!observed || ['promptID','assistantID','assistantSeq','idleID','idleSeq'].some(key=>observed[key]!==receipt[key]))
    throw new Error(`task-dispatch: ${purpose} completion receipt no longer matches the native terminal chain`);
}
function compactionSourceEvidence(record, childID) {
  const receipt=record.completionReceipt, binding=record.completionBinding;
  if (!receipt || !binding?.background) return undefined;
  return { childID, sourceGeneration:receipt.generation, intentRevision:record.intentRevision, checkIds:record.checkIds,
    binding:{generation:binding.generation,marker:binding.marker,promptHash:binding.promptHash,prefixedPromptHash:binding.prefixedPromptHash},
    receipt:Object.fromEntries(['generation','marker','promptHash','promptID','assistantID','assistantSeq','idleID','idleSeq'].map(key=>[key,receipt[key]])) };
}
function hasRetainedCompactionEvidence(record, childID) {
  const saved=record.compactionSourceEvidence;
  if (record.state!=='awaiting_recovery' || record.compactionOutcome?.id!==record.compactionID || record.compactionOutcome?.status!=='failed' || !saved || saved.compactionID!==record.compactionID) return false;
  const {compactionID,...identity}=saved;
  const expected=compactionSourceEvidence(record,childID);
  return expected && Number.isInteger(saved.sourceGeneration) && saved.sourceGeneration===record.completionBinding.generation && JSON.stringify(identity)===JSON.stringify(expected);
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
  // Compaction is maintenance, not a new implementation result. Only the
  // exact retained, natively revalidated source receipt may supply provenance.
  let sourceOwner=owner;
  if (owner.state==='awaiting_continuation') {
    const saved=owner.compactionSourceEvidence;
    const expected=compactionSourceEvidence(owner,owner.childID);
    const {compactionID,...identity}=saved ?? {};
    if (saved && expected && compactionID===owner.compactionID &&
        owner.compactionOutcome?.id===compactionID && owner.compactionOutcome.status==='completed' &&
        child.lastCompaction?.id===compactionID && child.lastCompaction.status==='completed' &&
        Number.isInteger(saved.sourceGeneration) && saved.sourceGeneration>0 && saved.sourceGeneration<owner.admissionGeneration &&
        saved.sourceGeneration===owner.completionBinding?.generation &&
        JSON.stringify(identity)===JSON.stringify(expected))
      sourceOwner={...owner,admissionGeneration:saved.sourceGeneration,state:'completed'};
  }
  if (sourceOwner.state!=='completed')
    throw new Error(`task-dispatch: review author has no completed admitted implementation generation (recorded state: ${owner.state ?? 'unknown'}); explicit generation-bound completion evidence is required before dispatching review`);
  await validateBackgroundReceipt(sourceOwner,child,loadCompletionReceipt);
  const selected=modelReference(owner.routing?.selected), observed=modelReference(child.model);
  if (!selected || (observed && observed!==selected))
    throw new Error('task-dispatch: review author model evidence is missing or disagrees with its admitted route');
  if (routing.reviewOf !== undefined && modelReference(routing.reviewOf)!==selected)
    throw new Error('task-dispatch: reviewOf does not match the admitted implementation worker model');
  const provenance={childID:owner.childID,model:selected,source:'admitted_route'};
  if (Number.isInteger(sourceOwner.admissionGeneration) && sourceOwner.admissionGeneration>0) provenance.generation=sourceOwner.admissionGeneration;
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
// Read-only preflight advice; admission still performs its authoritative review check.
export function dispatchReviewRequirement(record, taskWork, at) {
  const laneDue = checkpointStatus(record,at)?.taskReview.due === true;
  const taskDue = taskWork?.due === true;
  return { requiredWhenIdle:laneDue || taskDue, laneDue, taskDue,
    ...(laneDue || taskDue ? { requiredFields:['hypothesis','evidenceReference'] } : {}) };
}
export function taskWorkStatus(state,rootID,taskId) {
  const records=state.records.filter(r=>r.rootID===rootID&&r.taskId===taskId);
  const totals=records.reduce((a,r)=>({steps:a.steps+(r.workAccounting?.preparedSteps??r.workCheckpoint?.preparedSteps??0),continuations:a.continuations+(r.workAccounting?.continuations??0)}),{steps:0,continuations:0});
  const review=(state.workReviews??[]).find(r=>r.rootID===rootID&&r.taskId===taskId);
  return {...totals,due:totals.steps-(review?.steps??0)>=240 || totals.continuations-(review?.continuations??0)>=12,limits:{steps:240,continuations:12}};
}
export async function installTaskDispatch(ctx, { registry = createRegistry(), globalRegistry = createRegistry(statePath('dispatch-global-writers')), loadSessions = runtimeSessions, loadSources = runtimeIntentSources, loadCompletionReceipt = runtimeCompletionReceipt, loadTerminalReceipt = runtimeTerminalReceipt, loadFinalText = runtimeFinalText, loadDeliveryEvidence = runtimeDeliveryEvidence, deliverySchedule, now = Date.now, loadQuota = readRoutingQuota, loadRoutingPolicy = readRoutingPolicy, resolvePublicationScope: discoverPublicationScope = resolvePublicationScope, grantPath, configRoot } = {}) {
  if (!ctx.agent?.list) return;
  const workerProgress = createWorkerProgress(ctx, { loadSessions });
  const workspace = path.resolve(ctx.location?.directory ?? packageRoot);
  const settleTerminal = createTerminalSettler({ registry, globalRegistry, workspace,
    canonicalWorkspace:()=>canonicalWriterPath(workspace), loadSessions, loadTerminalReceipt, now });
  const cancelChild = createDispatchCanceller({ registry, globalRegistry, workspace,
    canonicalWorkspace:()=>canonicalWriterPath(workspace), loadSessions, ctx, now });
  // Cancelled, interrupted or orphaned children must not leave `running` rows
  // or writer leases that reject the next lane.
  const reconciler = createStaleReconciler({ registry, globalRegistry, workspace,
    canonicalWorkspace:()=>canonicalWriterPath(workspace), loadSessions, loadTerminalReceipt, now });
  // Every admitted generation's result must reach its parent even when the
  // handoff call is aborted or its returned result is not recorded.
  const resultDelivery = createResultDelivery({ registry, workspace, ctx, loadEvidence:loadDeliveryEvidence, loadFinalText, now,
    onTerminalFailure:(key,generation)=>reconciler.settleGeneration(key,generation),
    ...(deliverySchedule ? { schedule:deliverySchedule } : {}) });
  try { await reconciler.reconcile(); } catch { /* never block plugin start; the next start retries */ }
  try { await resultDelivery.resume(); } catch { /* pending deliveries are re-armed at the next plugin start */ }
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
    if (input.operation === 'deploy') return { local:['.'], external:[] };
    if (input.operation === 'publish') {
      const local=[];
      for (const p of input.writePaths) {
        if (typeof p !== 'string' || !p.trim() || /[*?\r\n\0]/.test(p)) throw new Error('task-dispatch: writePaths must be non-empty literal paths or directories');
        const resolved = path.resolve(workspace, p);
        const relative = path.relative(workspace, resolved);
        if (path.isAbsolute(p) && (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)))
          throw new Error('task-dispatch: publish writePaths must be workspace-relative; no external grant is available');
        if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) throw new Error('task-dispatch: writePaths must be workspace-relative or explicitly granted absolute paths');
        local.push(relative || '.');
      }
      return { local, external:[] };
    }
    // Executable checks may mutate via shell even when the edit tool is denied.
    if (input.operation === 'verify' && !input.writePaths?.length) return { local:['.'], external:[] };
    if (input.operation !== 'implement' && input.operation !== 'verify' && !input.requiredCapabilities.includes('edit') && !hasUnrestrictedCapability(agent, 'edit')) return { local:[], external:[] };
    const local=[], external=[];
    for (const p of (input.writePaths?.length ? input.writePaths : ['.'])) {
      if (typeof p !== 'string' || /[*?\0]/.test(p)) throw new Error('task-dispatch: writePaths must be literal paths or directories');
      const resolved = path.resolve(workspace, p);
      const relative = path.relative(workspace, resolved);
      if (path.isAbsolute(p) && (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative))) { external.push(p); continue; }
      if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) throw new Error('task-dispatch: writePaths must be workspace-relative or explicitly granted absolute paths');
      local.push(relative || '.');
    }
    return { local, external };
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
    // An explicitly cancelled child (or a descendant of one) never infers again
    // until its parent re-admits it through task_dispatch.
    const cancelled = state.records.find(r => r.state === 'cancelled' && r.childID && (r.childID === event.sessionID || descendant(sessions,event.sessionID,r.childID)));
    if (cancelled) throw new Error(`task-dispatch: child ${cancelled.childID} was cancelled by its parent (${cancelled.cancellation?.reason ?? 'no reason'}); stop. Only the parent may re-admit it via task_dispatch.`);
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
      if (!owner && ['router','coordinator'].includes(canonicalHarnessRole(event.agent))) {
        const self = (await loadSessions()).find(s => s.id === event.sessionID);
        const managed = state.records.some(r => r.rootID === event.sessionID) ||
          Object.values(state.intents ?? {}).some(intent => intent.rootID === event.sessionID);
        if (managed && rootProgressStatus(self, now())?.due && Array.isArray(event.system) &&
            !event.system.some(p => p.text === rootProgressReminder))
          event.system.push({ type: 'text', text: rootProgressReminder });
      }
      if (!owner || !['starting', 'running'].includes(owner.state) ||
          getIntent(state, owner.rootID, owner.taskId)?.revision !== owner.intentRevision) return;
      const status = prepareCheckpoint(owner, now());
      await save();
      return { status, key: owner.key };
    });
    if (checkpoint?.status?.due && Array.isArray(event.system) && !event.system.some(p => p.text === checkpointReminder)) {
      event.system.push({ type: 'text', text: checkpointReminder });
    }
    // Mid-run compaction is optional maintenance: any failure leaves the step untouched.
    let continuation;
    if (checkpoint?.key) try { continuation = await midRunCompaction(event.sessionID, checkpoint.key); } catch { /* never block a model step */ }
    if (continuation && Array.isArray(event.system) && !event.system.some(p => p.text === continuation))
      event.system.push({ type: 'text', text: continuation });
  });
  // The native summary request of a pending mid-run compaction must keep the
  // running assignment; system text here reaches only that summary request.
  if (ctx.session?.hook) await ctx.session.hook('compaction', async event => {
    try {
      const text = await registry(workspace, async state => pendingCompactionPreservation(state.records.find(r => r.childID === event.sessionID && r.midRunCompaction?.pending)));
      if (text && Array.isArray(event.system) && !event.system.some(p => p.text === text)) event.system.push({ type: 'text', text });
    } catch { /* never block native compaction */ }
  });
  // At a native step boundary (this request is being prepared, so the previous
  // step and its tools have settled), admit one steered compaction for a running
  // child whose observed context reached the absolute trigger. The runtime runs
  // it before the next model request; see mid-run-compaction.mjs for the gates.
  const midRunCompaction = async (sessionID, key) => {
    if (typeof ctx.session?.compact !== 'function') return;
    const [sessions, catalog] = await Promise.all([loadSessions(), readContextCatalog(ctx)]);
    const native = sessions.find(s => s.id === sessionID);
    const planned = await registry(workspace, async (state, save) => {
      const record = state.records.find(r => r.key === key && r.childID === sessionID);
      if (!record) return {};
      let changed = settleMidRunCompaction(record, native, now());
      const intentCurrent = getIntent(state, record.rootID, record.taskId)?.revision === record.intentRevision;
      const decision = midRunCompactionDecision(record, native, { sessions, catalog, compactionAvailable: midRunCompactionEnabled(), intentCurrent });
      if (decision.baselineTokens !== undefined) changed = recordBaseline(record, decision.baselineTokens) || changed;
      let id;
      if (decision.admit) {
        const continuationText = buildContinuation(record, { intent: getIntent(state, record.rootID, record.taskId), evidence: state.intentEvidence?.[JSON.stringify([record.rootID, record.taskId])] });
        id = admitMidRunCompaction(record, decision, continuationText, now());
        changed = true;
      }
      if (changed) await save();
      return { id, observation: decision.observation, continuation: activeContinuation(record) };
    });
    if (planned.id) {
      let admitted = false;
      try { await ctx.session.compact({ sessionID, id: planned.id }); admitted = true; }
      catch { /* conflict with another pending compaction or unavailable: record and stop retrying this observation */ }
      await registry(workspace, async (state, save) => {
        const record = state.records.find(r => r.key === key && r.childID === sessionID);
        if (record && (admitted ? recordAdmitted(record, planned.id) : recordAdmissionFailure(record, planned.id, planned.observation, now()))) await save();
      });
    }
    return planned.continuation;
  };
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
    // Intent corrections never block a handoff; they are reported with its result.
    const dispatch = async (input, context) => {
      const intentNotes = [];
      const result = await admitAndRun(input, context, intentNotes);
      if (!intentNotes.length) return result;
      const warning = intentWarning(input.taskId, [...new Set(intentNotes)]);
      return { ...result, content: `${typeof result?.content === 'string' && result.content ? `${result.content}\n\n` : ''}${warning}`, metadata: { ...(result?.metadata ?? {}), intentWarning: warning } };
    };
    const admitAndRun = async (input, context, intentNotes) => {
      const checkpoint = normalizeCheckpoint(input.checkpoint);
      const review = input.workReview === undefined ? undefined : normalizeReviewAcknowledgement(input.workReview);
      if (input.compact !== undefined && typeof input.compact !== 'boolean') throw new Error('task-dispatch: invalid compact');
      if (input.routing && (!['routine','standard','complex'].includes(input.routing.complexity) || !['normal','high'].includes(input.routing.risk) || Object.keys(input.routing).some(key=>!routingKeys.has(key)) || (input.routing.taskType !== undefined && !TASK_TYPES.includes(input.routing.taskType)) || (input.routing.reviewOf !== undefined && !modelReference(input.routing.reviewOf)) || (input.routing.reviewOfChildID !== undefined && (typeof input.routing.reviewOfChildID!=='string' || !input.routing.reviewOfChildID.trim() || input.routing.reviewOfChildID.length>240 || /[\r\n\0]/.test(input.routing.reviewOfChildID))) || (input.routing.reviewIndependence !== undefined && !['preferred','required'].includes(input.routing.reviewIndependence)))) throw new Error('task-dispatch: invalid routing assessment');
      if (input.background !== undefined && typeof input.background !== 'boolean') throw new Error('task-dispatch: invalid background');
      string(input.taskId,'taskId'); string(input.workKey,'workKey');
      if (!operations.includes(input.operation) || !Array.isArray(input.requiredCapabilities) || input.requiredCapabilities.some(c => !['shell','edit','delegate'].includes(c))) throw new Error('task-dispatch: operation and requiredCapabilities are required');
      if (input.operation === 'publish') {
        if (!Array.isArray(input.writePaths) || input.writePaths.length === 0) throw new Error('task-dispatch: publish requires explicit non-empty writePaths for every admission');
        if (!input.publication || typeof input.publication !== 'object' || Array.isArray(input.publication) || Object.keys(input.publication).length !== 2 || typeof input.publication.revision !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(input.publication.revision)) throw new Error('task-dispatch: publish requires publication.revision as a full frozen commit OID');
        relativeLiteralDirectory(workspace,input.publication.checkout);
      } else if (input.publication !== undefined) throw new Error('task-dispatch: publication is only valid for publish');
      if (input.model !== undefined && !modelReference(input.model)) throw new Error('task-dispatch: invalid explicit model reference');
      if (input.resetModel !== undefined && typeof input.resetModel !== 'boolean') throw new Error('task-dispatch: invalid resetModel');
      if (input.continuationEffort !== undefined && input.continuationEffort !== 'reassess') throw new Error('task-dispatch: invalid continuationEffort');
      const catalog = await ctx.agent.list(), agents = catalog.data ?? catalog;
      const agent = agents.find(a => (a.id ?? a.name) === input.agent);
      if (!agent || agent.disabled) throw new Error(`task-dispatch: role ${input.agent} is unavailable`);
      const required = new Set(input.requiredCapabilities);
      if (input.operation === 'implement') required.add('edit');
      if (['deploy','verify','publish'].includes(input.operation)) required.add('shell');
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
            return { message:`task-dispatch: existing same-identity assignment ${input.taskId}/${input.workKey} is missing required capability: ${missing.join(', ')}; preserve its child and role identity. This eligibility check does not change native permission authorization.` };
        });
        if (existing) throw new Error(existing.message);
        throw capabilityMismatch(input.agent, missing);
      }
      const requestedCheckout = input.operation === 'publish' ? relativeLiteralDirectory(workspace,input.publication.checkout) : undefined;
      let publicationScope;
      if (input.operation === 'publish') {
        try { publicationScope = await discoverPublicationScope({workspace,checkout:input.publication.checkout}); }
        catch { throw new Error('task-dispatch: publish Git scope discovery is unavailable or outside the workspace'); }
      }
      if (publicationScope) {
        try {
          if (!publicationScope.checkout || !publicationScope.commonGit || relativeLiteralDirectory(workspace,publicationScope.checkout).relative !== requestedCheckout.relative) throw new Error('invalid');
          relativeLiteralDirectory(workspace,publicationScope.commonGit);
        } catch { throw new Error('task-dispatch: publish Git scope discovery is unavailable or outside the workspace'); }
      } else if (input.operation === 'publish') throw new Error('task-dispatch: publish Git scope discovery is unavailable or outside the workspace');
      const requestedPaths = paths(input, agent);
      let writes = publicationScope ? [...new Set([...requestedPaths.local,publicationScope.checkout,publicationScope.commonGit])] : requestedPaths.local;
      let externalWrites = requestedPaths.external;
      if (externalWrites.length && input.operation !== 'implement') throw new Error('task-dispatch: external write grants only permit implement assignments');
      if (externalWrites.length && !input.externalWriteGrantID) throw new Error('task-dispatch: external absolute writePaths require an operator external write grant before native dispatch');
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
      const contextCatalog=quota.catalog ?? await readContextCatalog(ctx);
      const token = crypto.randomUUID();
      const admission = await globalRegistry('all-writers', async (globalState, saveGlobal) => {
       try { return await registry(workspace, async (state, save) => {
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
            if(record.childID) {
              const recovered=sessions.find(session=>session.id===record.childID);
              if(!recovered || context.sessionID!==record.parentID || recovered.parentID!==context.sessionID || recovered.agent!==record.agent || recovered.agent!==input.agent || state.records.some(other=>other.key!==key && other.childID===recovered.id))
                throw new Error('task-dispatch: interrupted child identity does not match its recorded parent and role');
              const canonicalWorkspace=await canonicalWriterPath(workspace);
              const prior=globalState.leases?.find(lease=>lease.token===record.inFlight && lease.key===key && lease.workspace===canonicalWorkspace);
              if(prior && !prior.childID) {
                finishWriterLease(globalState,prior.token,{childID:record.childID});
                await saveGlobal();
              }
            }
            record.inFlight=null;record.state='paused';await save();
          }
        }
        let intent = getIntent(state,rootID,input.taskId), inferredNow = false;
        const summaryOnly = input.taskId === 'large-file-summary' && input.operation === 'inspect' && role === 'scout' && input.requiredCapabilities.length === 0;
        if (!intent && !summaryOnly && !record && !input.sessionID) {
          // Only the root goal owner may establish intent; it must cite a root user message.
          let sources = [];
          if (context.sessionID === rootID) { try { sources = await loadSources(rootID); } catch { sources = []; } }
          const inferred = inferIntent({ description:input.description, prompt:input.prompt, checkIds:input.checkIds, sourceMessageIDs:sources });
          if (inferred) {
            setIntent(state,{rootID,taskId:input.taskId,intent:inferred,expectedRevision:0,actorSessionID:context.sessionID});
            state.intents[JSON.stringify([rootID,input.taskId])].inferred = true;
            intent = getIntent(state,rootID,input.taskId); inferredNow = true;
            intentNotes.push(`no task_intent was registered for taskId ${JSON.stringify(input.taskId)}; inferred revision ${intent.revision} from this handoff (outcome ${JSON.stringify(intent.intent.outcome.slice(0,120))}, checks ${JSON.stringify(intent.intent.checks.map(check=>check.id))}, source ${JSON.stringify(intent.intent.sourceMessageIDs)}, no authorized effects)`);
          } else intentNotes.push(`no task_intent was registered for taskId ${JSON.stringify(input.taskId)} and none could be inferred (${context.sessionID === rootID ? 'no root user message ID was available' : 'only the root goal owner may establish intent'}); the handoff runs without shared intent`);
        }
        if (intent) {
          // A missing/stale revision or unknown check ids are corrected, not rejected.
          const binding = resolveIntentBinding(intent,{intentRevision:inferredNow ? intent.revision : input.intentRevision,checkIds:input.checkIds});
          if (!inferredNow) intentNotes.push(...binding.notes);
          input.intentRevision = binding.intentRevision; input.checkIds = binding.checkIds;
        }
        const requested = input.sessionID ?? record?.childID;
        const staleRebind = Boolean(intent && record && requested && record.intentRevision !== intent.revision);
        if (requested) {
          const child = sessions.find(s => s.id === requested);
          if (!child || child.parentID !== context.sessionID || child.agent !== input.agent) throw new Error(`task-dispatch: continuation must be the same role and a direct child of this parent. Recovery: ${JSON.stringify(recovery(sessions,requested,context.sessionID,state.records))}`);
          const owner = state.records.find(r => r.childID === requested);
          if (owner && owner.key !== key) throw new Error(`task-dispatch: child belongs to taskId ${owner.taskId}, workKey ${owner.workKey}; retain that ownership identity`);
          if (record?.childID && record.childID !== requested) throw new Error('task-dispatch: workKey already owns another child; resume that child');
          if (!record && !['deploy','publish'].includes(input.operation) && writes.length && (input.writePaths === undefined || (Array.isArray(input.writePaths) && input.writePaths.length === 0)))
            throw new Error('task-dispatch: a legacy continuation without a recorded write scope requires explicit non-empty writePaths before it can perform a write-capable operation');
          if (reconcileCompaction(record, child, now)) await save();
          // An owned continuation keeps its admitted local scope when it omits
          // paths, even if its next bounded operation changes. This applies to
          // both an explicit sessionID and the child resolved from the same
          // work key. Deploy remains workspace-exclusive. A prior empty
          // read-only scope never authorizes a later writer to claim the
          // workspace by omission.
          const hasRecordedLocalScope = record && Object.hasOwn(record,'writePaths');
          const priorLocalWrites = record?.writePaths ?? [];
          // `paths` accounts for both declared capabilities and the role's
          // effective edit capability, so an edit-capable inspect request is
          // treated as a writer when it would otherwise receive `.`.
          const requestedLocalWriter = writes.length > 0;
          if (record && input.writePaths === undefined && !['deploy','publish'].includes(input.operation)) {
            if (priorLocalWrites.length) writes = priorLocalWrites;
            // An external-only owner has no local scope to retain, but its
            // separately recorded grant is revalidated below for this exact
            // operation. Do not classify it as a read-only owner here.
            else if (record.externalGrant) writes = [];
            else if (!hasRecordedLocalScope && requestedLocalWriter) throw new Error('task-dispatch: a legacy continuation without a recorded write scope requires explicit non-empty writePaths before it can perform a write-capable operation');
            else if (requestedLocalWriter) throw new Error('task-dispatch: a continuation from an empty read-only scope requires explicit non-empty writePaths before it can perform a write-capable operation');
          }
          // An explicit empty array used to fall through to the workspace
          // default. On an existing writer that is ambiguous and must be
          // corrected rather than broadening its retained ownership.
          if (record && Array.isArray(input.writePaths) && input.writePaths.length === 0 && requestedLocalWriter)
            throw new Error('task-dispatch: an existing write-capable continuation requires explicit non-empty writePaths; [] cannot mean the workspace');
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
        // An omitted continuation path retains its prior grant only after a
        // fresh read: expiry, revocation, and every binding remain live gates.
        let externalGrant;
        if (externalWrites.length || (input.writePaths === undefined && record?.externalGrant)) {
          const retained = externalWrites.length ? undefined : record.externalGrant;
          externalGrant = await authorizeExternalWrites({
            grantID: input.externalWriteGrantID ?? retained?.grantID, workspace, rootID, parentID:context.sessionID,
            childID:requested, taskId:input.taskId, workKey:input.workKey, intentRevision:intent?.revision,
            checkIds:intent ? input.checkIds : undefined, agent:input.agent, operation:input.operation,
            destinations: externalWrites.length ? externalWrites : (record.externalWrites ?? []), now, grantPath, configRoot,
          });
          externalWrites = externalGrant.destinations;
        }
        // Old/native sessions may not have a global reservation. For an
        // external destination, conservatively require those workspaces idle.
        if (externalWrites.length) for (const session of sessions) {
          if (!session.active || session.id===requested || session.id===context.sessionID || descendant(sessions,context.sessionID,session.id)) continue;
          if (!session.directory) throw new Error('task-dispatch: active session directory unavailable; external destination quiescence is unverified');
          if (writerPathsOverlap(externalWrites,[await canonicalWriterPath(session.directory)]))
            throw new Error(`task-dispatch: external destination has active session ${session.id}; wait for destination quiescence`);
        }
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
            if (active && overlaps(writes, other.writePaths ?? [])) {
              const requestedPaths=writes.filter(candidate => (other.writePaths ?? []).some(otherPath => overlaps([candidate],[otherPath]))).map(candidate => path.resolve(workspace,candidate));
              const conflictingPaths=(other.writePaths ?? []).filter(otherPath => writes.some(candidate => overlaps([candidate],[otherPath]))).map(otherPath => path.resolve(workspace,otherPath));
              throw new Error(`task-dispatch: overlapping writes/deployment owned by ${other.childID ?? other.workKey}; requested paths: ${requestedPaths.join(', ')}; conflicting paths: ${conflictingPaths.join(', ')}; wait for that owner and collect its evidence. Recovery: ${JSON.stringify(recovery(sessions,other.childID,context.sessionID,state.records))}`);
            }
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
        let retainedCompactionEvidence;
        if (input.compact) {
          if (staleRebind) throw new Error('task-dispatch: deliver the current intent to this same child before compaction; compaction cannot rebind stale intent');
          if (!requested || !checkpoint || !ctx.session?.compact) throw new Error('task-dispatch: compaction requires an existing worker, retained checkpoint and supported native compact API');
          if (sessions.some(s=>s.active&&(s.id===requested||descendant(sessions,s.id,requested)))) throw new Error('task-dispatch: wait for this worker and its descendants before checkpoint compaction');
          if (!child.lastAssistantID || child.lastAssistantID===record.compactedThrough) throw new Error('task-dispatch: no new observed context to compact');
          if (record.completionBinding?.background) {
            if (!hasRetainedCompactionEvidence(record,requested)) {
              if (record.state === 'awaiting_recovery' && record.compactionOutcome?.id === record.compactionID && record.compactionOutcome?.status === 'failed') throw new Error('task-dispatch: compaction recovery source evidence is unavailable or mismatched; inspect the retained source receipt; do not collect a compaction-only generation as a task result');
              if (record.state !== 'completed') throw new Error('task-dispatch: collect the current background generation before compaction; preserve its exact terminal receipt');
              await validateBackgroundReceipt(record,child,loadCompletionReceipt,'compaction');
            }
            retainedCompactionEvidence=compactionSourceEvidence(record,requested);
          }
        }
        const contextAdvice=checkpointStatus(record,now(),{knownContext:observedContext(child,contextCatalog)})?.highContext;
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
        Object.assign(record,{ agent:input.agent,operation:input.operation,intentRevision:intent?.revision,checkIds:intent?input.checkIds:undefined,writePaths:writes,childID:requested,inFlight:token,ownerPid:process.pid,description:input.description,startedAt:Date.now(),state:'starting',updatedAt:Date.now(),admissionGeneration:generation,progressCheckpoint:undefined,terminalSettlement:undefined,publication:input.operation === 'publish' ? { revision: input.publication.revision, checkout: publicationScope.checkout } : undefined,compactionSourceEvidence:input.compact?retainedCompactionEvidence:undefined,
          ...(externalGrant ? { externalWrites, externalGrant:{grantID:externalGrant.grantID,externalRoot:externalGrant.externalRoot} } : { externalWrites:[], externalGrant:undefined }) });
        if (!input.compact) beginHandoffTiming(record,generation,now());
        beginCheckpoint(record, checkpoint, now());
        const canonicalWorkspace=await canonicalWriterPath(workspace);
        const localAbsolute=await Promise.all(writes.map(relative=>canonicalWriterPath(path.resolve(workspace,relative))));
        if (localAbsolute.some(absolute=>absolute!==canonicalWorkspace&&!absolute.startsWith(canonicalWorkspace+path.sep)))
          throw new Error('task-dispatch: local write path escapes canonical workspace; an explicit external grant is required');
        const absoluteWrites=[...localAbsolute,...externalWrites];
        if (absoluteWrites.length) {
          reserveWriterLease(globalState,{token,workspace:canonicalWorkspace,key,parentID:context.sessionID,childID:requested,paths:absoluteWrites,ownerPid:process.pid},
            {sessions,delegatedOwner:lease=>lease.childID===context.sessionID || (lease.childID&&descendant(sessions,context.sessionID,lease.childID))});
          await saveGlobal();
        }
        await save(); return { key,childID:requested,intent,fullIntent,convergence,routing,contextAdvice,lastAssistantID:child?.lastAssistantID,retainedCompactionEvidence,generation,restoreBinding,writerLease:absoluteWrites.length>0 };
       }); } catch(error) {
         // Native execution has not begun. Remove only this admission's provisional reservation.
         if (globalState.leases?.some(lease=>lease.token===token)) { globalState.leases=globalState.leases.filter(lease=>lease.token!==token);await saveGlobal(); }
         throw error;
       }
      });
      if (admission.existing) return { content:`Existing child ${admission.existing} is still running or awaiting its admitted compaction outcome. ${guidance}`, metadata:{sessionID:admission.existing,status:'running'}, output:{sessionID:admission.existing,status:'running',output:'Existing worker retained; no duplicate was launched.'} };
      const update = async (patch, accepted = false) => globalRegistry('all-writers',async(globalState,saveGlobal)=>registry(workspace,async(state,save)=> {
        const r=state.records.find(r=>r.key===admission.key);
        // The parent cancelled this generation: its record and leases are already released.
        if(r?.state==='cancelled'&&r.cancellation?.generation===admission.generation) return;
        if(r?.inFlight!==token) throw new Error('task-dispatch: ownership changed unexpectedly');
        if(admission.writerLease) {
          const lease=globalState.leases?.find(item=>item.token===token);
          if(!lease) throw new Error('task-dispatch: global writer lease changed unexpectedly');
          if(patch.childID)lease.childID=patch.childID;
          if(patch.inFlight===null) {
            // An explicit native permission rejection before any child exists
            // proves this reservation never became a writer. Ambiguous errors
            // retain their reservation for operator reconciliation.
            if(patch.denial?.category==='native_permission' && !lease.childID)
              globalState.leases=globalState.leases.filter(item=>item.token!==token);
            else finishWriterLease(globalState,token,{childID:patch.childID??lease.childID});
          }
          await saveGlobal();
        }
        Object.assign(r,patch,{updatedAt:Date.now()});
        if (accepted) acceptHandoffTiming(r,admission.generation,r.childID,now());
        await save();
      }));
      let observed = admission.childID;
      let compactionID, pendingDelivery;
      const visible = workerProgress.attach(context.progress ?? (async () => {}));
      try {
        if (input.compact) {
          compactionID='msg_'+crypto.randomUUID().replaceAll('-','');
          await update({state:'compacting',compactionID,compactionOutcome:undefined,compactionFailed:undefined,continuationOwnerID:admission.childID,compactionSourceEvidence:admission.retainedCompactionEvidence?{...admission.retainedCompactionEvidence,compactionID}:undefined});
          await ctx.session.compact({sessionID:admission.childID,id:compactionID});
          await update({state:'compacting',inFlight:null,compactedThrough:admission.lastAssistantID,deliveredIntentRevision:undefined,deliveredCheckIds:undefined});
          const waited = await waitForCompactionIdle(ctx.session,admission.childID);
          let terminal;
          if (waited === 'idle') {
            // Load outside the lock; an unrelated native ID or a new admission
            // must never settle the operation whose parent call is waiting.
            const snapshot = await loadSessions().catch(()=>[]);
            const child = snapshot.find(item=>item.id===admission.childID);
            terminal = await registry(workspace,async(state,save)=>{
              const record=state.records.find(item=>item.key===admission.key);
              if (!record || record.admissionGeneration!==admission.generation || record.childID!==admission.childID || record.compactionID!==compactionID || child?.active!==false) return;
              if (reconcileCompaction(record,child,now)) await save();
              if (record.compactionOutcome?.id===compactionID && ['awaiting_continuation','awaiting_recovery'].includes(record.state))
                return {state:record.state,status:record.compactionOutcome.status};
            });
          }
          if (terminal) return {content:terminal.status==='completed'
            ? 'Exact native compaction completed and this same child is idle, awaiting continuation, not task completion. Continue the next authorized implementation step now through normal same-child admission with refreshed full intent; retain ownership, current checks and every permission/financial gate. No replacement or inference was started by this wait.'
            : 'Exact native compaction failed. Preserve this child and failure evidence; inspect the recorded recovery requirements. No retry, replacement or inference was started by this wait.',
            metadata:{sessionID:admission.childID,status:terminal.state,compactionID,generation:admission.generation}};
          return {content:'Native same-session compaction remains unverified after a bounded wait. Inspect its exact outcome at the next recovery boundary; do not infer completion, retry compaction or launch a replacement.',metadata:{sessionID:admission.childID,status:'compacting',compactionID,generation:admission.generation,wait:waited}};
        }
        const handoff = !admission.intent ? input.prompt : admission.fullIntent
          ? `${renderIntent(admission.intent,input.checkIds)}\n\nWorker assignment:\n${input.prompt}`
          : `${renderIntentReference(admission.intent,input.checkIds)}\n\nNext action:\n${input.prompt}`;
        const marker=`task-dispatch-generation-${crypto.randomUUID()}`;
        const publicationHandoff = input.operation === 'publish' ? `\n\nPublication binding: publish only frozen commit ${input.publication.revision} from checkout ${publicationScope.checkout}, never HEAD. Use a non-force push, let repository hooks run, and preserve native permission prompts, denials, and history. This scope coordination does not authorize a command or any new workspace access.` : '';
        const baseHandoff = `${handoff}${publicationHandoff}\n\n${checkpointHandoff(checkpoint)}${admission.contextAdvice ? "\nHigh context: at the next completed boundary retain a concise checkpoint and ask the parent for same-session compact:true before further substantial work. Do not request compaction while tools are active or for a final completion-only report." : ""}`;
        const markedHandoff = `${baseHandoff}\n\nDispatch completion marker: ${marker}`;
        const boundedHandoff = admission.convergence ? `${markedHandoff}\n\nConvergence advisory: ${admission.convergence.advisory}` : markedHandoff;
        const promptHash=crypto.createHash('sha256').update(boundedHandoff).digest('hex');
        const prefixedPromptHash=crypto.createHash('sha256').update(`You are a subagent spawned by another session.\n${boundedHandoff}`).digest('hex');
        const completionBinding={generation:admission.generation,marker,promptHash,prefixedPromptHash,background:backgroundDispatch(input)};
        pendingDelivery={generation:admission.generation,status:'pending',mode:completionBinding.background?'background':'foreground',parentID:context.sessionID,
          ...(typeof context.messageID==='string'?{messageID:context.messageID}:{}),...(typeof context.id==='string'?{callID:context.id}:{}),since:now(),
          marker,promptHash:`${promptHash},${prefixedPromptHash}`,agent:input.agent,description:input.description,taskId:input.taskId,workKey:input.workKey};
        // A bounded copy of the assignment survives a later mid-run compaction (never exported by status).
        await update({completionBinding,completionReceipt:undefined,resultDelivery:pendingDelivery,handoffBrief:typeof input.prompt==='string'?{generation:admission.generation,text:input.prompt.slice(0,BRIEF_LIMIT)}:undefined});
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
          await update({childID:observed,state:'denied',denial:receipt(denied,input),inFlight:null,resultDelivery:{...pendingDelivery,status:'not_applicable'},...(admission.restoreBinding ?? {})});
          pendingDelivery=undefined;
          return {...result,content:`task-dispatch: native ${denied} recorded. ${denialAdvice(denied)}`,metadata:{...(result?.metadata??{}),denial:{category:denied}}};
        }
        // A foreground return is the child's final report. Retain a bounded copy
        // with the exact generation so a lost tool result can be collected later.
        const status=nativeStatus(result), background=status==='running';
        const report=background?undefined:boundedReport(nativeReport(result));
        const identity={taskId:input.taskId,workKey:input.workKey,sessionID:observed,agent:input.agent,generation:admission.generation};
        const collect=collectArguments(identity);
        const foregroundResult=report&&observed?{generation:admission.generation,sessionID:observed,status,output:report.text,truncated:report.truncated,length:report.length,completedAt:now()}:undefined;
        await update({childID:observed,state:result?.metadata?.status ?? result?.output?.status ?? 'completed',denial:undefined,deliveredIntentRevision:admission.intent?.revision,deliveredCheckIds:admission.intent?input.checkIds:undefined,inFlight:null,foregroundResult,resultDelivery:{...pendingDelivery,mode:background?'background':'foreground',toolReturned:true,returnedAt:now()}},true);
        const body=background
          ? (nativeReport(result) || `The subagent is working in the background (sessionID: ${observed}).`)
          : `<subagent sessionID="${observed}" state="${status}" agent="${input.agent}" generation="${admission.generation}">\n${report.text}\n</subagent>`;
        const note=background
          ? `Harness handoff admitted in background: ${JSON.stringify({...identity,status,mode:'background'})}. Continue non-overlapping work; after the completion notice call task_dispatch_collect(${JSON.stringify(collect)}).`
          : `Harness handoff completed in foreground: ${JSON.stringify({...identity,status,mode:'foreground',truncated:report.truncated})}. The child's final report is above; re-read it with task_dispatch_collect(${JSON.stringify(collect)}).`;
        return {...result, content:`${body}\n\n${note}`,
          ...(observed?{output:{sessionID:observed,status,output:background?(typeof result?.output?.output==='string'?result.output.output:body):report.text}}:{}),
          metadata:jsonMetadata({...(result?.metadata ?? {}),...identity,status,mode:background?'background':'foreground',collect,routing:admission.routing,...(admission.contextAdvice?{contextAdvice:admission.contextAdvice}:{}),...(admission.convergence?{convergence:admission.convergence}:{})})};
      } catch(error) {
        const denied = admissionDenial(error);
        // An aborted or interrupted wait still owes the parent the child's real outcome.
        const delivery = pendingDelivery && (denied || !observed ? {...pendingDelivery,status:'not_applicable'} : {...pendingDelivery,toolReturned:false,returnedAt:now()});
        if (delivery?.status==='not_applicable') pendingDelivery=undefined;
        await update({...(denied ? {childID:observed,state:'denied',denial:receipt(denied,input),inFlight:null,...(admission.restoreBinding ?? {})} : {childID:observed,state:observed?'paused':'not_started',inFlight:null,...(admission.restoreBinding ?? {})}),...(delivery?{resultDelivery:delivery}:{})});
        try { await queueQuotaRecovery({error,parentID:context.sessionID,childID:observed,generation:admission.generation,requestKind:input.compact?'compaction':'dispatch',compactionID}); } catch { /* recovery reporting cannot replace the native admission failure */ }
        // Preserve original permission/guard error; never retry, change provider, or replace the child here.
        throw error;
      } finally {
        visible.close();
        if (pendingDelivery) resultDelivery.track(admission.key,admission.generation);
      }
    };
    if (typeof editor.update !== 'function') throw new Error('task-dispatch: native tool transformation unavailable');
    editor.update('subagent',tool=>{
      // Built-in agents use the stock subagent schema.  Harness roles enter
      // through task_dispatch (or a harness-shaped call) and retain the full
      // durable ownership contract.
      tool.description+=`\nHarness callers use task_dispatch for ownership and capability checks. ${INTENT_FIRST_HELP} ${guidance}`;
      const {prompt:harnessPrompt,...harnessFields}=schema.properties,{prompt:_stockPrompt,...stockFields}=stockInput.properties ?? {};
      tool.input={type:'object',additionalProperties:false,properties:{...stockFields,...harnessFields,prompt:harnessPrompt},required:stockInput.required ?? ['agent','description','prompt']};
      tool.execute=async(input,context)=>{
        if (isNativeAgent(context?.agent) && !isHarnessDispatchInput(input)) {
          await guardNativeDispatch({ registry, workspace, loadSessions, context, input, lineage });
          return rawExecute(input,context);
        }
        return settleSubagentResult(await dispatch(input,context));
      };
    });
    editor.add({name:'task_dispatch_template',description:'Read the compact integration-assignment template; guidance only, no dispatch or authorization.',input:{type:'object',additionalProperties:false,properties:{kind:{type:'string',enum:['integration']}},required:['kind']},execute:async input=>{
      if (input.kind!=='integration') throw new Error('task-dispatch: unsupported assignment template; kind must be integration');
      return {content:JSON.stringify(integrationAssignmentTemplate())};
    }});
    editor.add({name:'task_dispatch',description:`Capability-checked durable handoff. ${INTENT_FIRST_HELP} For a cross-component assignment, read task_dispatch_template({kind:'integration'}) once at its planning boundary. ${guidance}`,input:schema,execute:async(input,context)=>{const {output,metadata:raw,...rendered}=await dispatch(input,context),metadata=jsonMetadata(raw);return metadata?{...rendered,metadata}:rendered;}});
    editor.add({name:'task_dispatch_cancel',description:'Recorded dispatcher only: interrupt a child this session dispatched (and its active descendants), reject their pending permission asks, record the cancellation (reason required) and release its ownership and writer leases so a new lane can be admitted. Idempotent; refuses children you did not dispatch.',input:cancelInputSchema,execute:cancelChild});
    editor.add({name:'task_dispatch_reconcile_terminal',description:'Recorded parent only: explicitly settle an exact stopped background generation after supersession or failure. Read-only native evidence plus exact ownership release; no inference, retry, new permission or current-task success. For successful current-intent results use task_dispatch_collect.',input:{type:'object',additionalProperties:false,properties:{taskId:{type:'string',minLength:1},workKey:{type:'string',minLength:1},sessionID:{type:'string',minLength:1},generation:{type:'integer',minimum:1}},required:['taskId','workKey','sessionID','generation']},execute:settleTerminal});
    // A foreground handoff returns its report inline. Retain an exact,
    // bounded copy so the parent can recover it when that result was lost.
    const collectForeground=async({record,binding,child,input,save})=>{
      const respond=(result,receipt)=>({content:JSON.stringify({sessionID:input.sessionID,generation:input.generation,mode:'foreground',status:result.status,truncated:result.truncated,output:result.output,...(receipt?{receipt}:{})}),
        metadata:{sessionID:input.sessionID,generation:input.generation,mode:'foreground',status:result.status}});
      const retained=record.foregroundResult;
      if (retained?.generation===input.generation && retained.sessionID===input.sessionID) return respond(retained);
      if (record.inFlight || child?.active) throw new Error(`task-dispatch: foreground generation ${input.generation} is still running; its final report is returned by the original task_dispatch/subagent call. Wait for that call; do not relaunch, steer or poll the child.`);
      const receipt=await loadCompletionReceipt({sessionID:input.sessionID,marker:binding.marker,promptHash:`${binding.promptHash},${binding.prefixedPromptHash}`});
      if (!receipt?.assistantID) throw new Error(`task-dispatch: no exact terminal receipt exists for foreground generation ${input.generation}; the child has not finished this assignment with a final answer. Inspect task_dispatch_status; continue the same child with sessionID only if work remains.`);
      const final=await loadFinalText({sessionID:input.sessionID,assistantID:receipt.assistantID});
      if (typeof final?.text!=='string') throw new Error(`task-dispatch: the terminal answer for foreground generation ${input.generation} is unavailable; inspect the child session directly`);
      const report=boundedReport(final.text);
      const identity={promptID:receipt.promptID,assistantID:receipt.assistantID,idleID:receipt.idleID,...(receipt.completedAt?{completedAt:receipt.completedAt}:{})};
      record.foregroundResult={generation:input.generation,sessionID:input.sessionID,status:'completed',output:report.text,truncated:report.truncated||final.truncated===true,length:Math.max(report.length,final.length??0),completedAt:receipt.completedAt??now(),receipt:identity};
      record.updatedAt=Date.now();await save();
      return respond(record.foregroundResult,identity);
    };
    editor.add({name:'task_dispatch_collect',description:'Collect one admitted generation without inference: a background generation returns its exact terminal receipt; a foreground generation returns its bounded final report (also when the original handoff result was lost). Legacy or unbound generations are not collectable.',input:{type:'object',additionalProperties:false,properties:{taskId:{type:'string',minLength:1},workKey:{type:'string',minLength:1},sessionID:{type:'string',minLength:1},generation:{type:'integer',minimum:1}},required:['taskId','workKey','sessionID','generation']},execute:async(input,context)=>registry(workspace,async(state,save)=>{
      const sessions=await loadSessions(),rootID=lineage(sessions,context.sessionID),key=`${rootID}\0${input.taskId}\0${input.workKey}`,record=state.records.find(r=>r.key===key),child=sessions.find(s=>s.id===input.sessionID);
      if (!record || record.parentID!==context.sessionID || record.childID!==input.sessionID || record.admissionGeneration!==input.generation) throw new Error('task-dispatch: collection must name the recorded parent, task, work key, child, and generation exactly');
      const binding=record.completionBinding,current=getIntent(state,rootID,input.taskId);
      if (!binding || binding.generation!==input.generation) throw new Error(`task-dispatch: generation ${input.generation} has no completion binding (it never reached native delivery or predates result binding); inspect task_dispatch_status and do not rerun completed work`);
      if (!binding.background) return collectForeground({record,binding,child,input,save});
      if (record.state==='completed' && record.completionReceipt?.generation===input.generation) return {content:JSON.stringify({sessionID:input.sessionID,generation:input.generation,status:'completed',receipt:record.completionReceipt})};
      if (!collectionEligibility({record,child,sessions,rootID,current,callerID:context.sessionID}).eligible) throw new Error('task-dispatch: generation is not at a collectable terminal boundary');
      const receipt=await loadCompletionReceipt({sessionID:input.sessionID,marker:binding.marker,promptHash:`${binding.promptHash},${binding.prefixedPromptHash}`});
      if (!receipt) throw new Error('task-dispatch: no exact terminal receipt exists for this background generation; idle alone is not completion');
      record.state='completed';record.completionReceipt={generation:input.generation,marker:binding.marker,promptHash:binding.promptHash,...receipt};record.updatedAt=Date.now();collectHandoffTiming(record,record.completionReceipt,now());await save();
      return {content:JSON.stringify({sessionID:input.sessionID,generation:input.generation,status:'completed',receipt:record.completionReceipt})};
    })});
    editor.add({name:'task_intent',description:'Read or revise the shared user outcome for this root task. Root callers should set it before the first task_dispatch/subagent handoff of a taskId (recommended; otherwise the handoff infers one, marked inferred:true, which a set with expectedRevision 0 or its revision replaces); the handoff then passes intentRevision (current.revision) and checkIds. Get returns valid root user-message IDs. Only the root goal owner may set; use expectedRevision to avoid overwriting corrections. Never store secret values.',input:{type:'object',additionalProperties:false,properties:{taskId:{type:'string',minLength:1,maxLength:128},action:{type:'string',enum:['get','set']},expectedRevision:{type:'integer',minimum:0},intent:intentSchema},required:['taskId','action']},execute:async(input,context)=>registry(workspace,async(state,save)=>{
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
    editor.add({name:'task_dispatch_status',description:'Read durable ownership, collection and nextDispatch.workReview requirements without launching or resuming work. Check summary:true at continuation boundaries; include any due workReview in the next idle dispatch.',input:{type:'object',additionalProperties:false,properties:{taskId:{type:'string'},summary:{type:'boolean'}}},execute:async(input,context)=>registry(workspace,async(state,save)=>{
      const sessions=await loadSessions(),rootID=lineage(sessions,context.sessionID);
      const contextCatalog=await readContextCatalog(ctx);
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
      const owners=state.records.filter(r=>r.rootID===rootID&&(!input.taskId||r.taskId===input.taskId)).map(r=>{const native=sessions.find(s=>s.id===r.childID),current=getIntent(state,rootID,r.taskId),rebind=rebindRecovery(r,current),terminalBlocked=terminalSettlementEligibility(r,native,sessions,context.sessionID),eligibility=collectionEligibility({record:r,child:native,sessions,rootID,current,callerID:context.sessionID}),awaiting=r.state==='running'&&native?.active===false,terminalEvidenceVerified=r.state==='completed'&&r.completionReceipt?.generation===r.admissionGeneration&&r.completionBinding?.background&&r.completionBinding.generation===r.admissionGeneration;return {...r,...workerObservation(r,native,current,state.records,now()),key:undefined,foregroundResult:undefined,handoffTimings:undefined,handoffBrief:undefined,midRunCompaction:midRunCompactionStatus(r),resultDelivery:r.resultDelivery?Object.fromEntries(['generation','status','mode','via','outcome','reason','deliveredAt'].filter(k=>r.resultDelivery[k]!==undefined).map(k=>[k,r.resultDelivery[k]])):undefined,timing:handoffTimingStatus(r),nextDispatch:{workReview:dispatchReviewRequirement(r,taskWorkStatus(state,rootID,r.taskId),now())},recordedState:r.state,effectiveState:awaiting?'awaiting_result_collection':r.state,collection:r.completionBinding?.background?{action:'task_dispatch_collect',eligibleForInspection:eligibility.eligible,blockedReason:eligibility.eligible?undefined:eligibility.blockedReason,responsibleParentID:r.parentID,terminalEvidenceVerified,taskId:r.taskId,workKey:r.workKey,sessionID:r.childID,generation:r.admissionGeneration}:r.completionBinding?.generation===r.admissionGeneration&&r.childID?{action:'task_dispatch_collect',mode:'foreground',eligibleForInspection:!r.inFlight&&native?.active!==true,resultRetained:r.foregroundResult?.generation===r.admissionGeneration,responsibleParentID:r.parentID,taskId:r.taskId,workKey:r.workKey,sessionID:r.childID,generation:r.admissionGeneration}:undefined,terminalReconciliation:r.completionBinding?.background?{action:'task_dispatch_reconcile_terminal',eligibleForInspection:!terminalBlocked,blockedReason:terminalBlocked,responsibleParentID:r.parentID,generation:r.admissionGeneration,...(r.terminalSettlement?.generation===r.admissionGeneration?{outcome:r.terminalSettlement.receipt.outcome,acceptedForCurrentIntent:false}: {})}:undefined,nativeExecution:{active:native?.active??null,lastIdleOutcome:native?.lastIdleOutcome},context:contextMaintenance(r,native,{callerID:context.sessionID,activeDescendants:sessions.filter(s=>s.active&&s.id!==r.childID&&descendant(sessions,s.id,r.childID)).map(s=>s.id),compactionAvailable:typeof ctx.session?.compact==='function',needsRebind:!!rebind,catalog:contextCatalog}),workCheckpoint:checkpointStatus(r,now(),{knownContext:observedContext(native,contextCatalog)}),verificationAttempt:r.attemptIntentRevision===current?.revision?attemptStatus(r,now()):undefined,convergence:convergenceAdvice(r),inFlight:!!r.inFlight,denial:r.denial?{category:r.denial.category,action:denialAdvice(r.denial.category)}:undefined,needsRebind:!!rebind,rebind,continuationOwner:['awaiting_continuation','awaiting_recovery'].includes(r.state)?{...(r.continuationOwner ?? {parentID:r.parentID,childID:r.childID}),action:r.state==='awaiting_recovery'?'recover_same_child':'resume_same_child'}:undefined,activeDescendants:sessions.filter(s=>s.active&&(s.id===r.childID||descendant(sessions,s.id,r.childID))).map(s=>s.id)};});
      const legacy=sessions.filter(s=>s.active&&lineage(sessions,s.id)===rootID&&!state.records.some(r=>r.childID===s.id)).map(({id,parentID,agent})=>({id,parentID,agent}));
      const workspaceBlockers=sessions.filter(s=>s.active&&s.directory===workspace&&s.id!==context.sessionID&&agentsForStatus(s));
      function agentsForStatus(s) { return canonicalHarnessRole(s.agent) !== 'router' && !descendant(sessions,context.sessionID,s.id); }
      const currentRecovery = entry => state.records.some(r => r.rootID===rootID && r.parentID===entry.target.parentID && r.childID===entry.target.childID && r.admissionGeneration===entry.target.generation);
      const self=sessions.find(s=>s.id===context.sessionID);
      const status={owners,rootProgress:rootProgressStatus(self,now()),selfContext:observedContext(self,contextCatalog),quotaRecoveryPending:pendingQuotaRecovery(state).filter(currentRecovery),taskWork:input.taskId?taskWorkStatus(state,rootID,input.taskId):undefined,userActions:state.records.filter(r=>r.rootID===rootID&&(!input.taskId||r.taskId===input.taskId)).flatMap(r=>userActions([r],getIntent(state,rootID,r.taskId)?.revision)),cancelledChildren:state.records.filter(r=>r.rootID===rootID&&r.state==='cancelled'&&(!input.taskId||r.taskId===input.taskId)).map(r=>({taskId:r.taskId,workKey:r.workKey,sessionID:r.childID,generation:r.cancellation?.generation,reason:r.cancellation?.reason,cancelledAt:r.cancellation?.cancelledAt,cancelledBy:r.cancellation?.cancelledBy,...(r.cancellation?.cascadeFrom?{cascadeFrom:r.cancellation.cascadeFrom}:{})})),existingUntracked:legacy,workspaceActive:workspaceBlockers.map(s=>({id:s.id,agent:s.agent,...recovery(sessions,s.id,context.sessionID,state.records)}))};
      return {content:JSON.stringify(input.summary===true?summarizeTaskDispatchStatus(status):status)};
    })});
  });
  return { resultDelivery, reconciler, dispose: () => { workerProgress.dispose(); resultDelivery.dispose(); }, outcome: async (args,call,run) => !ctx.location?.directory ? run(null) : registry(workspace,async(state,save)=>{
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
    if (owner) owner.progressCheckpoint = {intentRevision:current.revision,observedDuringGeneration:owner.admissionGeneration,status:args.status,progressState:args.progressState,dependencySessionIDs:args.progressState === 'waiting_dependency' ? [...args.dependencySessionIDs] : undefined,recordedAt:now(),selfReported:true};
    if (owner) owner.attention = args.progressState === 'needs_user_action' ? {intentRevision:current.revision,progressState:'needs_user_action',nextAction:args.blocker?.nextAction,recordedAt:Date.now(),selfReported:true} : undefined;
    evidence.lastStatus=args.status;evidence.lastScope=args.scope;state.intentEvidence[key]=evidence;await save();return answer;
  })};
}
