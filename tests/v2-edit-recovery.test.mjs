import test from 'node:test';
import assert from 'node:assert/strict';
import { installEditRecovery } from '../plugins/v2/edit-recovery.mjs';

const malformed = '*** Begin Patch\n*** Update File: app.js\nnot a patch\n*** End Patch';
const changed = '*** Begin Patch\n*** Update File: app.js\n-old\n+new\n*** End Patch';

function harness({ failure = 'patch verification failed: Failed to find expected lines', stat } = {}) {
  const tools = new Map(); const calls = [];
  const patch = { name: 'patch', description: 'native', execute: async input => { calls.push(input); if (failure) throw new Error(failure); return { content: 'native success' }; } };
  const editor = { get: name => name === 'patch' ? patch : undefined, update: (name, apply) => { apply(patch); tools.set(name, patch); } };
  const fileSystem = { stat: async file => stat?.(file) ?? { dev: 1, ino: 2, size: 3, mtimeMs: 4, ctimeMs: 5 } };
  return installEditRecovery({ location: { directory: '/workspace' }, tool: { transform: async callback => callback(editor) } }, { fileSystem }).then(cleanup => ({ tools, calls, cleanup }));
}

const call = (tool, patchText, sessionID = 's1') => tool.execute({ patchText }, { sessionID });

test('denies a repeated malformed patch in one session without invoking native patch', async () => {
  let version = 1;
  const h = await harness({ failure: 'patch verification failed: Invalid hunk at line 3', stat: () => ({ dev: 1, ino: 2, size: version, mtimeMs: version, ctimeMs: version }) });
  await assert.rejects(call(h.tools.get('patch'), malformed), /Invalid hunk/);
  version = 2;
  const denied = await call(h.tools.get('patch'), malformed);
  assert.match(denied.content, /identical patch previously failed/);
  assert.equal(h.calls.length, 1);
  h.cleanup();
});

test('changed payload is permitted after a deterministic failure', async () => {
  const h = await harness(); const tool = h.tools.get('patch');
  await assert.rejects(call(tool, changed), /verification failed/);
  await assert.rejects(call(tool, `${changed}\n`), /verification failed/);
  assert.equal(h.calls.length, 2);
  h.cleanup();
});

test('changed target fingerprint permits an identical stale-context retry', async () => {
  let version = 1;
  const h = await harness({ stat: () => ({ dev: 1, ino: 2, size: version, mtimeMs: version, ctimeMs: version }) }); const tool = h.tools.get('patch');
  await assert.rejects(call(tool, changed), /verification failed/);
  const denied = await call(tool, changed); assert.match(denied.content, /unchanged target/);
  version = 2;
  await assert.rejects(call(tool, changed), /verification failed/);
  assert.equal(h.calls.length, 2);
  h.cleanup();
});

test('failure cache is session-scoped and transient failures are never gated', async () => {
  const isolated = await harness(); const tool = isolated.tools.get('patch');
  await assert.rejects(call(tool, changed, 'a'), /verification failed/);
  await assert.rejects(call(tool, changed, 'b'), /verification failed/);
  assert.equal(isolated.calls.length, 2); isolated.cleanup();
  const transient = await harness({ failure: 'patch verification failed: permission denied by remote service' }); const transientTool = transient.tools.get('patch');
  await assert.rejects(call(transientTool, changed), /permission denied/);
  await assert.rejects(call(transientTool, changed), /permission denied/);
  assert.equal(transient.calls.length, 2); transient.cleanup();
});

test('unavailable metadata does not unlock an unchanged deterministic failure', async () => {
 const h=await harness({stat:()=>{const e=new Error('stat denied');e.code='EACCES';throw e;}});
 await assert.rejects(call(h.tools.get('patch'),changed),/verification failed/);
 const denied=await call(h.tools.get('patch'),changed);assert.match(denied.content,/identical patch/);assert.equal(h.calls.length,1);h.cleanup();
});
