#!/usr/bin/env node
import { readProviderQuotas, readCachedClaudeQuota } from '../plugins/v2/provider-quota.mjs';
import { gateLevel } from '../plugins/v2/quota-throttle.mjs';

// parity 4.11: shared quota gate. Prints exactly ok|slow|hold from the cached
// snapshot, never calls the network, fails open (ok) when stale/missing; exit 0.
if (process.argv.includes('--gate')) {
  let out = 'ok';
  try {
    const cached = await readCachedClaudeQuota();
    if (!cached) process.stderr.write('quota gate: no cached snapshot; failing open (ok)\n');
    else if (cached.cache?.stale) process.stderr.write(`quota gate: snapshot is stale (${cached.cache.age_seconds}s old); failing open (ok)\n`);
    else out = gateLevel({ pools: { anthropic: cached } }, 'anthropic');
  } catch { process.stderr.write('quota gate: snapshot unreadable; failing open (ok)\n'); out = 'ok'; }
  process.stdout.write(`${out}\n`);
  process.exit(0);
}

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
