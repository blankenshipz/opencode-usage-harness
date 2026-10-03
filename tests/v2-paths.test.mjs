import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const exec = promisify(execFile);
const moduleURL = new URL('../plugins/v2/paths.mjs', import.meta.url).href;

test('portable plugin paths use the configured state root and module package root', async () => {
  const state = '/tmp/harness-state-fixture';
  const { stdout } = await exec(process.execPath, ['--input-type=module', '--eval',
    `import { packageRoot, stateRoot, managedConfigRoot } from ${JSON.stringify(moduleURL)}; console.log(JSON.stringify({ packageRoot, stateRoot, managedConfigRoot }));`],
  { env: { ...process.env, HARNESS_STATE_DIR: state } });
  const paths = JSON.parse(stdout);
  assert.equal(paths.stateRoot, state);
  assert.equal(paths.managedConfigRoot, `${state}/config`);
  assert.match(paths.packageRoot, /opencode-usage-harness$/);
});

test('default task outcome persistence writes below the configured state root', async () => {
  const state = await mkdtemp(join(tmpdir(), 'harness-state-'));
  const outcomeURL = new URL('../plugins/v2/task-outcomes.mjs', import.meta.url).href;
  try {
    await exec(process.execPath, ['--input-type=module', '--eval',
      `import { createV2TaskOutcomes } from ${JSON.stringify(outcomeURL)};
       const tools = new Map();
       const cleanup = await createV2TaskOutcomes().setup({ tool: { transform: async callback => callback({ add: tool => tools.set(tool.name, tool) }) }, event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) } });
       await tools.get('task_outcome').execute({ taskId: 'fixture', scope: 'checkpoint', status: 'blocked', blocker: { kind: 'environment', evidence: 'fixture unavailable', nextAction: 'supply fixture' } }, { sessionID: 'fixture-session', messageID: 'fixture-message', agent: 'builder' });
       cleanup();`], { env: { ...process.env, HARNESS_STATE_DIR: state } });
    const records = await readFile(join(state, 'telemetry', 'task-outcomes.jsonl'), 'utf8');
    assert.match(records, /fixture-session/);
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});
