// Anthropic admission is intentionally independent from the Codex quota guard.
// Claude Max subscription access and Anthropic API usage credits are different
// billing paths, so this module only admits the former.
export const anthropicPackage = '@opencode/ai/providers/anthropic';
export const anthropicEndpoint = 'https://api.anthropic.com/v1/messages';

function fail(message) { throw new Error(`Subscription guard: ${message}`); }

export function assertAnthropicOverrides(value = {}) {
  if (value.package && value.package !== anthropicPackage) fail('custom Anthropic credentials/endpoint/SDK overrides are forbidden.');
  const settings = value.settings ?? {};
  if (Object.hasOwn(settings, 'apiKey') || Object.hasOwn(settings, 'authToken') ||
      Object.keys(value.headers ?? {}).some(key => /^(authorization|api-key|x-api-key)$/i.test(key)))
    fail('custom Anthropic credentials/endpoint/SDK overrides are forbidden.');
  if (Object.hasOwn(settings, 'baseURL')) assertAnthropicBaseURL(settings.baseURL);
}

export function assertAnthropicBaseURL(value) {
  if (value !== 'https://api.anthropic.com' && value !== 'https://api.anthropic.com/v1')
    fail('custom Anthropic endpoint is forbidden.');
}

export function assertAnthropicHTTPURL(value) {
  let url;
  try { url = new URL(value); } catch { fail('invalid Anthropic endpoint.'); }
  if (url.origin !== 'https://api.anthropic.com' || url.pathname !== '/v1/messages' ||
      url.username || url.password || url.hash || (url.search && url.search !== '?beta=true'))
    fail('custom Anthropic endpoint is forbidden.');
}

export function assertAnthropicCredential(connection, credential) {
  if (connection?.type !== 'credential' || connection.method !== 'oauth' ||
      credential?.type !== 'oauth' || credential.methodID !== 'claude-code' ||
      credential.metadata?.['opencode-claude-auth/claude-code-oauth'] !== 'v1')
    fail('Anthropic Claude Code OAuth is required. No API-key fallback.');
}

// Shared by admission and advisory routing. Never tries another account or API key.
import { CLAUDE_DISABLED_OVERAGE_VERIFICATION_MS, createQuotaCache } from './quota-cache.mjs';
const usageFailureReasons = new Set(['http_error', 'timeout', 'network_error', 'invalid_response']);
const retryAfterLimitSeconds = 86_400;

function retryAfterSeconds(response) {
  // This is the only response-header value retained. It is parsed into a small
  // bounded number before it can reach a native error or telemetry consumer.
  let value;
  try { value = response?.headers?.get?.('retry-after'); } catch { return; }
  if (typeof value !== 'string') return;
  const seconds = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : (Date.parse(value) - Date.now()) / 1000;
  if (!Number.isFinite(seconds)) return;
  return Math.min(retryAfterLimitSeconds, Math.max(0, Math.ceil(seconds)));
}

function usageFailure(reason, { status, retryAfter } = {}) {
  const detail = { operation: 'usage_check', reason: usageFailureReasons.has(reason) ? reason : 'network_error' };
  if (Number.isInteger(status) && status >= 100 && status <= 599) detail.http_status = status;
  if (Number.isInteger(retryAfter) && retryAfter >= 0 && retryAfter <= retryAfterLimitSeconds)
    detail.retry_after_seconds = retryAfter;
  const context = [detail.reason, detail.http_status === undefined ? undefined : `http_status=${detail.http_status}`,
    detail.retry_after_seconds === undefined ? undefined : `retry_after_seconds=${detail.retry_after_seconds}`].filter(Boolean).join(', ');
  const failure = new Error(`Subscription guard: Anthropic usage verification failed (${context}). ` +
    'Admission remains blocked; verify Claude Code OAuth and provider availability. No retry or fallback was attempted.');
  // This deliberately has its own code. Quota recovery only applies to Codex
  // quota failures and must never resume or redirect an Anthropic request.
  failure.code = 'SUBSCRIPTION_ANTHROPIC_USAGE_CHECK_FAILED';
  failure.detail = detail;
  return failure;
}

export function normalizeAnthropicUsageFailure(error) {
  // A reader may be injected by an integration or test. Never trust its Error
  // object wholesale: message, cause, and extra detail could contain provider
  // response data. Rebuild only our closed-set scalar diagnostic fields.
  try {
    if (error?.code === 'SUBSCRIPTION_ANTHROPIC_USAGE_CHECK_FAILED' && usageFailureReasons.has(error?.detail?.reason)) {
      const { reason, http_status: status, retry_after_seconds: retryAfter } = error.detail;
      return usageFailure(reason, { status, retryAfter });
    }
  } catch { return usageFailure('network_error'); }
  let timeout = false;
  try { timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError' || error?.code === 'ETIMEDOUT'; }
  catch { /* preserve the generic, sanitized network category */ }
  return usageFailure(timeout ? 'timeout' : 'network_error');
}

const defaultQuotaCache = createQuotaCache({ hardTtlMs: CLAUDE_DISABLED_OVERAGE_VERIFICATION_MS });
function accountExhausted(value) {
  return [value?.five_hour, value?.seven_day].some(window => Number(window?.utilization ?? window?.percent ?? window?.used_percent ?? window?.usedPercent) >= 100 || window?.locked_reason);
}
const scalar = value => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null ? value : undefined;
function safeWindow(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const allowed = ['utilization', 'percent', 'used_percent', 'usedPercent', 'resets_at', 'resetsAt', 'reset_at', 'locked_reason', 'kind', 'scope', 'model', 'display_name', 'model_display_name', 'model_family', 'is_active', 'active', 'duration_minutes', 'durationMins', 'allowance_percent_of_weekly', 'used_percent_of_weekly', 'limit_index'];
  const result = {};
  for (const key of allowed) if (scalar(value[key]) !== undefined) result[key] = value[key];
  if (value.scope && typeof value.scope === 'object' && !Array.isArray(value.scope)) {
    const model = value.scope.model;
    if (typeof model === 'string') result.scope = { model };
    else if (model && typeof model === 'object') result.scope = { model: Object.fromEntries(['id', 'display_name', 'family'].flatMap(k => typeof model[k] === 'string' ? [[k, model[k]]] : [])) };
    if (typeof value.scope.model_family === 'string') (result.scope ??= {}).model_family = value.scope.model_family;
  }
  return result;
}
// Cache only the fields used for financial and quota decisions. OAuth/account
// identifiers and arbitrary provider response fields never reach disk.
export function sanitizeAnthropicUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { checked_at: new Date().toISOString(), extra_usage: { is_enabled: null } };
  const result = { checked_at: typeof value.checked_at === 'string' ? value.checked_at : new Date().toISOString(),
    extra_usage: { is_enabled: value.extra_usage?.is_enabled === true ? true : value.extra_usage?.is_enabled === false ? false : null } };
  for (const name of ['five_hour', 'seven_day']) { const window = safeWindow(value[name]); if (window) result[name] = window; }
  if (Array.isArray(value.limits)) result.limits = value.limits.map(safeWindow).filter(Boolean);
  if (Array.isArray(value.weekly_scoped_shares)) result.weekly_scoped_shares = value.weekly_scoped_shares.map(safeWindow).filter(Boolean);
  return result;
}
export function anthropicUsageExhausted(value, modelID) {
  if (accountExhausted(value)) return true;
  const id = String(modelID ?? '').toLowerCase();
  return (value?.limits ?? []).some(limit => {
    if (!(Number(limit?.utilization ?? limit?.percent ?? limit?.used_percent ?? limit?.usedPercent) >= 100 || limit?.locked_reason)) return false;
    if (limit?.kind === 'session' || limit?.kind === 'weekly_all' || limit?.scope === 'account') return true;
    const scope = limit?.scope?.model ?? limit?.model ?? limit?.display_name ?? limit?.model_display_name;
    const scoped = typeof scope === 'object' ? (scope.id ?? scope.display_name) : scope;
    if (typeof scoped === 'string' && id === scoped.toLowerCase()) return true;
    const family = (typeof scope === 'object' ? scope.family : undefined) ?? limit?.scope?.model_family ?? limit?.model_family;
    // Match only the explicit provider family segment (for example
    // claude-fable-5-1), never an arbitrary substring or unknown label.
    const selectedFamily = /^claude-([a-z0-9]+)(?:-\d|$)/i.exec(id)?.[1]?.toLowerCase();
    const labels = [family, typeof scope === 'object' ? scope.id : scope, typeof scope === 'object' ? scope.display_name : undefined,
      limit?.display_name, limit?.model_display_name].filter(value => typeof value === 'string').map(value => value.toLowerCase());
    // Full model references must match the selected model exactly above. Only
    // a bare family label (for example "fable") applies family-wide.
    return selectedFamily !== undefined && labels.some(label => label === selectedFamily);
  });
}
export function createAnthropicUsageReader({ cache = defaultQuotaCache } = {}) {
  return async function fetchAnthropicUsage(access) {
    return cache('anthropic', access, async () => {
    let response;
    try {
      response = await fetch('https://api.anthropic.com/api/oauth/usage', {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { authorization: `Bearer ${access}`, 'anthropic-beta': 'oauth-2025-04-20' },
    });
    } catch (error) { throw normalizeAnthropicUsageFailure(error); }
    if (!response || typeof response.ok !== 'boolean' || typeof response.json !== 'function')
      throw usageFailure('invalid_response');
    if (!response.ok) throw usageFailure('http_error', { status: response.status, retryAfter: retryAfterSeconds(response) });
    let body;
    try { body = await response.json(); }
    catch { throw usageFailure('invalid_response'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw usageFailure('invalid_response');
    return { ...body, checked_at: new Date().toISOString() };
    }, { safe: value => value?.extra_usage?.is_enabled === false && !accountExhausted(value), sanitize: sanitizeAnthropicUsage,
      staleTtlMs: CLAUDE_DISABLED_OVERAGE_VERIFICATION_MS });
  };
}
export const fetchAnthropicUsage = createAnthropicUsageReader();
export async function readSelectedClaudeUsage(ctx, reader = fetchAnthropicUsage) {
  const connection = await ctx.integration.connection.active('anthropic');
  const credential = await ctx.integration.connection.resolve(connection);
  assertAnthropicCredential(connection, credential);
  if (typeof credential.access !== 'string' || !credential.access) fail('Anthropic OAuth access unavailable.');
  return reader(credential.access);
}
