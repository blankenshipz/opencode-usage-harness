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
export async function fetchAnthropicUsage(access) {
  const now = Date.now();
  for (const [key, entry] of usageCache) if (entry.expires <= now) usageCache.delete(key);
  const cached = usageCache.get(access);
  if (cached) return cached.value;
  try {
    const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { authorization: `Bearer ${access}`, 'anthropic-beta': 'oauth-2025-04-20' },
    });
    if (!response.ok) throw new Error('status');
    const value = { ...(await response.json()), checked_at: new Date().toISOString() };
    if (usageCache.size >= 16) usageCache.clear();
    usageCache.set(access, { value, expires: now + 30000 });
    return value;
  } catch { throw new Error('Subscription guard: Anthropic usage verification failed.'); }
}
export async function readSelectedClaudeUsage(ctx, reader = fetchAnthropicUsage) {
  const connection = await ctx.integration.connection.active('anthropic');
  const credential = await ctx.integration.connection.resolve(connection);
  assertAnthropicCredential(connection, credential);
  if (typeof credential.access !== 'string' || !credential.access) fail('Anthropic OAuth access unavailable.');
  return reader(credential.access);
}
