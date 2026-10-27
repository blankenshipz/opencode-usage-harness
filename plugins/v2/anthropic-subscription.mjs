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
