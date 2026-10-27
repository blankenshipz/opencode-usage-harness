import { readFileSync } from 'node:fs';
import path from 'node:path';
import { managedConfigRoot } from './paths.mjs';
import { readProviderQuotas, catalogProviders } from './provider-quota.mjs';
import { readSelectedClaudeUsage } from './anthropic-subscription.mjs';
import { canonicalHarnessRole, harnessRoleIDs } from './agent-mode.mjs';

export const TASK_TYPES = Object.freeze(['general','exploration','mechanical','implementation','debugging','architecture','testing','review']);
const TASK_TYPE_SET = new Set(TASK_TYPES);
function policyError() { return Object.assign(new Error('ROUTING_POLICY_INVALID: routing policy is invalid'), { code: 'ROUTING_POLICY_INVALID' }); }
function taskFitError() { return Object.assign(new Error('ROUTING_TASK_FIT_UNAVAILABLE: no supported-preferred candidate is available for this task'), { code: 'ROUTING_TASK_FIT_UNAVAILABLE' }); }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function validateTaskFitPolicy(policy) {
  if (!isRecord(policy)) throw policyError();
  if (policy.version !== 1 || (policy.enabled !== undefined && typeof policy.enabled !== 'boolean') || !isRecord(policy.roles)) throw policyError();
  for (const candidates of Object.values(policy.roles)) {
    if (!Array.isArray(candidates)) throw policyError();
    for (const candidate of candidates) {
      if (!isRecord(candidate) || typeof candidate.ref!=='string' || !/^(openai|anthropic)\/[A-Za-z0-9._-]+#[A-Za-z0-9_-]+$/.test(candidate.ref) || (candidate.enabled !== undefined && typeof candidate.enabled !== 'boolean')) throw policyError();
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
  return ({ scout:'exploration', 'quick-builder':'mechanical', builder:'implementation', 'builder-high':'implementation', 'deep-debugger':'debugging', 'deep-debugger-high':'debugging', architect:'architecture', reviewer:'review' })[role] ?? 'general';
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

export async function readRoutingQuota(ctx, { readPolicy=readRoutingPolicy, readQuota=readProviderQuotas } = {}) {
  const policy=readPolicy();
  let catalog;
  try { catalog = ctx ? (await ctx.model.list()).data : undefined; } catch {}
  let quota;
  try { quota = await readQuota({ providers: catalogProviders(catalog), readClaude: () => readSelectedClaudeUsage(ctx) }); }
  catch { quota={version:1,checked_at:new Date().toISOString(),pools:{}}; }
  return { ...quota, routingPolicy: policy, catalog };
}
export function modelReference(ref) {
  if (typeof ref === 'string') return /^[\w.-]+\/[\w./-]+(?:#[\w.-]+)?$/.test(ref) ? ref : undefined;
  if (!ref || typeof ref !== 'object') return;
  return modelReference(`${ref.providerID}/${ref.id}${ref.variant ? '#'+ref.variant : ''}`);
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
export function selectDispatchModel({input,agent,agents,record,child,quota}) {
  const configured=modelReference(agent.model), observed=modelReference(child?.model);
  const explicit=modelReference(input.model);
  if (input.model!==undefined && !explicit) throw new Error('task-dispatch: invalid explicit model reference');
  if (input.resetModel!==undefined && typeof input.resetModel!=='boolean') throw new Error('task-dispatch: invalid resetModel');
  let override=input.resetModel ? undefined : record?.modelOverride;
  // Detect a direct UI/manual switch after a known harness selection. Legacy
  // sessions have no provenance; their next dispatch adopts the configured role.
  if (!input.resetModel && observed && record?.routing?.selected && observed!==record.routing.selected) override=observed;
  override=explicit??override;
  const pace=quotaPace(quota,Date.now(),configured?.split('/')[0]);
  let selected=override??configured, source=override?'explicit_override':'configured_role';
  // Never reinterpret an admitted generation or change its provider on retry.
  if (!override && record?.routing?.selected) {
    const persistedFit=storedTaskFit(record.routing.taskFit);
    return {selected:record.routing.selected,configured,observed,source:'continuation_affinity',pace,modelOverride:override,...(persistedFit ? {taskFit:persistedFit} : {})};
  }
  const decision = !override && chooseCandidate({input, quota});
  if (decision) return {selected:decision.ref,configured,observed,source:decision.reason,pace:decision.pace,
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
  const fallbackFit=!override && selectedTaskFit({input,policy:quota?.routingPolicy,ref:selected});
  return {selected,configured,observed,source,pace,modelOverride:override,...(!override ? {taskFit:fallbackFit ?? {taskType:taskTypeFor(input),band:'acceptable',evidenceStatus:'provisional',reason:'no_supported_preference'}} : {})};
}


function matchesScope(window, ref) {
  if (window.scope === 'account') return true;
  const model = ref.split('/')[1]?.split('#')[0]?.toLowerCase().replace(/[^a-z0-9]/g,'') ?? '';
  const scope = (window.model_family ?? window.model ?? '').toLowerCase().replace(/[^a-z0-9]/g,'');
  return scope.length > 0 && model.includes(scope);
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
  const now=Date.now(), checked = Date.parse(pool?.checked_at);
  if (!pool || pool.availability !== 'available' || !Number.isFinite(checked) || now-checked > 120000 || checked>now+5000) return;
  if (provider === 'anthropic' && pool.financial?.extra_usage_enabled !== false) return;
  if (provider === 'openai' && pool.credit_risk !== 'none') return;
  const windows = (pool.windows ?? []).filter(w => matchesScope(w,candidate.ref));
  if (!windows.length || windows.some(w => !Number.isFinite(w.used_percent) || w.used_percent >= 100-reserve || w.locked_reason
    || timestamp(w.resets_at) === null || timestamp(w.resets_at) <= now)) return;
  if (candidate.requiresScopedQuota && !windows.some(w => w.scope !== 'account')) return;
  if (Array.isArray(quota.catalog)) {
    const [key,variant] = candidate.ref.split('#'), slash=key.indexOf('/');
    const model = quota.catalog.find(m=>m.providerID===key.slice(0,slash) && m.id===key.slice(slash+1));
    if (!model || (variant && !(model.variants??[]).some(v=>(typeof v==='string'?v:v.id)===variant))) return;
  } else return; // Newly selected routes must exist in the settled runtime catalog.
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
  const score=(delta===undefined?0:-delta) + Math.min(deficit,deficit*(1-remaining));
  const pacing=limiting ? {provider,limitingWeeklyPaceDelta:delta,limitingWeeklyResetsAt:limiting.resets_at} : undefined;
  return {score,pressure,pace:pressure?'ahead':deltas.length&&deltas.every(v=>v < -10)?'behind':'normal',pacing};
}
export function chooseCandidate({input,quota}) {
  const policy=quota?.routingPolicy;
  if (policy?.version!==1 || policy.enabled!==true || !input.routing) return;
  const role=canonicalHarnessRole(input.agent) ?? input.agent;
  const candidates=policy.roles?.[input.agent] ?? policy.roles?.[role];
  if (!Array.isArray(candidates)) return;
  const fitContext=taskFitContext({input,policy});
  const reserve=Number.isFinite(policy.reservePercent)?Math.max(0,Math.min(10,policy.reservePercent)):2;
  const author=modelReference(input.routing.reviewOf), authorProvider=author?.split('/')[0];
  const choices=candidates.flatMap((c,index)=>{
    if (!c || !modelReference(c.ref) || c.enabled===false) return [];
    // Role candidates are explicitly approved capability peers, not price-ranked.
    const state=candidateState(c,quota,reserve);if(!state)return [];
    const independent=Boolean(authorProvider && c.ref.split('/')[0]!==authorProvider);
    const fit=candidateFit(c,fitContext.taskType);
    return [{...c,...state,index,independent,fit}];
  });
  if(!choices.length) return;
  const eligible=fitContext.strict ? choices.filter(c=>c.fit.band==='preferred') : choices;
  if (!eligible.length) return;
  // For requested independent review, prefer a capable different family when
  // its pool is healthy; a depleted pool never wins solely for diversity.
  const routine=input.routing?.complexity==='routine' && input.routing?.risk==='normal';
  eligible.sort((a,b)=>(Number(a.pressure)-Number(b.pressure))
    || (routine ? 0 : (a.fit.band===b.fit.band ? 0 : a.fit.band==='preferred' ? -1 : 1))
    || ((b.independent&&b.pace!=='ahead'?40:0)+b.score)-((a.independent&&a.pace!=='ahead'?40:0)+a.score)
    || a.index-b.index);
  const chosen=eligible[0];
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
