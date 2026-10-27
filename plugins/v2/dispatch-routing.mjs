import { readFileSync } from 'node:fs';
import path from 'node:path';
import { managedConfigRoot } from './paths.mjs';
import { readProviderQuotas, catalogProviders } from './provider-quota.mjs';
import { readSelectedClaudeUsage } from './anthropic-subscription.mjs';
import { canonicalHarnessRole, harnessRoleIDs } from './agent-mode.mjs';

export async function readRoutingQuota(ctx) {
  let policy;
  try { policy = JSON.parse(readFileSync(path.join(managedConfigRoot, 'routing-policy.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('routing: invalid policy file'); }
  const catalog = ctx ? (await ctx.model.list()).data : undefined;
  const quota = await readProviderQuotas({ providers: catalogProviders(catalog), readClaude: () => readSelectedClaudeUsage(ctx) });
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
    return {selected:record.routing.selected,configured,observed,source:'continuation_affinity',pace,modelOverride:override};
  }
  const decision = !override && chooseCandidate({input, quota});
  if (decision) return {selected:decision.ref,configured,observed,source:decision.reason,pace:decision.pace,
    modelOverride:override,behaviorProfile:decision.profile,reviewOf:input.routing?.reviewOf ?? null,
    poolPacing:decision.pacing};
  const role=canonicalHarnessRole(input.agent);
  if (!override && input.routing?.complexity==='routine' && input.routing?.risk==='normal' && pace==='ahead' && ['builder','deep-debugger'].includes(role)) {
    const fast=modelReference(agents.find(a=>harnessRoleIDs('quick-builder').includes(a.id??a.name))?.model);
    // Never cross providers as a pacing fallback. The worker retains its role,
    // permissions, ownership and required capabilities; only inference changes.
    if (fast && configured && fast.split('/')[0]===configured.split('/')[0]) {selected=fast;source='pace_routine';}
  }
  return {selected,configured,observed,source,pace,modelOverride:override};
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
  const reserve=Number.isFinite(policy.reservePercent)?Math.max(0,Math.min(10,policy.reservePercent)):2;
  const author=modelReference(input.routing.reviewOf), authorProvider=author?.split('/')[0];
  const choices=candidates.flatMap((c,index)=>{
    if (!c || !modelReference(c.ref) || c.enabled===false) return [];
    // Role candidates are explicitly approved capability peers, not price-ranked.
    const state=candidateState(c,quota,reserve);if(!state)return [];
    const independent=Boolean(authorProvider && c.ref.split('/')[0]!==authorProvider);
    return [{...c,...state,index,independent}];
  });
  if(!choices.length)return;
  // For requested independent review, prefer a capable different family when
  // its pool is healthy; a depleted pool never wins solely for diversity.
  choices.sort((a,b)=>(Number(a.pressure)-Number(b.pressure))
    || ((b.independent&&b.pace!=='ahead'?40:0)+b.score)-((a.independent&&a.pace!=='ahead'?40:0)+a.score)
    || a.index-b.index);
  const chosen=choices[0];
  return {...chosen,profile:policy.profiles?.[chosen.profile] ?? chosen.profile,reason:authorProvider&&chosen.independent?'cross_family_review':'subscription_pool_selection'};
}
