import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { packageRoot } from './paths.mjs';
const exec = promisify(execFile);
let cached;
export async function readRoutingQuota() {
  if (cached && Date.now() - cached.at < 30000) return cached.value;
  const env = Object.fromEntries(['HOME','PATH','LANG','HARNESS_STATE_DIR','CODEX_HOME','HARNESS_CODEX_BIN','HARNESS_PYTHON'].filter(k => process.env[k] !== undefined).map(k => [k,process.env[k]]));
  const { stdout } = await exec(path.join(packageRoot,'bin/codex-quota'), ['--json'], {env, timeout:25000,maxBuffer:1024*1024});
  const value=JSON.parse(stdout); cached={at:Date.now(),value}; return value;
}
export function modelReference(ref) {
  if (typeof ref === 'string') return /^[\w.-]+\/[\w./-]+(?:#[\w.-]+)?$/.test(ref) ? ref : undefined;
  if (!ref || typeof ref !== 'object') return;
  return modelReference(`${ref.providerID}/${ref.id}${ref.variant ? '#'+ref.variant : ''}`);
}
export function quotaPace(quota, now=Date.now()) {
  const checked=Date.parse(quota?.checked_at);
  if (!Number.isFinite(checked) || now-checked>120000 || checked>now+5000) return 'unknown';
  const windows=(quota.buckets??[]).flatMap(b=>b.windows??[]).filter(w=>Number.isFinite(w.pace_delta));
  if (!windows.length) return 'unknown';
  if (windows.some(w=>w.pace_delta>10 || w.remaining_percent<=10)) return 'ahead';
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
  const pace=quotaPace(quota);
  let selected=override??configured, source=override?'explicit_override':'configured_role';
  if (!override && input.routing?.complexity==='routine' && input.routing?.risk==='normal' && pace==='ahead' && ['builder','deep-debugger'].includes(input.agent)) {
    const fast=modelReference(agents.find(a=>(a.id??a.name)==='quick-builder')?.model);
    // Never cross providers as a pacing fallback. The worker retains its role,
    // permissions, ownership and required capabilities; only inference changes.
    if (fast && configured && fast.split('/')[0]===configured.split('/')[0]) {selected=fast;source='pace_routine';}
  }
  return {selected,configured,observed,source,pace,modelOverride:override};
}
