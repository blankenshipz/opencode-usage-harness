// r30 item B: 1h prompt-cache TTL for router/coordinator (parent) requests.
//
// OpenCode 2.0.30 lowers an `LLM.CacheHint{ttlSeconds>=3600}` to the wire marker
// `cache_control:{type:"ephemeral",ttl:"1h"}` (packages/ai/src/protocols/utils/cache.ts),
// but the plugin `context` hook cannot set the request cache policy. The
// `session.http.request` hook does see the final Anthropic JSON body, so this
// rewrites the breakpoints the runtime already placed (same positions, same
// count, no fifth breakpoint) to the 1h bucket. Workers keep the 5m default.
//
// Fail safe: any unsupported shape (non-JSON body, adapter already applied,
// missing hook, a 400 mentioning the TTL) is logged once and the request is
// sent unchanged; a TTL rejection disables the rewrite for this process.
import { canonicalHarnessRole } from './agent-mode.mjs';
import { loadTokenSavingConfig, logOnce, logTokenSaving } from './token-saving.mjs';

const BILLING_PREFIX = 'x-anthropic-billing-header';
const isRecord = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// Mutates `body`; returns {changed} or {unsupported}.
export function rewriteCacheTtl(body, ttl = '1h') {
  if (!isRecord(body) || !Array.isArray(body.messages)) return { unsupported: 'not_messages_body' };
  // The Claude subscription adapter has already transformed (and re-keyed) this request.
  if (Array.isArray(body.system) && body.system.some(e => typeof e?.text === 'string' && e.text.startsWith(BILLING_PREFIX)))
    return { unsupported: 'after_subscription_adapter' };
  let changed = 0, present = 0;
  const visit = holder => {
    const cc = holder?.cache_control;
    if (!isRecord(cc)) return;
    present++;
    if (cc.type === 'ephemeral' && (cc.ttl === undefined || cc.ttl === '5m') && cc.ttl !== ttl) { holder.cache_control = { ...cc, ttl }; changed++; }
  };
  visit(body);
  for (const tool of Array.isArray(body.tools) ? body.tools : []) visit(tool);
  for (const part of Array.isArray(body.system) ? body.system : []) visit(part);
  for (const message of body.messages) for (const part of Array.isArray(message?.content) ? message.content : []) visit(part);
  return { changed, present };
}

export function parentTtlApplies(event, config) {
  if (!config?.enabled || !(config.ttlSeconds >= 3600)) return false;
  if (event?.model?.providerID !== 'anthropic') return false;
  if (event.kind !== undefined && event.kind !== 'primary') return false; // compaction/title: one-shot
  const role = canonicalHarnessRole(event.agent) ?? event.agent;
  return (config.roles ?? []).includes(role);
}

export async function installParentCacheTtl(ctx, { loadConfig = loadTokenSavingConfig, log = logTokenSaving, once = logOnce, now = Date.now } = {}) {
  // No session hook API at all (older runtime or a test double): nothing to do, nothing to log.
  if (typeof ctx?.session?.hook !== 'function') return { stop() {}, state: () => ({ disabled: 'unsupported' }) };
  if (typeof Request !== 'function') {
    once('parent-ttl:no-request', { event: 'parent_cache_ttl_unsupported', reason: 'fetch_request_unavailable' });
    return { stop() {}, state: () => ({ disabled: 'unsupported' }) };
  }
  let disabled, stopped = false;
  const recent = new Map(); // sessionID -> last rewrite time (bounded)
  const register = async (name, fn) => {
    try { await ctx.session.hook(name, fn); return true; }
    catch { once(`parent-ttl:register:${name}`, { event: 'parent_cache_ttl_unsupported', reason: `hook_${name}_unavailable` }); disabled = 'unsupported'; return false; }
  };
  await register('http.request', async event => {
    if (stopped || disabled) return;
    let config;
    try { config = loadConfig().parentCacheTtl; } catch { return; }
    if (!parentTtlApplies(event, config)) return;
    try {
      const request = event.request;
      if (!(request instanceof Request) || request.method !== 'POST') return;
      let body;
      try { body = JSON.parse(await request.clone().text()); }
      catch { once('parent-ttl:not-json', { event: 'parent_cache_ttl_unsupported', reason: 'body_not_json' }); return; }
      const result = rewriteCacheTtl(body, '1h');
      if (result.unsupported) { once(`parent-ttl:${result.unsupported}`, { event: 'parent_cache_ttl_unsupported', reason: result.unsupported }); return; }
      if (!result.changed) return;
      const headers = new Headers(request.headers);
      headers.delete('content-length');
      event.request = new Request(request.url, { method: request.method, headers, body: JSON.stringify(body), signal: request.signal });
      if (recent.size >= 512) recent.delete(recent.keys().next().value);
      recent.set(event.sessionID, now());
      once(`parent-ttl:session:${event.sessionID}`, { event: 'parent_cache_ttl_applied', session: event.sessionID, agent: event.agent, breakpoints: result.changed });
    } catch (error) {
      once('parent-ttl:error', { event: 'parent_cache_ttl_unsupported', reason: 'rewrite_failed', error: String(error?.message ?? error).slice(0, 200) });
    }
  });
  // Circuit breaker: a 400 that names the TTL/cache_control right after a
  // rewrite for that session disables the rewrite for this process.
  await register('http.response', async event => {
    if (stopped || disabled || !recent.has(event.sessionID)) return;
    const status = event.response?.status;
    if (status !== 400) return;
    try {
      const text = await event.response.clone().text();
      if (/\bttl\b|cache_control/i.test(text)) {
        disabled = 'provider_rejected_ttl';
        log({ event: 'parent_cache_ttl_disabled', reason: disabled, session: event.sessionID });
      }
    } catch { /* leave the response untouched */ }
  });
  return { stop() { stopped = true; recent.clear(); }, state: () => ({ disabled }) };
}
