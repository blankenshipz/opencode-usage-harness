#!/usr/bin/env node
import { readProviderQuotas } from '../plugins/v2/provider-quota.mjs';

const result = await readProviderQuotas();
if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(result)}\n`);
else for (const [name, pool] of Object.entries(result.pools)) process.stdout.write(`${name}: ${pool.availability} (${pool.windows.length} windows, pace ${pool.pace})${pool.reason ? ` [${pool.reason}]` : ''}\n`);
