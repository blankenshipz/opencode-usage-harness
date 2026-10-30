import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CLAUDE_DISABLED_OVERAGE_VERIFICATION_MS, createQuotaCache } from '../plugins/v2/quota-cache.mjs';

async function fixture(clock = { now: 0 }) {
  const directory = await mkdtemp(join(tmpdir(), 'quota-cache-'));
  return { directory, cache: createQuotaCache({ directory, now: () => clock.now }), clock, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
const disabled = extra => ({ checked_at: '2026-01-01T00:00:00.000Z', extra_usage: { is_enabled: false }, ...extra });
const transient = status => Object.assign(new Error('private'), { code: 'SUBSCRIPTION_ANTHROPIC_USAGE_CHECK_FAILED', detail: { reason: 'http_error', http_status: status } });
const exec = promisify(execFile);

test('quota cache shares fresh verified result, persists an opaque key, and never writes arbitrary response fields', async () => {
  const f = await fixture(); let reads = 0;
  try {
    const load = async () => { reads++; return disabled({ secret: 'must-not-persist' }); };
    const sanitize = value => disabled();
    await Promise.all([f.cache('anthropic', 'credential-secret', load, { sanitize }), f.cache('anthropic', 'credential-secret', load, { sanitize })]);
    await f.cache('anthropic', 'credential-secret', load, { sanitize });
    assert.equal(reads, 1);
    const files = await readdir(f.directory); assert.ok(files.every(name => !name.includes('credential-secret')));
    const payload = await readFile(join(f.directory, files.find(name => name.endsWith('.json'))), 'utf8');
    assert.doesNotMatch(payload, /secret|credential/);
  } finally { await f.cleanup(); }
});

test('transient 429 serves only recent disabled evidence then expires, while enabled and auth failures invalidate it', async () => {
  const f = await fixture();
  try {
    await f.cache('anthropic', 'a', async () => disabled()); f.clock.now = 61_000;
    const stale = await f.cache('anthropic', 'a', async () => { throw transient(429); });
    assert.equal(stale.quota_cache.stale, true); assert.equal(stale.quota_cache.cooldown_until, 121_000);
    f.clock.now = 301_001;
    await assert.rejects(f.cache('anthropic', 'a', async () => { throw transient(429); }));
    f.clock.now = 400_000;
    await f.cache('anthropic', 'b', async () => ({ ...disabled(), extra_usage: { is_enabled: true } }));
    f.clock.now += 61_000;
    await assert.rejects(f.cache('anthropic', 'b', async () => { throw transient(429); }));
    await f.cache('anthropic', 'c', async () => disabled()); f.clock.now += 61_000;
    const denied = Object.assign(new Error('denied'), { code: 'SUBSCRIPTION_ANTHROPIC_USAGE_CHECK_FAILED', detail: { reason: 'http_error', http_status: 401 } });
    await assert.rejects(f.cache('anthropic', 'c', async () => { throw denied; }));
    f.clock.now += 1;
    await assert.rejects(f.cache('anthropic', 'c', async () => { throw transient(429); }));
  } finally { await f.cleanup(); }
});

test('a slow transient failure cannot use evidence that crosses the five-minute bound while loading', async () => {
  const f = await fixture();
  try {
    await f.cache('anthropic', 'slow', async () => disabled()); f.clock.now = 61_000;
    await assert.rejects(f.cache('anthropic', 'slow', async () => { f.clock.now = 300_001; throw transient(429); }));
  } finally { await f.cleanup(); }
});

test('Claude disabled-overage recovery lasts less than 24 hours from the original verification', async () => {
  const f = await fixture();
  const claude = (credential, load) => f.cache('anthropic', credential, load, { staleTtlMs: CLAUDE_DISABLED_OVERAGE_VERIFICATION_MS });
  try {
    await claude('verified', async () => disabled());
    f.clock.now = 61_000;
    const stale = await claude('verified', async () => { throw transient(429); });
    assert.equal(stale.quota_cache.stale, true);
    assert.equal(stale.quota_cache.http_status, 429);
    f.clock.now = 70_000;
    const cooling = await claude('verified', async () => { throw transient(503); });
    assert.equal(cooling.quota_cache.http_status, 429);
    f.clock.now = 121_001;
    const refreshedFailure = await claude('verified', async () => { throw transient(503); });
    assert.equal(refreshedFailure.quota_cache.http_status, 503, 'a later non-cooldown failure replaces prior HTTP status');
    f.clock.now = CLAUDE_DISABLED_OVERAGE_VERIFICATION_MS - 1;
    const beforeExpiry = await claude('verified', async () => { throw transient(503); });
    assert.equal(beforeExpiry.quota_cache.stale, true);
    assert.equal(beforeExpiry.quota_cache.verified_at, 0);
    f.clock.now = CLAUDE_DISABLED_OVERAGE_VERIFICATION_MS;
    await assert.rejects(claude('verified', async () => { throw transient(503); }));

    await claude('slow', async () => disabled());
    f.clock.now += CLAUDE_DISABLED_OVERAGE_VERIFICATION_MS - 1;
    await assert.rejects(claude('slow', async () => { f.clock.now++; throw transient(503); }), /private/);
  } finally { await f.cleanup(); }
});

test('legacy transient cache entries have unknown HTTP status', async () => {
  const f = await fixture();
  try {
    await f.cache('anthropic', 'legacy', async () => ({ ...disabled(), extra_usage: { is_enabled: true } }));
    f.clock.now = 61_000;
    await assert.rejects(f.cache('anthropic', 'legacy', async () => { throw transient(429); }));
    const file = (await readdir(f.directory)).find(name => name.endsWith('.json'));
    const entry = JSON.parse(await readFile(join(f.directory, file), 'utf8'));
    delete entry.error_http_status;
    await writeFile(join(f.directory, file), JSON.stringify(entry), { mode: 0o600 });
    await assert.rejects(f.cache('anthropic', 'legacy', async () => { throw transient(429); }), error => {
      assert.equal(error.detail.http_status, undefined);
      return true;
    });
  } finally { await f.cleanup(); }
});

test('separate Node processes singleflight on disk and a restarted process reuses the verified snapshot', async () => {
  const f = await fixture(); const counter = join(f.directory, 'counter');
  const moduleURL = new URL('../plugins/v2/quota-cache.mjs', import.meta.url).href;
  const source = `import {createQuotaCache} from ${JSON.stringify(moduleURL)}; import {appendFile} from 'node:fs/promises';
    const cache=createQuotaCache({directory:process.argv[1]}); const counter=process.argv[2];
    const value=await cache('anthropic','same-credential',async()=>{await appendFile(counter,'x');await new Promise(r=>setTimeout(r,100));return {checked_at:new Date().toISOString(),extra_usage:{is_enabled:false}}}); process.stdout.write(JSON.stringify(value));`;
  try {
    const args = ['--input-type=module', '-e', source, f.directory, counter];
    await Promise.all([exec(process.execPath, args), exec(process.execPath, args)]);
    assert.equal((await readFile(counter, 'utf8')).length, 1);
    await exec(process.execPath, args);
    assert.equal((await readFile(counter, 'utf8')).length, 1, 'fresh disk snapshot survives process restart');
  } finally { await f.cleanup(); }
});

test('corrupt cache is ignored and a cold cooldown blocks repeated network loads', async () => {
  const f = await fixture(); let loads = 0;
  try {
    await assert.rejects(f.cache('anthropic', 'cold', async () => { loads++; throw transient(429); }));
    await assert.rejects(f.cache('anthropic', 'cold', async () => { loads++; throw transient(429); }));
    assert.equal(loads, 1);
    const data = (await readdir(f.directory)).find(name => name.endsWith('.json'));
    await writeFile(join(f.directory, data), '{not-json', { mode: 0o600 });
    await assert.rejects(f.cache('anthropic', 'cold', async () => { loads++; throw transient(429); }));
    assert.equal(loads, 2);
  } finally { await f.cleanup(); }
});


test('cooldown retains HTTP status but a later timeout clears it', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.cache('anthropic', 'status', async () => { throw transient(503); }));
    await assert.rejects(f.cache('anthropic', 'status', async () => assert.fail('cooldown must not fetch')), error => {
      assert.equal(error.detail.http_status, 503); return true;
    });
    f.clock.now = 60_001;
    const timeout = Object.assign(new Error('private timeout'), { code: 'SUBSCRIPTION_ANTHROPIC_USAGE_CHECK_FAILED', detail: { reason: 'timeout' } });
    await assert.rejects(f.cache('anthropic', 'status', async () => { throw timeout; }));
    await assert.rejects(f.cache('anthropic', 'status', async () => assert.fail('cooldown must not fetch')), error => {
      assert.equal(error.detail.reason, 'timeout'); assert.equal(error.detail.http_status, undefined); return true;
    });
    const file = (await readdir(f.directory)).find(name => name.endsWith('.json'));
    assert.equal(JSON.parse(await readFile(join(f.directory, file), 'utf8')).error_http_status, undefined);
  } finally { await f.cleanup(); }
});
