import test from 'node:test';
import assert from 'node:assert/strict';
import { RUNTIME_READ_TIMEOUT_MS, runtimeSessions, setRuntimeExecForTest } from '../plugins/v2/dispatch-registry.mjs';

test('runtime read uses a 20 s timeout and retries once', async () => {
  process.env.HARNESS_OPENCODE_DB ??= '/nonexistent/opencode.db';
  const calls = [];
  setRuntimeExecForTest(async (cmd, argv, options) => {
    calls.push(options.timeout);
    if (calls.length === 1) throw new Error('timeout');
    return { stdout: '{"ok":true}' };
  });
  try {
    assert.equal(RUNTIME_READ_TIMEOUT_MS, 20000);
    assert.deepEqual(await runtimeSessions(), { ok: true });
    assert.deepEqual(calls, [20000, 20000]);
  } finally { setRuntimeExecForTest(); }
});

test('runtime read gives up after the single retry', async () => {
  process.env.HARNESS_OPENCODE_DB ??= '/nonexistent/opencode.db';
  let count = 0;
  setRuntimeExecForTest(async () => { count++; throw new Error('boom'); });
  try {
    await assert.rejects(runtimeSessions(), /boom/);
    assert.equal(count, 2);
  } finally { setRuntimeExecForTest(); }
});
