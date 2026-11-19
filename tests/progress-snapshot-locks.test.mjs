import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProgressStore } from '../plugins/v2/progress-snapshots.mjs';
import { createRegistry, pruneStaleLocks } from '../plugins/v2/dispatch-registry.mjs';
import { spawn } from 'node:child_process';

const progress = (call, at) => ({ type: 'session.tool.progress', created: at, data: { sessionID: 'ses_p', assistantMessageID: 'msg_a', id: call,
  metadata: { sessionID: 'ses_c', workerProgress: { state: 'working', phase: 'reasoning', updatedAt: at } } } });
const flocks = async dir => (await fs.readdir(dir)).filter(n => n.endsWith('.flock'));

test('progress store removes its lock file on release and keeps snapshots', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'progress-locks-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = createProgressStore(dir);
  await Promise.all(Array.from({ length: 6 }, (_, i) => store.observe(progress(`call_${i % 3}`, 10 + i))));
  await store.observe({ type: 'session.tool.success', created: 99, data: { sessionID: 'ses_p', assistantMessageID: 'msg_b', id: 'call_x' } });
  assert.deepEqual(await flocks(dir), []);
  assert.equal((await store.read('ses_p', 'msg_a', 'call_2')).workerProgress.updatedAt, 15);
});

test('removable registry keeps mutual exclusion under contention while unlinking locks', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'progress-locks-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const registry = createRegistry(dir, { removeLockOnRelease: true });
  let inside = 0, maxInside = 0;
  await Promise.all(Array.from({ length: 12 }, (_, i) => registry('same-key', async (state, save) => {
    inside++; maxInside = Math.max(maxInside, inside);
    await new Promise(r => setTimeout(r, 5));
    state.records.push(i); await save(); inside--;
  })));
  assert.equal(maxInside, 1);
  const saved = JSON.parse(await fs.readFile(path.join(dir, (await fs.readdir(dir)).find(n => n.endsWith('.json'))), 'utf8'));
  assert.equal(saved.records.length, 12);
  assert.deepEqual(await flocks(dir), []);
});

test('ownership registries keep their lock inode (default behavior unchanged)', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'registry-locks-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await createRegistry(dir)('ws', async () => {});
  assert.equal((await flocks(dir)).length, 1);
});

test('prune removes only old, empty, unlocked lock files', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'progress-prune-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const old = new Date(Date.now() - 3600_000);
  for (const name of ['a.flock', 'b.flock', 'held.flock', 'data.flock', 'new.flock', 'x.json']) await fs.writeFile(path.join(dir, name), name === 'data.flock' ? 'x' : '', { mode: 0o600 });
  for (const name of ['a.flock', 'b.flock', 'held.flock', 'data.flock', 'x.json']) await fs.utimes(path.join(dir, name), old, old);
  // Another process holds held.flock.
  const holder = spawn('python3', ['-c', 'import fcntl,sys,time;f=open(sys.argv[1],"a");fcntl.flock(f,fcntl.LOCK_EX);print("ok",flush=True);time.sleep(30)', path.join(dir, 'held.flock')], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => holder.kill('SIGKILL'));
  await new Promise(resolve => holder.stdout.once('data', resolve));
  assert.equal(await pruneStaleLocks(dir), 2);
  assert.deepEqual((await fs.readdir(dir)).sort(), ['data.flock', 'held.flock', 'new.flock', 'x.json']);
  assert.equal(await createProgressStore(path.join(dir, 'absent')).pruneLocks(), 0);
});
