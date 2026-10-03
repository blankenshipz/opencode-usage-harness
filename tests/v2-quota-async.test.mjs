import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createV2Guard } from '../plugins/v2/subscription-guard.mjs';

async function quotaTool(options) {
  let tool;
  const cleanup = await createV2Guard(options).setup({
    provider: { transform: async () => {} },
    tool: { transform: async callback => callback({ add: candidate => { tool = candidate; } }) },
    session: { hook: async () => {} },
    event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
  });
  return { tool, cleanup };
}

async function fakeQuota(mode) {
  const directory = await mkdtemp(join(tmpdir(), 'subscription-guard-quota-'));
  const command = join(directory, 'codex-quota');
  const body = mode === 'slow'
    ? 'setTimeout(() => process.exit(0), 1000);\n'
    : "process.stderr.write('quota unavailable: quota_rpc_failed\\n'); process.exit(2);\n";
  await writeFile(command, `#!${process.execPath}\n${body}`);
  await chmod(command, 0o700);
  return { directory, command };
}

test('V2 default quota runner leaves timers responsive and preserves timeout/nonzero diagnostics', async () => {
  const slowFake = await fakeQuota('slow');
  const nonzeroFake = await fakeQuota('nonzero');
  try {
    const slow = await quotaTool({ quotaCommand: slowFake.command, quotaDeadline: 500 });
    let timerRan = false;
    const started = performance.now();
    const timer = new Promise(resolve => setTimeout(() => {
      timerRan = true;
      resolve(performance.now() - started);
    }, 15));
    const pending = slow.tool.execute({});
    const timerElapsed = await timer;
    assert.equal(timerRan, true, 'a timer must run while the child process is pending');
    assert.ok(timerElapsed < 300, `quota execution delayed the timer for ${timerElapsed}ms`);
    await assert.rejects(pending, error => {
      assert.equal(error.code, 'SUBSCRIPTION_QUOTA_CHECK_FAILED');
      assert.equal(error.detail.operation, 'read');
      assert.equal(error.detail.reason, 'timeout');
      assert.equal(error.detail.timeout_ms, 500);
      assert.equal(error.detail.signal, 'SIGTERM');
      return true;
    });
    slow.cleanup();

    const nonzero = await quotaTool({ quotaCommand: nonzeroFake.command, quotaDeadline: 10000 });
    await assert.rejects(nonzero.tool.execute({}), error => {
      assert.equal(error.code, 'SUBSCRIPTION_QUOTA_CHECK_FAILED');
      assert.equal(error.detail.operation, 'read');
      assert.equal(error.detail.reason, 'telemetry_unavailable');
      assert.equal(error.detail.status, 2);
      assert.equal(error.detail.telemetry_reason, 'quota_rpc_failed');
      return true;
    });
    nonzero.cleanup();
  } finally {
    await Promise.all([rm(slowFake.directory, { recursive: true, force: true }),
      rm(nonzeroFake.directory, { recursive: true, force: true })]);
  }
});

test('default quota subprocess receives only portable harness configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'subscription-guard-env-'));
  const command = join(directory, 'codex-quota');
  try {
    await writeFile(command, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({ state: process.env.HARNESS_STATE_DIR, codex: process.env.CODEX_HOME, binary: process.env.HARNESS_CODEX_BIN, python: process.env.HARNESS_PYTHON, api: process.env.OPENAI_API_KEY }));\n`);
    await chmod(command, 0o700);
    const { tool, cleanup } = await quotaTool({ quotaCommand: command, env: {
      HOME: '/tmp/home', PATH: process.env.PATH, LANG: 'C', HARNESS_STATE_DIR: '/tmp/state', CODEX_HOME: '/tmp/codex',
      HARNESS_CODEX_BIN: '/tmp/codex-bin', HARNESS_PYTHON: '/tmp/python', OPENAI_API_KEY: 'must-not-pass',
    } });
    const received = JSON.parse((await tool.execute({})).content);
    assert.deepEqual(received, { state: '/tmp/state', codex: '/tmp/codex', binary: '/tmp/codex-bin', python: '/tmp/python' });
    cleanup();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
