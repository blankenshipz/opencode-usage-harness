import { readFileSync } from 'node:fs';
import path from 'node:path';
import { managedConfigRoot } from './paths.mjs';
import { readProviderQuotas, catalogProviders } from './provider-quota.mjs';
import { readAnthropicFinancialPolicy } from './anthropic-financial-policy.mjs';
import { readSelectedClaudeUsage } from './anthropic-subscription.mjs';
import { canonicalHarnessRole, harnessRoleIDs } from './agent-mode.mjs';

export const TASK_TYPES = Object.freeze(['general','exploration','mechanical','implementation','debugging','architecture','testing','review']);
const TASK_TYPE_SET = new Set(TASK_TYPES);
const POLICY_KEYS = new Set(['version','enabled','reservePercent','roles','profiles']);
const CANDIDATE_KEYS = new Set(['ref','profile','enabled','requiresScopedQuota','taskFit']);
function policyError() { return Object.assign(new Error('ROUTING_POLICY_INVALID: routing policy is invalid'), { code: 'ROUTING_POLICY_INVALID' }); }
function taskFitError() { return Object.assign(new Error('ROUTING_TASK_FIT_UNAVAILABLE: no supported-preferred candidate is available for this task'), { code: 'ROUTING_TASK_FIT_UNAVAILABLE' }); }
function scopeQuotaError() { return Object.assign(new Error('ROUTING_QUOTA_SCOPE_UNAVAILABLE: scoped quota is ambiguous or unavailable for the configured route'), { code: 'ROUTING_QUOTA_SCOPE_UNAVAILABLE' }); }
function reviewFamilyError() { return Object.assign(new Error('ROUTING_REVIEW_FAMILY_UNAVAILABLE: a required cross-family review has no eligible different-family route'), { code: 'ROUTING_REVIEW_FAMILY_UNAVAILABLE' }); }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function validateTaskFitPolicy(policy) {
  if (!isRecord(policy)) throw policyError();
  if (Object.keys(policy).some(key => !POLICY_KEYS.has(key)) || policy.version !== 1
    || (policy.enabled !== undefined && typeof policy.enabled !== 'boolean')
    || (policy.reservePercent !== undefined && (!Number.isFinite(policy.reservePercent) || policy.reservePercent < 0 || policy.reservePercent > 10))
    || !isRecord(policy.roles)
    || (policy.profiles !== undefined && !isRecord(policy.profiles))) throw policyError();
  if (policy.profiles && Object.entries(policy.profiles).some(([name, profile]) => !/^[A-Za-z0-9._-]+$/.test(name) || !isRecord(profile))) throw policyError();
  for (const [role, candidates] of Object.entries(policy.roles)) {
    // Policies may use a configured canonical role or its visible harness-
    // alias, both of which are explicit runtime identities.
    if (canonicalHarnessRole(role) === undefined) throw policyError();
    if (!Array.isArray(candidates)) throw policyError();
    for (const candidate of candidates) {
      if (!isRecord(candidate) || Object.keys(candidate).some(key => !CANDIDATE_KEYS.has(key))
        || typeof candidate.ref!=='string' || !/^(openai|anthropic)\/[A-Za-z0-9._-]+#[A-Za-z0-9_-]+$/.test(candidate.ref)
        || (candidate.enabled !== undefined && typeof candidate.enabled !== 'boolean')
        || (candidate.requiresScopedQuota !== undefined && typeof candidate.requiresScopedQuota !== 'boolean')
        || (candidate.profile !== undefined && (typeof candidate.profile !== 'string' || !/^[A-Za-z0-9._-]+$/.test(candidate.profile)
          || (policy.profiles !== undefined && !Object.hasOwn(policy.profiles, candidate.profile)))) ) throw policyError();
      if (candidate.taskFit === undefined) continue;
      if (!isRecord(candidate.taskFit)) throw policyError();
      for (const [taskType, rule] of Object.entries(candidate.taskFit)) {
        if (!TASK_TYPE_SET.has(taskType) || !isRecord(rule)
          || !['preferred','acceptable'].includes(rule.band)
          || !['provisional','supported'].includes(rule.evidence_status)
          || Object.keys(rule).some(key=>!['band','evidence_status','evidence_ref'].includes(key))) throw policyError();
        if (rule.evidence_ref !== undefined && (typeof rule.evidence_ref !== 'string' || !rule.evidence_ref.trim() || rule.evidence_ref.length > 240 || /[\r\n\0]/.test(rule.evidence_ref))) throw policyError();
        if (rule.band === 'preferred' && rule.evidence_status === 'supported' && rule.evidence_ref === undefined) throw policyError();
      }
    }
  }
  return policy;
}
export function taskTypeFor(input) {
  if (input?.routing?.taskType !== undefined) return TASK_TYPE_SET.has(input.routing.taskType) ? input.routing.taskType : 'general';
  const role = canonicalHarnessRole(input?.agent) ?? input?.agent;
  return ({ scout:'exploration', 'quick-builder':'mechanical', builder:'implementation', 'builder-high':'implementation', 'deep-debugger':'debugging', 'deep-debugger-high':'debugging', architect:'architecture', reviewer:'review', verifier:'testing' })[role] ?? 'general';
}
function candidateFit(candidate, taskType) {
  const rule = candidate?.taskFit?.[taskType];
  const preferred = rule?.band === 'preferred' && rule?.evidence_status === 'supported' && typeof rule?.evidence_ref === 'string' && rule.evidence_ref.trim().length > 0;
  return { band: preferred ? 'preferred' : 'acceptable', evidenceStatus: preferred ? 'supported' : (rule?.evidence_status === 'supported' ? 'supported' : 'provisional'), reason: preferred ? 'supported_preferred' : 'acceptable_or_provisional' };
}
function storedTaskFit(value) {
  if (!isRecord(value) || !TASK_TYPE_SET.has(value.taskType) || !['preferred','acceptable'].includes(value.band)
    || !['provisional','supported'].includes(value.evidenceStatus)
    || !['supported_preferred','acceptable_or_provisional','continuation_affinity','no_supported_preference'].includes(value.reason)) return undefined;
  return {taskType:value.taskType,band:value.band,evidenceStatus:value.evidenceStatus,reason:value.reason};
}
function taskFitContext({ input, policy }) {
  if (policy?.version !== 1 || policy?.enabled !== true) return {taskType:taskTypeFor(input),supportedPreferred:[],strict:false};
  const role=canonicalHarnessRole(input.agent) ?? input.agent;
  const candidates=policy?.roles?.[input.agent] ?? policy?.roles?.[role];
  const taskType=taskTypeFor(input);
  const supportedPreferred=Array.isArray(candidates) ? candidates.filter(c=>isRecord(c) && c.enabled!==false && modelReference(c.ref) && candidateFit(c,taskType).band==='preferred').map(c=>c.ref) : [];
  const strict=Boolean(input.routing && (input.routing.complexity==='complex' || input.routing.risk==='high') && supportedPreferred.length);
  return {taskType,supportedPreferred,strict};
}
function selectedTaskFit({ input, policy, ref }) {
  const role=canonicalHarnessRole(input.agent) ?? input.agent;
  const candidates=policy?.roles?.[input.agent] ?? policy?.roles?.[role];
  const candidate=Array.isArray(candidates) && candidates.find(c=>isRecord(c) && c.enabled!==false && c.ref===ref);
  if (!candidate) return undefined;
  const fit=candidateFit(candidate,taskTypeFor(input));
  return {taskType:taskTypeFor(input),band:fit.band,evidenceStatus:fit.evidenceStatus,reason:fit.reason};
}

export function readRoutingPolicy({ readFile = readFileSync, policyPath = path.join(managedConfigRoot, 'routing-policy.json') } = {}) {
  try {
    return validateTaskFitPolicy(JSON.parse(readFile(policyPath, 'utf8')));
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    if (error?.code === 'ROUTING_POLICY_INVALID') throw error;
    throw policyError();
  }
}

export async function readRoutingQuota(ctx, { readPolicy=readRoutingPolicy, readQuota=readProviderQuotas,
  readAnthropicPolicy=readAnthropicFinancialPolicy } = {}) {
  const policy=readPolicy();
  let catalog;
  try { catalog = ctx ? (await ctx.model.list()).data : undefined; } catch {}
  // A local Anthropic opt-in file cannot make an OpenAI-only dispatcher fail.
  // For a dual catalog an invalid file is safe routing evidence: it withholds
  // the credit exception while preserving a healthy OpenAI candidate. The
  // Anthropic request guard still reads it directly and fails closed.
  let anthropicFinancialPolicy={mode:'subscription_only'};
  if (Array.isArray(catalog) && catalog.some(model=>model?.providerID==='anthropic')) {
    try { anthropicFinancialPolicy=readAnthropicPolicy(); }
    catch { anthropicFinancialPolicy={mode:'invalid'}; }
  }
  let quota;
  try { quota = await readQuota({ providers: catalogProviders(catalog), readClaude: () => readSelectedClaudeUsage(ctx) }); }
  catch { quota={version:1,checked_at:new Date().toISOString(),pools:{}}; }
  return { ...quota, routingPolicy: policy, anthropicFinancialPolicy, catalog };
}
export function modelReference(ref) {
  if (typeof ref === 'string') return /^[\w.-]+\/[\w./-]+(?:#[\w.-]+)?$/.test(ref) ? ref : undefined;
  if (!ref || typeof ref !== 'object') return;
  return modelReference(`${ref.providerID}/${ref.id}${ref.variant ? '#'+ref.variant : ''}`);
}
function modelParts(ref) {
  const normalized=modelReference(ref);
  const match=normalized?.match(/^([^/]+)\/([^#]+)#([^#]+)$/);
  return match ? {ref:normalized,providerID:match[1],id:match[2],variant:match[3]} : undefined;
}
function catalogHasVariant(catalog, { providerID, id, variant }) {
  return Array.isArray(catalog) && catalog.some(model => model?.providerID===providerID && model?.id===id
    && Array.isArray(model.variants) && model.variants.some(item => (typeof item==='string' ? item : item?.id)===variant));
}
function continuationEffortDecision({ input, record, child, selected, override, catalog, hasActiveDescendant=false }) {
  if (input.continuationEffort !== 'reassess') return undefined;
  const base={requested:'reassess',prior:selected,provenance:'explicit_safe_checkpoint_request'};
  if (input.model !== undefined || override) return {...base,applied:false,selected:override ?? selected,reason:'explicit_or_manual_model_override'};
  if (child?.active || hasActiveDescendant || record?.state!=='completed') return {...base,applied:false,selected,reason:'not_completed_idle_boundary'};
  if (input.routing?.reviewIndependence==='required' || record?.routing?.reviewProvenance)
    return {...base,applied:false,selected,reason:'required_review_affinity'};
  const role=canonicalHarnessRole(input.agent) ?? input.agent;
  if (role!=='builder' || input.operation!=='implement' || input.routing?.risk!=='normal' || input.routing?.complexity==='complex')
    return {...base,applied:false,selected,reason:'not_ordinary_implementation'};
  const parts=modelParts(selected);
  if (!parts || parts.variant!=='high') return {...base,applied:false,selected,reason:'selected_effort_not_high'};
  const medium={...parts,variant:'medium',ref:`${parts.providerID}/${parts.id}#medium`};
  if (!catalogHasVariant(catalog,medium)) return {...base,applied:false,selected,reason:'medium_variant_unavailable'};
  return {...base,applied:true,selected:medium.ref,reason:'same_model_medium_supported',catalog:'current_model_catalog'};
}
export function quotaPace(quota, now=Date.now(), provider='openai') {
  const checked=Date.parse(quota?.pools ? quota.pools[provider]?.checked_at : quota?.checked_at);
  if (!Number.isFinite(checked) || now-checked>120000 || checked>now+5000) return 'unknown';
  const windows=(quota.pools ? quota.pools[provider]?.windows?.filter(w=>w.scope==='account')??[] : provider==='openai' ? (quota.buckets??[]).flatMap(b=>b.windows??[]) : []).filter(w=>Number.isFinite(w.pace_delta));
  if (!windows.length) return 'unknown';
  if (windows.some(w=>w.pace_delta>10
    || (w.remaining_percent<=10 && (!Number.isFinite(w.duration_minutes) || w.duration_minutes<10080)))) return 'ahead';
  if (windows.every(w=>w.pace_delta < -10)) return 'behind';
  return 'normal';
}
// Model selection does not grant provider access or bypass the subscription guard.
export function selectDispatchModel({input,agent,agents,record,child,quota,hasActiveDescendant=false}) {
  const configured=modelReference(agent.model), observed=modelReference(child?.model);
  const explicit=modelReference(input.model);
  const reviewModel=modelReference(input.routing?.reviewProvenance?.model) ?? modelReference(input.routing?.reviewOf);
  const reviewProvider=reviewModel?.split('/')[0];
  const requiredCrossFamily=input.routing?.reviewIndependence==='required';
  const requireIndependent=selected => {
    if (requiredCrossFamily && (!reviewProvider || selected?.split('/')[0]===reviewProvider)) throw reviewFamilyError();
    return selected;
  };
  if (input.model!==undefined && !explicit) throw new Error('task-dispatch: invalid explicit model reference');
  if (input.resetModel!==undefined && typeof input.resetModel!=='boolean') throw new Error('task-dispatch: invalid resetModel');
  let override=input.resetModel ? undefined : record?.modelOverride;
  // Detect a direct UI/manual switch after a known harness selection. Legacy
  // sessions have no provenance; their next dispatch adopts the configured role.
  if (!input.resetModel && observed && record?.routing?.selected && observed!==record.routing.selected) override=observed;
  override=explicit??override;
  const pace=quotaPace(quota,Date.now(),configured?.split('/')[0]);
  // A verified required review keeps its admitted reviewer route through a
  // continuation, including an explicit model that was already admitted.
  if (requiredCrossFamily && record?.routing?.reviewProvenance && record.routing?.selected) {
    const persistedFit=storedTaskFit(record.routing.taskFit);
    const effortDecision=continuationEffortDecision({input,record,child,selected:record.routing.selected,override,catalog:quota?.catalog,hasActiveDescendant});
    return {selected:requireIndependent(record.routing.selected),configured,observed,source:'continuation_affinity',pace,modelOverride:override,...(persistedFit ? {taskFit:persistedFit} : {}),...(effortDecision ? {effortDecision} : {})};
  }
  // A user or observed manual model remains authoritative even at a safe
  // boundary.  Keep the reassessment receipt so the retained effort is auditable.
  if (input.continuationEffort==='reassess' && record?.routing?.selected && override) {
    const effortDecision=continuationEffortDecision({input,record,child,selected:record.routing.selected,override,catalog:quota?.catalog,hasActiveDescendant});
    return {selected:requireIndependent(override),configured,observed,source:'explicit_override',pace,modelOverride:override,...(effortDecision ? {effortDecision} : {})};
  }
  let selected=override??configured, source=override?'explicit_override':'configured_role';
  // Never reinterpret an admitted generation or change its provider on retry.
  if (!override && record?.routing?.selected) {
    const persistedFit=storedTaskFit(record.routing.taskFit);
    const effortDecision=continuationEffortDecision({input,record,child,selected:record.routing.selected,override,catalog:quota?.catalog,hasActiveDescendant});
    const selected=effortDecision?.selected ?? record.routing.selected;
    return {selected:requireIndependent(selected),configured,observed,source:effortDecision?.applied?'safe_checkpoint_effort':'continuation_affinity',pace,modelOverride:override,...(persistedFit ? {taskFit:persistedFit} : {}),...(effortDecision ? {effortDecision} : {})};
  }
  // Required independence is an admission constraint, rather than a diversity
  // preference.  It may only use a currently eligible policy candidate; a
  // configured role or override must not silently bypass an unhealthy peer.
  if (requiredCrossFamily) {
    let decision;
    if (explicit) {
      const policy=quota?.routingPolicy, role=canonicalHarnessRole(input.agent) ?? input.agent;
      const candidates=policy?.roles?.[input.agent] ?? policy?.roles?.[role];
      const candidate=Array.isArray(candidates) && candidates.find(item=>item?.ref===explicit);
      if (!candidate) throw reviewFamilyError();
      const explicitPolicy={...policy,roles:{...policy.roles,[input.agent]:[candidate]}};
      decision=chooseCandidate({input,quota:{...quota,routingPolicy:explicitPolicy}});
    } else decision=chooseCandidate({input,quota});
    if (!decision) throw reviewFamilyError();
    return {selected:decision.ref,configured,observed,source:decision.reason,pace:decision.pace,
      modelOverride:explicit,behaviorProfile:decision.profile,reviewOf:input.routing?.reviewOf ?? null,
      poolPacing:decision.pacing,taskFit:decision.taskFit,explanation:decision.explanation};
  }
  const decision = !override && chooseCandidate({input, quota});
  if (decision) return {selected:requireIndependent(decision.ref),configured,observed,source:decision.reason,pace:decision.pace,
    modelOverride:override,behaviorProfile:decision.profile,reviewOf:input.routing?.reviewOf ?? null,
    poolPacing:decision.pacing,taskFit:decision.taskFit,explanation:decision.explanation};
  const fitContext=!override && taskFitContext({input,policy:quota?.routingPolicy});
  if (fitContext?.strict && !fitContext.supportedPreferred.includes(configured)) throw taskFitError();
  const role=canonicalHarnessRole(input.agent);
  if (!override && input.routing?.complexity==='routine' && input.routing?.risk==='normal' && pace==='ahead' && ['builder','deep-debugger'].includes(role)) {
    const fast=modelReference(agents.find(a=>harnessRoleIDs('quick-builder').includes(a.id??a.name))?.model);
    // Never cross providers as a pacing fallback. The worker retains its role,
    // permissions, ownership and required capabilities; only inference changes.
    if (fast && configured && fast.split('/')[0]===configured.split('/')[0]
      && (!fitContext?.strict || fitContext.supportedPreferred.includes(fast))) {selected=fast;source='pace_routine';}
  }
  if (!override && input.routing && quota?.routingPolicy?.version===1 && quota.routingPolicy.enabled===true
    && scopedQuotaUnavailable(selected,quota,Number.isFinite(quota.routingPolicy.reservePercent) ? quota.routingPolicy.reservePercent : 2)) throw scopeQuotaError();
  const fallbackFit=!override && selectedTaskFit({input,policy:quota?.routingPolicy,ref:selected});
  return {selected:requireIndependent(selected),configured,observed,source,pace,modelOverride:override,...(!override ? {taskFit:fallbackFit ?? {taskType:taskTypeFor(input),band:'acceptable',evidenceStatus:'provisional',reason:'no_supported_preference'}} : {})};
}


function canonicalScopeName(value) {
  if (typeof value !== 'string') return undefined;
  const canonical=value.toLowerCase().replace(/[^a-z0-9]/g,'');
  return canonical || undefined;
}
function scopedNamesForReference(ref) {
  const [provider, rawModel] = ref.split('/',2);
  const bareModel=rawModel?.split('#')[0];
  const model=canonicalScopeName(bareModel);
  if (!model) return [];
  const names=[model];
  // Anthropic usage reports a reviewed model-family label (for example
  // "Fable") while its catalog entry is a versioned claude-fable-* ID. This
  // structural adapter is deliberately bounded; it is not fuzzy matching or a
  // capability ranking.
  const family=provider==='anthropic' && bareModel?.match(/^claude-([A-Za-z0-9]+)-\d+(?:-\d+)*$/i)?.[1];
  const canonicalFamily=canonicalScopeName(family);
  if (canonicalFamily) names.push(canonicalFamily);
  return names;
}
function knownScopeNames(catalog, provider) {
  if (!Array.isArray(catalog)) return new Set();
  return new Set(catalog.filter(model=>model?.providerID===provider)
    .flatMap(model=>scopedNamesForReference(`${provider}/${model.id}`)));
}
function scopeRelation(window, ref, catalog) {
  if (window.scope === 'account') return 'applicable';
  const [provider]=ref.split('/',1), labels=[window.model,window.model_family].map(canonicalScopeName).filter(Boolean);
  if (!labels.length) return 'ambiguous';
  const models=scopedNamesForReference(ref);
  if (labels.some(label=>models.includes(label))) return 'applicable';
  return labels.every(label=>knownScopeNames(catalog,provider).has(label)) ? 'unrelated' : 'ambiguous';
}
function scopedQuotaUnavailable(ref, quota, reserve) {
  const provider=ref?.split('/')[0], pool=quota?.pools?.[provider];
  if (!pool || !Array.isArray(pool.windows)) return false;
  const now=Date.now();
  for (const window of pool.windows) {
    const relation=scopeRelation(window,ref,quota.catalog);
    if (relation==='ambiguous') return true;
    if (relation==='applicable' && window.scope!=='account'
      && (!Number.isFinite(window.used_percent) || window.used_percent>=100-reserve || window.locked_reason
        || timestamp(window.resets_at)===null || timestamp(window.resets_at)<=now)) return true;
  }
  return false;
}
function timestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function weeklyPacingWindows(windows, now) {
  // A weekly pace is useful only when its normalized duration and reset establish
  // an allowance cycle (the normalizer labels inferred durations). Do not manufacture a pace from incomplete data.
  return windows.filter(w => Number.isFinite(w.pace_delta)
    && Number.isFinite(w.duration_minutes) && w.duration_minutes >= 10080
    && timestamp(w.resets_at) !== null && timestamp(w.resets_at) > now);
}
function candidateState(candidate, quota, reserve) {
  const provider = candidate.ref.split('/')[0], pool = quota?.pools?.[provider];
  if (provider === 'anthropic' && quota?.anthropicFinancialPolicy?.mode === 'invalid') return;
  const now=Date.now(), checked = Date.parse(pool?.checked_at);
  const creditMode=provider === 'anthropic'
    && quota?.anthropicFinancialPolicy?.mode === 'app_managed_credits'
    && pool?.financial?.extra_usage_enabled === true;
  if (!pool || (!creditMode && pool.availability !== 'available') || !Number.isFinite(checked) || now-checked > 120000 || checked>now+5000) return;
  if (provider === 'anthropic' && !creditMode && pool.financial?.extra_usage_enabled !== false) return;
  if (provider === 'openai' && pool.credit_risk !== 'none') return;
  const relations=(pool.windows ?? []).map(window=>({window,relation:scopeRelation(window,candidate.ref,quota.catalog)}));
  if (relations.some(entry=>entry.relation==='ambiguous')) return;
  const windows=relations.filter(entry=>entry.relation==='applicable').map(entry=>entry.window);
  if (!windows.length || windows.some(w => !Number.isFinite(w.used_percent) || w.locked_reason
    || timestamp(w.resets_at) === null || timestamp(w.resets_at) <= now)) return;
  const paid=creditMode && windows.some(w=>w.used_percent>=100-reserve);
  if (!paid && (pool.availability !== 'available' || windows.some(w=>w.used_percent>=100-reserve))) return;
  if (candidate.requiresScopedQuota && !windows.some(w => w.scope !== 'account')) return;
  if (Array.isArray(quota.catalog)) {
    const [key,variant] = candidate.ref.split('#'), slash=key.indexOf('/');
    const model = quota.catalog.find(m=>m.providerID===key.slice(0,slash) && m.id===key.slice(slash+1));
    if (!model || (variant && !(model.variants??[]).some(v=>(typeof v==='string'?v:v.id)===variant))) return;
  } else return; // Newly selected routes must exist in the settled runtime catalog.
  if (paid) return {score:undefined,pressure:false,pace:'unknown',paid:true,pacing:undefined};
  const deltas=windows.map(w=>w.pace_delta).filter(Number.isFinite);
  // A high weekly percentage alone is expected near a reset. Pressure comes
  // from being ahead of an applicable pace, or a genuinely short-window cap.
  const pressure=windows.some(w=>w.pace_delta>10
    || (Number.isFinite(w.duration_minutes) && w.duration_minutes<10080 && w.used_percent>=90));
  const weekly=weeklyPacingWindows(windows,now);
  // All applicable weekly caps constrain the route. The largest delta is the
  // limiting cap: it is the one furthest ahead of its own cycle target.
  const limiting=weekly.reduce((best,w)=>!best || w.pace_delta>best.pace_delta
    || (w.pace_delta===best.pace_delta && timestamp(w.resets_at)<timestamp(best.resets_at)) ? w : best,null);
  const delta=limiting?.pace_delta;
  const deficit=Math.max(0,-(delta??0));
  const reset=timestamp(limiting?.resets_at);
  const remaining=limiting ? Math.max(0,Math.min(1,(reset-now)/(limiting.duration_minutes*60_000))) : 1;
  // Spend useful behind-pace capacity before that allowance resets, without
  // allowing reset proximity to outweigh the underlying deficit by more than 2x.
  const score=limiting ? -delta + Math.min(deficit,deficit*(1-remaining)) : undefined;
  const pacing=limiting ? {provider,limitingWeeklyPaceDelta:delta,limitingWeeklyResetsAt:limiting.resets_at} : undefined;
  return {score,pressure,pace:pressure?'ahead':limiting ? (deltas.length&&deltas.every(v=>v < -10)?'behind':'normal') : 'unknown',pacing,paid:false};
}
export function chooseCandidate({input,quota}) {
  const policy=quota?.routingPolicy;
  if (policy?.version!==1 || policy.enabled!==true || !input.routing) return;
  const role=canonicalHarnessRole(input.agent) ?? input.agent;
  const candidates=policy.roles?.[input.agent] ?? policy.roles?.[role];
  if (!Array.isArray(candidates)) return;
  const fitContext=taskFitContext({input,policy});
  const reserve=Number.isFinite(policy.reservePercent)?Math.max(0,Math.min(10,policy.reservePercent)):2;
  const author=modelReference(input.routing.reviewProvenance?.model) ?? modelReference(input.routing.reviewOf), authorProvider=author?.split('/')[0];
  const requiredCrossFamily=input.routing.reviewIndependence==='required';
  const choices=candidates.flatMap((c,index)=>{
    if (!c || !modelReference(c.ref) || c.enabled===false) return [];
    // Role candidates are explicitly approved capability peers, not price-ranked.
    const state=candidateState(c,quota,reserve);if(!state)return [];
    const independent=Boolean(authorProvider && c.ref.split('/')[0]!==authorProvider);
    const fit=candidateFit(c,fitContext.taskType);
    return [{...c,...state,index,independent,fit}];
  });
  if(!choices.length) return;
  const eligible=(fitContext.strict ? choices.filter(c=>c.fit.band==='preferred') : choices)
    .filter(c=>!requiredCrossFamily || c.independent);
  if (!eligible.length) return;
  // For requested independent review, prefer a capable different family when
  // its pool is healthy; a depleted pool never wins solely for diversity.
  const routine=input.routing?.complexity==='routine' && input.routing?.risk==='normal';
  const compare=(a,b)=>(Number(a.pressure)-Number(b.pressure))
    || (routine ? 0 : (a.fit.band===b.fit.band ? 0 : a.fit.band==='preferred' ? -1 : 1))
    // Unknown weekly pace remains eligible (including a one-pool profile), but
    // cannot be treated as a neutral measured allowance when a peer is known.
    || (Number(a.pace==='unknown')-Number(b.pace==='unknown'))
    || ((b.independent&&b.pace!=='ahead'&&b.pace!=='unknown'?40:0)+(b.score ?? 0))-((a.independent&&a.pace!=='ahead'&&a.pace!=='unknown'?40:0)+(a.score ?? 0))
    || a.index-b.index;
  eligible.sort(compare);
  // Paid capacity has no synthetic pace, reserve, balance, or prepaid-score.
  // If normal ranking reaches it, a healthy included peer with the same fit
  // wins without making mixed-fit/pressure ordering non-transitive.
  const paidChoice=eligible[0];
  const chosen=paidChoice?.paid
    ? eligible.filter(choice=>!choice.paid && choice.fit.band===paidChoice.fit.band).sort(compare)[0] ?? paidChoice
    : paidChoice;
  const pressureTradeoff=!routine && chosen.fit.band==='acceptable' && choices.some(c=>c.fit.band==='preferred' && c.pressure) && !chosen.pressure;
  const explanation=fitContext.strict ? 'protected_task_fit_floor'
    : pressureTradeoff ? 'healthy_acceptable_over_pressured_preferred'
    : routine ? 'routine_quota_balance'
    : chosen.fit.band==='preferred' ? 'supported_task_fit_preference'
    : fitContext.supportedPreferred.length ? 'acceptable_when_preferred_ineligible'
    : 'no_supported_preference_quota_balance';
  return {...chosen,profile:policy.profiles?.[chosen.profile] ?? chosen.profile,reason:authorProvider&&chosen.independent?'cross_family_review':'subscription_pool_selection',
    taskFit:{taskType:fitContext.taskType,band:chosen.fit.band,evidenceStatus:chosen.fit.evidenceStatus,reason:chosen.fit.reason},
    explanation};
}
