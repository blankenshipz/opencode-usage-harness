import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { configuredPython, packageRoot, statePath } from './paths.mjs';
const exec = promisify(execFile);
const runtimeRead = async (args = []) => {
  if (!process.env.HARNESS_OPENCODE_DB) throw new Error('task-dispatch: HARNESS_OPENCODE_DB is required for read-only OpenCode session ownership lookup');
  const { stdout } = await exec(configuredPython, [path.join(packageRoot, 'src/dispatch_runtime.py'), ...args], { timeout: 5000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, PATH: process.env.PATH, HOME: process.env.HOME, HARNESS_OPENCODE_DB: process.env.HARNESS_OPENCODE_DB } });
  return JSON.parse(stdout);
};
export const runtimeSessions = () => runtimeRead();
export const runtimeIntentSources = rootID => runtimeRead(['--intent-sources', rootID]);
// Python locks the inherited open-file description. The parent retains its fd:
// helper exit cannot release the lock while the JS callback is still running.
// Process death closes the descriptor in the kernel; no PID/reaper files needed.
const flockHelper = `import fcntl, time
end = time.monotonic() + 5
while True:
    try:
        fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)
        break
    except BlockingIOError:
        if time.monotonic() >= end:
            raise SystemExit(1)
        time.sleep(0.02)
`;
async function acquireLock(file, legacy) {
  const handle = await fs.open(file, 'a+', 0o600);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(configuredPython, ['-c', flockHelper],
        { stdio: ['ignore', 'ignore', 'ignore', handle.fd] });
      const timer = setTimeout(() => child.kill('SIGKILL'), 6000);
      child.once('error', () => { clearTimeout(timer); reject(new Error('task-dispatch: registry lock helper unavailable')); });
      child.once('close', code => {
        clearTimeout(timer);
        code === 0 ? resolve() : reject(new Error('task-dispatch: ownership registry busy or lock unavailable; retry the same task after the current admission finishes'));
      });
    });
    // Old processes use exclusive marker files, not flock. Never delete those
    // markers or overlap their owners. Upgrade/rollback requires quiescence.
    for (const marker of [legacy, `${legacy}.recovery`]) {
      try { await fs.lstat(marker); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      throw new Error('task-dispatch: legacy registry lock requires operator reconciliation while all registry writers are stopped; no marker was removed');
    }
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
export function createRegistry(directory = statePath('dispatch-ownership')) {
  return async (workspace, run) => {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const name = crypto.createHash('sha256').update(workspace).digest('hex');
    const file = path.join(directory, `${name}.json`), legacy = path.join(directory, `${name}.lock`);
    const nonce = crypto.randomUUID();
    // Keep this inode permanently: unlinking a flock file would split owners.
    const lock = await acquireLock(path.join(directory, `${name}.flock`), legacy);
    try {
      let state = { records: [] };
      try { state = JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      return await run(state, async () => {
        const temp = `${file}.${nonce}.tmp`;
        try { await fs.writeFile(temp, JSON.stringify(state), { mode: 0o600 }); await fs.rename(temp, file); }
        finally { await fs.rm(temp, { force: true }).catch(() => {}); }
      });
    } finally { await lock.close(); }
  };
}
export function lineage(sessions, id) {
  const map = new Map(sessions.map(s => [s.id, s]));
  let current = map.get(id);
  if (!current) throw new Error(`task-dispatch: session ${id} is unavailable`);
  const seen = new Set();
  while (current.parentID) {
    if (seen.has(current.id)) throw new Error('task-dispatch: invalid session ancestry');
    seen.add(current.id); current = map.get(current.parentID);
    if (!current) throw new Error('task-dispatch: parent session is unavailable');
  }
  return current.id;
}
export function overlaps(a, b) {
  return a.some(left => b.some(right => left === '.' || right === '.' || left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)));
}
export const descendant = (sessions, id, ancestor) => {
  const map = new Map(sessions.map(s => [s.id,s])); const seen = new Set();
  for (let s = map.get(id); s?.parentID && !seen.has(s.id); s = map.get(s.parentID)) { if (s.parentID === ancestor) return true; seen.add(s.id); }
  return false;
};
