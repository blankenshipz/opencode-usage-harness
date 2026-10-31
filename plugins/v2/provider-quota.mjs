import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import path from 'node:path';
import { packageRoot } from './paths.mjs';
import { defaultShortWindowPacingStore, SHORT_WINDOW_PACING_IDENTITY } from './short-window-pacing.mjs';

const exec = promisify(execFile);
const DEFAULT_MAX_AGE_MS = 120_000;
const SAFE_ENV = ['HOME', 'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'HARNESS_STATE_DIR', 'CODEX_HOME', 'HARNESS_CODEX_BIN', 'HARNESS_PYTHON'];

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function number(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function percent(value) {
  const n = number(value);
  if (n === null) return null;
  return Math.max(0, Math.min(100, n));
}
function timestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e12 ? value : value * 1000;
  if (typeof value === 'string') { const parsed = Date.parse(value); if (Number.isFinite(parsed)) return parsed; }
  return null;
}
function iso(now) { return new Date(now).toISOString(); }
function errorReason(error) {
  if (error?.code === 'ENOENT') return 'executable_missing';
  if (error?.name === 'AbortError' || error?.code === 'ETIMEDOUT') return 'timeout';
  return 'read_failed';
}
function hashIdentifier(value) {
  if (typeof value !== 'string' || !value) return undefined;
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

function pace(windows, now) {
  const usable = windows.filter(w => finite(w.used_percent) !== null && finite(w.duration_minutes) !== null && finite(w.resets_at) !== null);
  if (!usable.length) return 'unknown';
  const deltas = usable.map(w => {
    const start = w.resets_at - w.duration_minutes * 60_000;
    const target = Math.max(0, Math.min(100, (now - start) / (w.duration_minutes * 60_000) * 100));
    return w.used_percent - target;
  });
  if (deltas.some(v => v > 10)) return 'ahead';
  if (deltas.every(v => v < -10)) return 'behind';
  return 'normal';
}

function basePool(provider, now) {
  return { provider, checked_at: iso(now), availability: 'unknown', financial: { extra_usage_enabled: null, payg: null }, windows: [], pace: 'unknown' };
}

function paceFields(window, now) {
  if (window.used_percent === null || window.duration_minutes === null || window.resets_at === null || window.resets_at <= now) return { target_used_percent: null, pace_delta: null };
  const target = Math.max(0, Math.min(100, (now - (window.resets_at - window.duration_minutes * 60_000)) / (window.duration_minutes * 60_000) * 100));
  return { target_used_percent: target, pace_delta: window.used_percent - target };
}

export function normalizeCodexQuota(raw, { now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
  const pool = basePool('openai', now);
  const checked = timestamp(raw?.checked_at);
  if (!raw || typeof raw !== 'object' || checked === null || now - checked > maxAgeMs || checked > now + 5_000) {
    pool.reason = 'stale_or_invalid';
    return pool;
  }
  pool.checked_at = iso(checked);
  const windows = [];
  for (const bucket of Array.isArray(raw.buckets) ? raw.buckets : []) for (const item of Array.isArray(bucket?.windows) ? bucket.windows : []) {
    const used = percent(item.used_percent);
    const resetValue = timestamp(item.resets_at);
    const reset = resetValue !== null && resetValue > now ? resetValue : null;
    const duration = number(item.duration_minutes);
    const key = `${item.name ?? ''}|${duration ?? ''}|${reset ?? ''}`;
    if (!windows.some(w => w._key === key)) windows.push({ kind: item.kind ?? 'unknown', duration_minutes: duration, duration_source: duration === null ? 'unknown' : 'reported', used_percent: used, remaining_percent: percent(item.remaining_percent), resets_at: reset, scope: 'account', ...paceFields({ used_percent: used, duration_minutes: duration, resets_at: reset }, now), _key: key });
  }
  pool.windows = windows.map(({ _key, ...w }) => w);
  pool.availability = !windows.length || windows.some(w => w.used_percent === null || w.resets_at === null) ? 'unknown' : windows.some(w => w.used_percent >= 100) ? 'unavailable' : 'available';
  const creditRisk = raw.credit_risk;
  pool.credit_risk = creditRisk ?? null;
  pool.financial = { extra_usage_enabled: null, payg: null };
  pool.pace = pace(pool.windows, now);
  return pool;
}

function claudeWindow(kind, source, raw, now, share) {
  if (!raw || typeof raw !== 'object') return null;
  const used = percent(raw.utilization ?? raw.used_percent ?? raw.usedPercent ?? raw.percent);
  const resetValue = timestamp(raw.resets_at ?? raw.resetsAt);
  const reset = resetValue !== null && resetValue > now ? resetValue : null;
  let duration = number(raw.duration_minutes ?? raw.durationMins);
  let durationSource = 'reported';
  if (duration === null && kind === 'session') { duration = 300; durationSource = 'inferred'; }
  if (duration === null && (kind === 'weekly_all' || kind === 'weekly_scoped')) { duration = 10080; durationSource = 'inferred'; }
  if (used === null && reset === null) return null;
  const structuredScope = raw.scope && typeof raw.scope === 'object' ? raw.scope : {};
  const scope = typeof raw.scope === 'string' ? raw.scope : (kind === 'weekly_scoped' ? 'model' : 'account');
  const modelObject = structuredScope.model && typeof structuredScope.model === 'object' ? structuredScope.model : {};
  const model = (typeof raw.model === 'string' ? raw.model : null) ?? (typeof structuredScope.model === 'string' ? structuredScope.model : null) ?? modelObject.display_name ?? modelObject.id ?? raw.display_name ?? raw.model_display_name;
  const modelFamily = raw.model_family ?? structuredScope.model_family ?? modelObject.family;
  const allowance = number(share?.allowance_percent_of_weekly ?? raw.allowance_percent_of_weekly);
  const usedWeekly = number(share?.used_percent_of_weekly ?? raw.used_percent_of_weekly);
  const window = { kind, duration_minutes: duration, duration_source: durationSource, used_percent: used, remaining_percent: used === null ? null : 100 - used, resets_at: reset, is_active: raw.is_active === false || raw.active === false ? false : raw.is_active === true || raw.active === true ? true : null, locked_reason: typeof raw.locked_reason === 'string' ? raw.locked_reason : null, scope, model_family: typeof modelFamily === 'string' ? modelFamily : null, model: typeof model === 'string' ? model : null, allowance_percent_of_weekly: allowance, used_percent_of_weekly: usedWeekly };
  return { ...window, ...paceFields(window, now), _key: `${kind}|${scope}|${window.model ?? ''}|${window.model_family ?? ''}|${reset ?? ''}` };
}

export function normalizeClaudeQuota(raw, { now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
  const pool = basePool('anthropic', now);
  const checked = timestamp(raw?.checked_at ?? raw?.checkedAt);
  if (raw?.quota_cache && typeof raw.quota_cache === 'object') pool.cache = {
    stale: raw.quota_cache.stale === true,
    verified_at: Number.isFinite(raw.quota_cache.verified_at) ? iso(raw.quota_cache.verified_at) : null,
    cooldown_until: Number.isFinite(raw.quota_cache.cooldown_until) ? iso(raw.quota_cache.cooldown_until) : null,
    error: typeof raw.quota_cache.error === 'string' ? raw.quota_cache.error : null,
    http_status: Number.isInteger(raw.quota_cache.http_status) && raw.quota_cache.http_status >= 100 && raw.quota_cache.http_status <= 599 ? raw.quota_cache.http_status : null,
  };
  if (!raw || typeof raw !== 'object' || pool.cache?.stale || checked === null || now - checked > maxAgeMs || checked > now + 5_000) { pool.reason = 'stale_or_invalid'; return pool; }
  pool.checked_at = iso(checked);
  const windows = [];
  const shares = Array.isArray(raw.weekly_scoped_shares) ? raw.weekly_scoped_shares : [];
  const add = (kind, value, index = null) => { const share = index === null ? undefined : shares.find(s => s?.limit_index === index); const w = claudeWindow(kind, kind === 'session' ? 'five_hour' : 'seven_day', value, now, share); if (w && !windows.some(x => x._key === w._key)) windows.push(w); };
  add('session', raw.five_hour);
  add('weekly_all', raw.seven_day);
  for (const [index, item] of (Array.isArray(raw.limits) ? raw.limits : []).entries()) {
    const kind = ['session','weekly_all','weekly_scoped'].includes(item?.kind) ? item.kind : item?.scope || item?.model || item?.display_name ? 'weekly_scoped' : item?.kind;
    if (kind === 'session' || kind === 'weekly_all' || kind === 'weekly_scoped') add(kind, item, index);
  }
  pool.windows = windows.map(({ _key, ...w }) => w);
  const accountWindows = windows.filter(w => w.scope === 'account');
  // is_active is provider metadata for a limit, not an account eligibility or
  // exhaustion signal. A live Max payload can report false while inference is
  // valid; only known usage exhaustion/lock metadata affects availability.
  const locked = accountWindows.some(w => w.locked_reason);
  pool.availability = locked ? 'unavailable' : accountWindows.length ? (accountWindows.some(w => w.used_percent === null || w.resets_at === null) ? 'unknown' : accountWindows.some(w => w.used_percent >= 100) ? 'unavailable' : 'available') : 'unknown';
  pool.financial = { extra_usage_enabled: raw.extra_usage?.is_enabled === true ? true : raw.extra_usage?.is_enabled === false ? false : null, payg: raw.extra_usage?.is_enabled === true ? true : raw.extra_usage?.is_enabled === false ? false : null };
  if (raw.account_id || raw.accountId) pool.account = { source: 'selected_oauth', id: hashIdentifier(String(raw.account_id ?? raw.accountId)) };
  pool.pace = pace(accountWindows, now);
  return pool;
}

// Only readers for the enabled catalog providers run. An absent subscription
// must not add a CLI dependency, network request, or timeout to another pool.
export function catalogProviders(catalog) {
  if (!Array.isArray(catalog)) throw new Error('subscription quota: model catalog unavailable');
  // The supported V2 ctx.model.list delegates to Model.available (enabled only).
  return [...new Set(catalog.filter(model => model && model.enabled !== false).map(model => model.providerID).filter(id => ['openai','anthropic'].includes(id)))];
}
export async function readProviderQuotas({ readCodex, readClaude, providers = ['openai','anthropic'], now, timeoutMs = 25_000,
  pacingStore = defaultShortWindowPacingStore } = {}) {
  const clock = () => now ?? Date.now();
  const readers = {
    openai: readCodex ?? (() => readCodexQuota({ timeoutMs })),
    anthropic: readClaude ?? (async () => { throw Object.assign(new Error('selected Claude OAuth usage adapter unavailable'), { code: 'ADAPTER_UNAVAILABLE' }); }),
  };
  if (!Array.isArray(providers) || providers.some(id => !Object.hasOwn(readers,id))) throw new Error('subscription quota: unsupported provider selection');
  const pools = Object.fromEntries(await Promise.all([...new Set(providers)].map(async provider => {
    try {
      const raw = await readers[provider]();
      const pool = (provider === 'openai' ? normalizeCodexQuota : normalizeClaudeQuota)(raw,{now:clock()});
      // A reader may provide a private Symbol-keyed selected-credential
      // fingerprint. Never copy it to normalized telemetry or tool output.
      try { pool.advisory = { short_window_pacing: await pacingStore.observe(pool, { identity: raw?.[SHORT_WINDOW_PACING_IDENTITY] }) }; }
      catch { pool.advisory = { short_window_pacing: { status: 'unknown', reason: 'persistence_unavailable', windows: [] } }; }
      return [provider,pool];
    } catch(error) {
      return [provider,{...basePool(provider,clock()),reason:error?.code === 'ADAPTER_UNAVAILABLE' ? 'adapter_unavailable' : errorReason(error),
        advisory: { short_window_pacing: { status: 'unknown', reason: 'telemetry_unavailable', windows: [] } }}];
    }
  })));
  return { version:1,checked_at:iso(clock()),pools };
}

export async function readCodexQuota({ timeoutMs = 25_000 } = {}) {
  const env = Object.fromEntries(SAFE_ENV.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  const { stdout } = await exec(path.join(packageRoot, 'bin/codex-quota'), ['--json'], { env, timeout: timeoutMs, maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout);
}
