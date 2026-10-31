import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { configuredPython, statePath } from './paths.mjs';

// This is deliberately an observer, rather than an admission or allocation
// mechanism.  Provider usage percentages are the only input; no token, credit,
// cost, or request data is inferred from them.
const lockProgram = `import fcntl,time
end=time.monotonic()+15
while True:
 try:
  fcntl.flock(3,fcntl.LOCK_EX|fcntl.LOCK_NB);break
 except BlockingIOError:
  if time.monotonic()>=end: raise SystemExit(1)
  time.sleep(.02)`;
const MAX_ACCOUNT_ENTRIES = 32;
const MAX_WINDOWS_PER_ACCOUNT = 8;
const MAX_SAMPLES_PER_WINDOW = 3;
const MAX_SHORT_WINDOW_MINUTES = 360;
const MAX_SAMPLE_AGE_MS = 15 * 60_000;
const MAX_CHECKED_AGE_MS = 2 * 60_000;
const MIN_SAMPLE_DELTA_MS = 60_000;

// Reader-local identity sidechannel. It is intentionally a Symbol so object
// spreads and JSON serialization used by quota telemetry cannot expose it.
export const SHORT_WINDOW_PACING_IDENTITY = Symbol('short-window-pacing-identity');

const finite = value => typeof value === 'number' && Number.isFinite(value);
const timestamp = value => {
  if (finite(value)) return value > 1e12 ? value : value * 1000;
  if (typeof value === 'string') { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : null; }
  return null;
};
const isoMinute = value => new Date(Math.round(value / 60_000) * 60_000).toISOString();
const rounded = (value, places = 1) => Math.round(value * 10 ** places) / 10 ** places;
const opaqueKey = value => crypto.createHash('sha256').update(value).digest('hex');
const safeEnv = () => Object.fromEntries(['HOME', 'PATH', 'LANG'].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));

async function withLock(file, run) {
  const handle = await fs.open(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('short-window pacing lock is unsafe');
    await new Promise((resolve, reject) => {
      const child = spawn(configuredPython, ['-c', lockProgram], { env: safeEnv(), stdio: ['ignore', 'ignore', 'ignore', handle.fd] });
      const timer = setTimeout(() => child.kill('SIGKILL'), 16_000);
      child.once('error', () => { clearTimeout(timer); reject(new Error('short-window pacing lock unavailable')); });
      child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('short-window pacing busy')); });
    });
    return await run();
  } finally { await handle.close().catch(() => {}); }
}
async function read(file) {
  let handle;
  try {
    handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077)) return null;
    const value = JSON.parse(await handle.readFile('utf8'));
    return value?.version === 1 && value.accounts && typeof value.accounts === 'object' ? value : null;
  } catch { return null; }
  finally { await handle?.close().catch(() => {}); }
}
async function write(file, value) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 }); await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}

function accountIdentity(provider, identity) {
  if (typeof provider !== 'string' || typeof identity !== 'string' || !identity) return null;
  // The reader fingerprint never appears in output. Hash it again because this
  // is a persistent namespace and filenames/payloads must never reveal it.
  return opaqueKey(`${provider}\0${identity}`);
}
function shortWindows(pool, now) {
  return (Array.isArray(pool?.windows) ? pool.windows : []).filter(window => window?.scope === 'account' &&
    finite(window.used_percent) && window.used_percent >= 0 && window.used_percent <= 100 &&
    finite(window.duration_minutes) && window.duration_minutes > 0 && window.duration_minutes <= MAX_SHORT_WINDOW_MINUTES &&
    finite(timestamp(window.resets_at)) && timestamp(window.resets_at) > now && typeof window.kind === 'string');
}
function empty(reason, windows = []) { return { status: 'unknown', reason, windows }; }
function windowId(window) { return `${window.kind}|${window.duration_minutes}|${timestamp(window.resets_at)}`; }
function publicWindow(window, samples, now, reason) {
  const base = { kind: window.kind, duration_minutes: window.duration_minutes, resets_at: isoMinute(timestamp(window.resets_at)), observed_samples: samples.length };
  if (samples.length < 2) return { ...base, status: 'unknown', reason: reason ?? 'insufficient_fresh_samples' };
  const previous = samples.at(-2), current = samples.at(-1);
  const elapsed = current.at - previous.at, increase = current.used_percent - previous.used_percent;
  if (elapsed < MIN_SAMPLE_DELTA_MS) return { ...base, status: 'unknown', reason: 'samples_too_close' };
  if (increase <= 0) return { ...base, status: 'unknown', reason: increase < 0 ? 'counter_reset_or_decrease' : 'no_observed_usage_change' };
  const ratePerMinute = increase / (elapsed / 60_000);
  const etaMinutes = (100 - current.used_percent) / ratePerMinute;
  const exhaustionAt = current.at + etaMinutes * 60_000;
  const beforeReset = exhaustionAt < timestamp(window.resets_at);
  return {
    ...base, status: 'estimated', observed_minutes: Math.round(elapsed / 60_000), usage_change_percent: rounded(increase),
    usage_rate_percent_per_hour: rounded(ratePerMinute * 60),
    estimated_minutes_to_exhaustion: beforeReset ? Math.max(0, Math.round(etaMinutes)) : null,
    estimated_exhaustion_at: beforeReset ? isoMinute(exhaustionAt) : null,
    reset_before_estimated_exhaustion: !beforeReset,
  };
}
function trim(state, now) {
  const accounts = Object.entries(state.accounts).filter(([, account]) => account && typeof account === 'object');
  accounts.sort((a, b) => (b[1].updated_at ?? 0) - (a[1].updated_at ?? 0));
  state.accounts = Object.fromEntries(accounts.slice(0, MAX_ACCOUNT_ENTRIES));
  for (const account of Object.values(state.accounts)) {
    const windows = Object.entries(account.windows ?? {}).filter(([, entry]) => entry && Array.isArray(entry.samples) &&
      entry.samples.some(sample => finite(sample.at) && sample.at >= now - MAX_SAMPLE_AGE_MS && sample.at <= now + 5_000));
    windows.sort((a, b) => (b[1].updated_at ?? 0) - (a[1].updated_at ?? 0));
    account.windows = Object.fromEntries(windows.slice(0, MAX_WINDOWS_PER_ACCOUNT));
  }
}

export function createShortWindowPacingStore({ directory = statePath('short-window-pacing'), now = () => Date.now() } = {}) {
  const file = path.join(directory, 'history.json');
  const guard = path.join(directory, 'history.flock');
  const pending = new Map();
  return {
    async observe(pool, { identity } = {}) {
      const current = now();
      const checkedAt = timestamp(pool?.checked_at);
      const windows = shortWindows(pool, current);
      if (!windows.length) return empty('short_window_unavailable');
      if (checkedAt === null || checkedAt > current + 5_000 || current - checkedAt > MAX_CHECKED_AGE_MS) return empty('stale_or_invalid');
      const account = accountIdentity(pool?.provider, identity);
      if (!account) return empty('account_identity_unavailable');
      let request = pending.get(account);
      if (!request) {
        request = (async () => {
          await fs.mkdir(directory, { recursive: true, mode: 0o700 });
          const directoryStat = await fs.lstat(directory);
          if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || directoryStat.uid !== process.getuid()) throw new Error('short-window pacing directory is unsafe');
          await fs.chmod(directory, 0o700);
          return withLock(guard, async () => {
            const state = await read(file) ?? { version: 1, accounts: {} };
            const accountHistory = state.accounts[account] ?? { updated_at: current, windows: {} };
            const assessments = [];
            for (const window of windows) {
              const id = windowId(window);
              let entry = accountHistory.windows[id] ?? { updated_at: current, samples: [] };
              let samples = entry.samples.filter(sample => finite(sample?.at) && finite(sample?.used_percent) &&
                sample.at >= current - MAX_SAMPLE_AGE_MS && sample.at <= current + 5_000).sort((a, b) => a.at - b.at);
              const latest = samples.at(-1);
              let reason;
              if (!latest || checkedAt > latest.at) {
                if (latest && window.used_percent < latest.used_percent) { samples = []; reason = 'counter_reset_or_decrease'; }
                samples.push({ at: checkedAt, used_percent: window.used_percent });
              }
              samples = samples.slice(-MAX_SAMPLES_PER_WINDOW);
              entry = { updated_at: current, samples };
              accountHistory.windows[id] = entry;
              assessments.push(publicWindow(window, samples, current, reason));
            }
            accountHistory.updated_at = current;
            state.accounts[account] = accountHistory;
            trim(state, current);
            await write(file, state);
            return { status: assessments.some(item => item.status === 'estimated') ? 'estimated' : 'unknown',
              reason: assessments.some(item => item.status === 'estimated') ? undefined : assessments[0]?.reason ?? 'insufficient_fresh_samples', windows: assessments };
          });
        })();
        pending.set(account, request);
      }
      try { return await request; } finally { if (pending.get(account) === request) pending.delete(account); }
    },
  };
}

export const defaultShortWindowPacingStore = createShortWindowPacingStore();
