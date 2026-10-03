import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
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
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
export function createRegistry(directory = statePath('dispatch-ownership')) {
  return async (workspace, run) => {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const name = crypto.createHash('sha256').update(workspace).digest('hex');
    const file = path.join(directory, `${name}.json`), lock = path.join(directory, `${name}.lock`);
    const nonce = crypto.randomUUID();
    // Atomic exclusive file creation: the lock contains only ownership metadata.
    const deadline = Date.now() + 5000;
    for (;;) {
      try { const handle = await fs.open(lock, 'wx', 0o600); try { await handle.writeFile(JSON.stringify({ pid: process.pid, nonce })); } finally { await handle.close(); } break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let owner;
        try { owner = JSON.parse(await fs.readFile(lock, 'utf8')); } catch { /* Writer may still be publishing the lock; fail closed if it stays malformed. */ }
        if (owner?.pid && !alive(owner.pid)) {
          // Rename recovery is serialized by an exclusive recovery file; recheck owner under it.
          const recovery = `${lock}.recovery`;
          let handle;
          try {
            handle = await fs.open(recovery, 'wx', 0o600);
            const current = JSON.parse(await fs.readFile(lock, 'utf8'));
            if (current.nonce === owner.nonce && !alive(current.pid)) await fs.unlink(lock);
          } catch (e) { if (!['EEXIST', 'ENOENT'].includes(e.code)) throw e; }
          finally { if (handle) { await handle.close(); await fs.unlink(recovery).catch(() => {}); } }
        }
        if (Date.now() >= deadline) throw new Error('task-dispatch: ownership registry busy; retry this same task after the current admission finishes');
        await sleep(20);
      }
    }
    try {
      let state = { records: [] };
      try { state = JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      return await run(state, async () => {
        const temp = `${file}.${nonce}.tmp`;
        try { await fs.writeFile(temp, JSON.stringify(state), { mode: 0o600 }); await fs.rename(temp, file); }
        finally { await fs.rm(temp, { force: true }).catch(() => {}); }
      });
    } finally {
      const owner = JSON.parse(await fs.readFile(lock, 'utf8'));
      if (owner.nonce === nonce) await fs.unlink(lock);
    }
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
