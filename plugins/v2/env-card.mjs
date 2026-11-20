// Environment card: a short, cached probe of what the machine offers (binaries,
// services, network, scratch dir), injected into router/coordinator/builder system
// prompts so agents stop at the first missing prerequisite instead of searching
// the filesystem (which raises permission asks). Refreshed on each new root session.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import dns from 'node:dns';
import { statePath } from './paths.mjs';
import { canonicalHarnessRole } from './agent-mode.mjs';
import { installAutoPermission } from './auto-permission.mjs';

export const PROBED_BINARIES = ['node', 'npm', 'python3', 'pytest', 'go', 'cargo', 'git', 'psql', 'postgres', 'pg_ctl', 'docker', 'podman', 'minio', 'aws', 'gh', 'make'];
const PG_SOCKETS = ['/var/run/postgresql/.s.PGSQL.5432', '/tmp/.s.PGSQL.5432'];
const DOCKER_SOCKET = '/var/run/docker.sock';
const CARD_ROLES = new Set(['router', 'coordinator', 'builder', 'builder-high', 'quick-builder']);
export const CARD_RULE = 'Stop at the first missing prerequisite (binary, service, credential) and report it to your parent instead of searching the filesystem for alternatives. Use .review/ for scratch files, never /tmp or $HOME.';
export const ASK_TRIGGERS = 'Permission asks are triggered by: reads outside the repo (esp. /home/box/*, credential dirs), writes outside the repo/.review, background processes, network deploys.';

const defaultExec = {
  exists: p => { try { fs.statSync(p); return true; } catch { return false; } },
  executable: p => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } },
  dnsLookup: (host, timeoutMs) => new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    dns.lookup(host, err => { clearTimeout(timer); resolve(!err); });
  }),
  env: process.env,
};

const inside = (root, target) => target === root || target.startsWith(root + '/');

// Creates <repo>/.review (0700), realpath-checked inside the repo, and excludes it via .git/info/exclude.
export function ensureScratchDir(directory, { fsImpl = fs } = {}) {
  const repo = fsImpl.realpathSync(directory);
  const scratch = path.join(repo, '.review');
  if (!fsImpl.existsSync(scratch)) fsImpl.mkdirSync(scratch, { mode: 0o700 });
  const real = fsImpl.realpathSync(scratch);
  if (!inside(repo, real) || real === repo) throw new Error('env-card: .review escapes the repo');
  try {
    const gitDir = path.join(repo, '.git');
    if (fsImpl.statSync(gitDir).isDirectory()) {
      const exclude = path.join(gitDir, 'info', 'exclude');
      const current = fsImpl.existsSync(exclude) ? fsImpl.readFileSync(exclude, 'utf8') : '';
      const ignored = current.split('\n').some(line => ['.review', '.review/', '/.review', '/.review/'].includes(line.trim()));
      if (!ignored) {
        fsImpl.mkdirSync(path.dirname(exclude), { recursive: true });
        fsImpl.appendFileSync(exclude, (current && !current.endsWith('\n') ? '\n' : '') + '.review/\n');
      }
    }
  } catch { /* worktrees (.git file) or read-only git dirs: scratch still usable */ }
  return real;
}

export async function probeEnvironment(directory, { exec = {} } = {}) {
  const x = { ...defaultExec, ...exec };
  const dirs = String(x.env?.PATH ?? '').split(':').filter(d => d && path.isAbsolute(d));
  const binaries = {};
  for (const name of PROBED_BINARIES) binaries[name] = dirs.some(d => x.executable(path.join(d, name)));
  const postgresRunning = PG_SOCKETS.some(s => x.exists(s));
  const dockerSocket = x.exists(DOCKER_SOCKET);
  let network = false;
  try { network = await x.dnsLookup('registry.npmjs.org', 2000); } catch { network = false; }
  let scratch, scratchError;
  try { scratch = (x.ensureScratch ?? ensureScratchDir)(directory); } catch (error) { scratchError = String(error?.message ?? error).slice(0, 120); }
  return { directory, at: new Date().toISOString(), binaries, postgresRunning, dockerSocket, network, scratch, scratchError };
}

export function renderCard(probe) {
  const present = PROBED_BINARIES.filter(n => probe.binaries?.[n]);
  const missing = PROBED_BINARIES.filter(n => !probe.binaries?.[n]);
  const lines = [
    'Environment card:',
    `- present: ${present.join(' ') || 'none'}`,
    `- missing: ${missing.join(' ') || 'none'}`,
    `- postgres server: ${probe.postgresRunning ? 'running' : 'not running'}; docker socket: ${probe.dockerSocket ? 'yes' : 'no'}`,
    `- network (registry.npmjs.org DNS): ${probe.network ? 'reachable' : 'unreachable'}`,
    `- scratch: ${probe.scratch ? '.review/ (git-excluded)' : 'unavailable'}`,
    `- ${ASK_TRIGGERS}`,
    CARD_RULE,
  ];
  return lines.join('\n').slice(0, 899);
}

export function cardFile(directory) {
  return statePath('env-cards', crypto.createHash('sha256').update(String(directory)).digest('hex').slice(0, 16) + '.json');
}

export function createEnvCardCache({ probe = probeEnvironment, write = writeCardFile } = {}) {
  const cache = new Map(); // directory -> Promise<text>
  const refresh = directory => {
    const pending = (async () => {
      const result = await probe(directory);
      const text = renderCard(result);
      try { await write(directory, { ...result, card: text }); } catch { /* persistence is best effort */ }
      return text;
    })();
    cache.set(directory, pending);
    pending.catch(() => { if (cache.get(directory) === pending) cache.delete(directory); });
    return pending;
  };
  return { get: directory => cache.get(directory) ?? refresh(directory), refresh, cache };
}

async function writeCardFile(directory, record) {
  const file = cardFile(directory);
  await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(file, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
}

export async function installEnvCard(ctx, { cache = createEnvCardCache(), autoPermission = installAutoPermission } = {}) {
  const directory = ctx?.location?.directory;
  const stopAuto = await autoPermission(ctx);
  if (!directory) return { stop() { stopAuto?.stop?.(); } };
  const controller = new AbortController();
  if (ctx.session?.hook) await ctx.session.hook('context', async event => {
    if (!CARD_ROLES.has(canonicalHarnessRole(event?.agent)) || !Array.isArray(event.system)) return;
    let text;
    try { text = await cache.get(directory); } catch { return; }
    if (text && !event.system.some(p => p?.text === text)) event.system.push({ type: 'text', text });
  });
  if (typeof ctx.event?.subscribe === 'function') void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        const info = event?.data?.info ?? event?.data ?? {};
        if (event?.type === 'session.created' && !info.parentID) cache.refresh(directory).catch(() => {});
      }
    } catch { /* card refresh is best effort */ }
  })();
  return { cache, stop() { controller.abort(); stopAuto?.stop?.(); } };
}
