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
const usageCache = new Map();
const usagePending = new Map();
const usageFailureReasons = new Set(['http_error', 'timeout', 'network_error', 'invalid_response']);
const retryAfterLimitSeconds = 600;

function retryAfterSeconds(response) {
  // This is the only response-header value retained. It is parsed into a small
  // bounded number before it can reach a native error or telemetry consumer.
  let value;
  try { value = response?.headers?.get?.('retry-after'); } catch { return; }
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) return;
  return Math.min(retryAfterLimitSeconds, Math.max(0, Math.ceil(Number(value))));
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

export async function fetchAnthropicUsage(access) {
  const now = Date.now();
  for (const [key, entry] of usageCache) if (entry.expires <= now) usageCache.delete(key);
  const cached = usageCache.get(access);
  if (cached) return cached.value;
  const pending = usagePending.get(access);
  if (pending) return pending;
  const request = (async () => {
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
    const value = { ...body, checked_at: new Date().toISOString() };
    if (usageCache.size >= 16) usageCache.clear();
    // Start the cache after a verified response arrives. A slow request can
    // therefore never turn into an admission based on an already-expired read.
    usageCache.set(access, { value, expires: Date.now() + 30000 });
    return value;
  })();
  usagePending.set(access, request);
  try { return await request; }
  finally { if (usagePending.get(access) === request) usagePending.delete(access); }
}
export async function readSelectedClaudeUsage(ctx, reader = fetchAnthropicUsage) {
  const connection = await ctx.integration.connection.active('anthropic');
  const credential = await ctx.integration.connection.resolve(connection);
  assertAnthropicCredential(connection, credential);
  if (typeof credential.access !== 'string' || !credential.access) fail('Anthropic OAuth access unavailable.');
  return reader(credential.access);
}
