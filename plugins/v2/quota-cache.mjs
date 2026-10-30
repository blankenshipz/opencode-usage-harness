import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { configuredPython, statePath } from './paths.mjs';

const lockProgram = `import fcntl,time
end=time.monotonic()+15
while True:
 try:
  fcntl.flock(3,fcntl.LOCK_EX|fcntl.LOCK_NB);break
 except BlockingIOError:
  if time.monotonic()>=end: raise SystemExit(1)
  time.sleep(.02)`;
const safeEnv = () => Object.fromEntries(['HOME', 'PATH', 'LANG'].flatMap(k => process.env[k] === undefined ? [] : [[k, process.env[k]]]));
const keyFor = (provider, credential) => crypto.createHash('sha256').update(`${provider}\0${credential}`).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));

async function lock(file) {
  const handle = await fs.open(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('quota cache lock is unsafe');
    await new Promise((resolve, reject) => {
      const child = spawn(configuredPython, ['-c', lockProgram], { env: safeEnv(), stdio: ['ignore', 'ignore', 'ignore', handle.fd] });
      const timer = setTimeout(() => child.kill('SIGKILL'), 16_000);
      child.once('error', () => { clearTimeout(timer); reject(new Error('quota cache lock unavailable')); });
      child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('quota cache busy')); });
    });
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
async function read(file) {
  let handle;
  try {
    handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077)) return null;
    const value = JSON.parse(await handle.readFile('utf8')); return value && typeof value === 'object' ? value : null;
  }
  catch { return null; } // A corrupt cache is never authority.
  finally { await handle?.close().catch(() => {}); }
}
async function write(file, value) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try { await fs.writeFile(temp, JSON.stringify(value), { mode: 0o600 }); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }).catch(() => {}); }
}
const retryAfter = error => Number.isInteger(error?.detail?.retry_after_seconds) ? error.detail.retry_after_seconds * 1000 : 0;
const httpStatus = error => Number.isInteger(error?.detail?.http_status) && error.detail.http_status >= 100 && error.detail.http_status <= 599
  ? error.detail.http_status : undefined;
const cachedHttpStatus = entry => Number.isInteger(entry?.error_http_status) && entry.error_http_status >= 100 && entry.error_http_status <= 599
  ? entry.error_http_status : undefined;
const transient = error => error?.detail?.reason === 'timeout' || error?.detail?.reason === 'network_error' ||
  (error?.detail?.reason === 'http_error' && (error.detail.http_status === 429 || error.detail.http_status >= 500));
const cooldownError = (entry, current) => Object.assign(new Error('Anthropic usage telemetry is cooling down'), {
  code: 'SUBSCRIPTION_ANTHROPIC_USAGE_CHECK_FAILED', detail: { operation: 'usage_check', reason: entry.error ?? 'network_error',
    ...(cachedHttpStatus(entry) === undefined ? {} : { http_status: cachedHttpStatus(entry) }),
    retry_after_seconds: Math.max(0, Math.ceil((entry.cooldown_until - current) / 1000)) },
});

// Claude's financial authorization is deliberately longer-lived than quota
// telemetry. Callers opt in explicitly; the generic cache remains five minutes.
export const CLAUDE_DISABLED_OVERAGE_VERIFICATION_MS = 24 * 60 * 60 * 1000;

// Stores only an opaque credential digest and response telemetry. The caller owns
// response validation; `safe` decides whether a stale snapshot may admit work.
export function createQuotaCache({ directory = statePath('quota-cache'), now = () => Date.now(), ttlMs = 60_000, hardTtlMs = 300_000 } = {}) {
  const pending = new Map();
  return async function cached(provider, credential, load, { safe = value => value?.extra_usage?.is_enabled === false, sanitize = value => value,
    staleTtlMs = hardTtlMs } = {}) {
    const key = keyFor(provider, credential);
    let request = pending.get(key);
    if (request) return request;
    request = (async () => {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const directoryStat = await fs.lstat(directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || directoryStat.uid !== process.getuid()) throw new Error('quota cache directory is unsafe');
      await fs.chmod(directory, 0o700);
      const file = path.join(directory, `${key}.json`), guard = await lock(path.join(directory, `${key}.flock`));
      try {
        let entry = await read(file);
        const current = now();
        const age = entry && Number.isFinite(entry.verified_at) && entry.verified_at <= current ? current - entry.verified_at : Infinity;
        if (entry?.snapshot && age <= ttlMs) return { ...clone(entry.snapshot), quota_cache: { stale: false, verified_at: entry.verified_at, cooldown_until: entry.cooldown_until ?? null } };
        if (entry?.cooldown_until > current && entry?.snapshot && age < staleTtlMs && safe(entry.snapshot))
          return { ...clone(entry.snapshot), quota_cache: { stale: true, verified_at: entry.verified_at, cooldown_until: entry.cooldown_until,
            error: entry.error ?? 'transient_failure', ...(cachedHttpStatus(entry) === undefined ? {} : { http_status: cachedHttpStatus(entry) }) } };
        if (entry?.cooldown_until > current) throw cooldownError(entry, current);
        try {
          const snapshot = sanitize(await load());
          // Every verified response replaces prior authority, including enabled
          // overage or exhausted limits, so a negative result invalidates a prior positive.
          entry = { version: 1, provider, verified_at: now(), snapshot: clone(snapshot) };
          await write(file, entry);
          return { ...clone(snapshot), quota_cache: { stale: false, verified_at: entry.verified_at, cooldown_until: null } };
        } catch (error) {
          if (!transient(error)) { await write(file, { version: 1, provider, invalidated_at: now() }); throw error; }
          const currentAge = entry?.snapshot && Number.isFinite(entry.verified_at) && entry.verified_at <= now() ? now() - entry.verified_at : Infinity;
          // Use the original successful verification time. Failed lookups must
          // never renew financial authority, including when they are slow.
          const prior = entry?.snapshot && currentAge < staleTtlMs && safe(entry.snapshot);
          const previousDelay = Number.isFinite(entry?.backoff_ms) ? entry.backoff_ms : 0;
          const delay = Math.max(retryAfter(error), Math.min(600_000, Math.max(60_000, previousDelay ? previousDelay * 2 : 60_000)));
          const status = httpStatus(error);
          const { error_http_status: _priorStatus, ...priorEntry } = entry ?? { version: 1, provider };
          const failed = { ...priorEntry, cooldown_until: now() + delay, backoff_ms: delay,
            error: error?.detail?.reason ?? 'transient_failure', ...(status === undefined ? {} : { error_http_status: status }) };
          await write(file, failed);
          if (prior) return { ...clone(entry.snapshot), quota_cache: { stale: true, verified_at: entry.verified_at, cooldown_until: failed.cooldown_until,
            error: failed.error, ...(cachedHttpStatus(failed) === undefined ? {} : { http_status: cachedHttpStatus(failed) }) } };
          throw error;
        }
      } finally { await guard.close(); }
    })();
    pending.set(key, request);
    try { return await request; } finally { if (pending.get(key) === request) pending.delete(key); }
  };
}
