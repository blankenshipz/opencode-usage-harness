import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { configuredPython, packageRoot, statePath } from './paths.mjs';
const exec = promisify(execFile);
const lockHelper = `import fcntl, time
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
export const RUNTIME_READ_TIMEOUT_MS = 20000;
let runtimeExec = exec;
// Test seam: replace the process runner used by runtime reads.
export const setRuntimeExecForTest = fn => { runtimeExec = fn ?? exec; };
const lockedEnvironment = () => Object.fromEntries(['HOME', 'PATH', 'LANG'].flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]]]));
const runtimeRead = async (args = []) => {
  if (!process.env.HARNESS_OPENCODE_DB) throw new Error('task-dispatch: HARNESS_OPENCODE_DB is required for read-only OpenCode session ownership lookup');
  const options = { timeout: RUNTIME_READ_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, PATH: process.env.PATH, HOME: process.env.HOME, HARNESS_OPENCODE_DB: process.env.HARNESS_OPENCODE_DB } };
  const argv = [path.join(packageRoot, 'src/dispatch_runtime.py'), ...args];
  // Read-only lookup: under load one slow run must not kill a reviewer, so
  // allow 20 s and retry exactly once before surfacing the error.
  let stdout;
  try { ({ stdout } = await runtimeExec(configuredPython, argv, options)); }
  catch { ({ stdout } = await runtimeExec(configuredPython, argv, options)); }
  return JSON.parse(stdout);
};
export const runtimeSessions = () => runtimeRead();
export const runtimeIntentSources = rootID => runtimeRead(['--intent-sources', rootID]);
export const runtimeCompletionReceipt = ({ sessionID, marker, promptHash }) => runtimeRead(['--completion-receipt', sessionID, marker, promptHash]);
export const runtimeFinalText = ({ sessionID, assistantID }) => runtimeRead(['--final-text', sessionID, assistantID]);
export const runtimeTerminalReceipt = ({ sessionID, marker, promptHash }) => runtimeRead(['--terminal-receipt', sessionID, marker, promptHash]);
export const runtimeDeliveryEvidence = request => runtimeRead(['--delivery-evidence', JSON.stringify(request)]);
async function acquireLock(file, legacy) {
  const handle = await fs.open(file, 'a+', 0o600);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(configuredPython, ['-c', lockHelper], { env: lockedEnvironment(), stdio: ['ignore', 'ignore', 'ignore', handle.fd] });
      const timer = setTimeout(() => child.kill('SIGKILL'), 6000);
      child.once('error', () => { clearTimeout(timer); reject(new Error('task-dispatch: registry lock helper unavailable')); });
      child.once('close', code => {
        clearTimeout(timer);
        code === 0 ? resolve() : reject(new Error('task-dispatch: ownership registry busy or lock unavailable; retry the same task after the current admission finishes'));
      });
    });
    // Legacy writers use marker files.  They cannot be safely reconciled by a
    // flock writer, so preserving the marker is the only non-overlap option.
    for (const marker of [legacy, `${legacy}.recovery`]) {
      try { await fs.lstat(marker); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      throw new Error('task-dispatch: legacy registry lock requires operator reconciliation while all registry writers are stopped; no marker was removed');
    }
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
const sameFile = (a, b) => a && b && a.ino === b.ino && a.dev === b.dev;
// With removeLockOnRelease every participant must use this protocol: after the
// flock is granted, the path must still name the locked inode (else a releaser
// unlinked it; reopen). The holder unlinks only while still holding its lock.
async function acquireRemovableLock(lockPath, legacy) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const lock = await acquireLock(lockPath, legacy);
    const [held, current] = await Promise.all([lock.stat(), fs.stat(lockPath).catch(() => null)]);
    if (sameFile(held, current)) return lock;
    await lock.close();
  }
  throw new Error('task-dispatch: registry lock kept changing; retry later');
}
async function releaseRemovableLock(lock, lockPath) {
  try {
    const [held, current] = await Promise.all([lock.stat(), fs.stat(lockPath).catch(() => null)]);
    // Remove only our own, still-empty lock inode, and only while holding it.
    if (sameFile(held, current) && held.size === 0) await fs.unlink(lockPath).catch(() => {});
  } finally { await lock.close(); }
}
const pruneProgram = `import fcntl,os,stat,sys,time
d=sys.argv[1];cutoff=time.time()-float(sys.argv[2]);removed=0
for n in os.listdir(d):
    if not n.endswith('.flock'): continue
    p=os.path.join(d,n)
    try:
        st=os.lstat(p)
        if not stat.S_ISREG(st.st_mode) or st.st_size or st.st_mtime>cutoff or st.st_uid!=os.getuid(): continue
        fd=os.open(p,os.O_RDWR|os.O_NOFOLLOW)
        try:
            fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            own=os.fstat(fd);cur=os.stat(p)
            if (own.st_ino,own.st_dev)==(cur.st_ino,cur.st_dev) and own.st_size==0:
                os.unlink(p);removed+=1
        finally: os.close(fd)
    except OSError: pass
print(removed)
`;
// Removes leftover empty, unlocked .flock files from a removeLockOnRelease registry
// (e.g. written by older releases that kept every lock inode). Returns the count.
export async function pruneStaleLocks(directory, { minAgeMs = 10 * 60_000 } = {}) {
  try { if (!(await fs.lstat(directory)).isDirectory()) return 0; } catch { return 0; }
  const { stdout } = await exec(configuredPython, ['-c', pruneProgram, directory, String(minAgeMs / 1000)], { env: lockedEnvironment(), timeout: 30_000 });
  return Number.parseInt(stdout, 10) || 0;
}
export function createRegistry(directory = statePath('dispatch-ownership'), { removeLockOnRelease = false } = {}) {
  return async (workspace, run) => {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const name = crypto.createHash('sha256').update(workspace).digest('hex');
    const file = path.join(directory, `${name}.json`), legacy = path.join(directory, `${name}.lock`);
    const nonce = crypto.randomUUID();
    const lockPath = path.join(directory, `${name}.flock`);
    // Ownership registries keep this inode permanently (older writers do not
    // re-check the path); removable registries use the re-check protocol above.
    const lock = removeLockOnRelease ? await acquireRemovableLock(lockPath, legacy) : await acquireLock(lockPath, legacy);
    try {
      let state = { records: [] };
      try { state = JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      return await run(state, async () => {
        const temp = `${file}.${nonce}.tmp`;
        try { await fs.writeFile(temp, JSON.stringify(state), { mode: 0o600 }); await fs.rename(temp, file); }
        finally { await fs.rm(temp, { force: true }).catch(() => {}); }
      });
    } finally { if (removeLockOnRelease) await releaseRemovableLock(lock, lockPath); else await lock.close(); }
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
