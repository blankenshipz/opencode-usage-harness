#!/usr/bin/env node
import { readProviderQuotas, readCachedClaudeQuota } from '../plugins/v2/provider-quota.mjs';

const result = await readProviderQuotas();
// Outside a session the Claude OAuth adapter is unavailable; report the plugin's
// cached snapshot instead, with its age and a staleness marker. Never tokens.
if (result.pools.anthropic?.reason === 'adapter_unavailable') {
  const cached = await readCachedClaudeQuota();
  if (cached) result.pools.anthropic = { ...cached, advisory: result.pools.anthropic.advisory };
}
const age = seconds => seconds < 120 ? `${seconds}s` : seconds < 7200 ? `${Math.round(seconds / 60)}m` : `${Math.round(seconds / 3600)}h`;
const windows = pool => pool.windows.map(w => `${w.kind}${w.model_family || w.model ? `:${w.model_family ?? w.model}` : ''} ${w.used_percent ?? '?'}%`).join(', ');
if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(result)}\n`);
else for (const [name, pool] of Object.entries(result.pools)) {
  const cache = pool.source === 'quota_cache'
    ? ` [quota_cache ${age(pool.cache.age_seconds)} old${pool.cache.stale ? ', STALE' : ''}; verified ${pool.cache.verified_at}${pool.windows.length ? `; ${windows(pool)}` : ''}]`
    : pool.reason ? ` [${pool.reason}]` : '';
  process.stdout.write(`${name}: ${pool.availability} (${pool.windows.length} windows, pace ${pool.pace})${cache}\n`);
}
