import test from 'node:test';
import assert from 'node:assert/strict';
import { installAgentAttribution } from '../plugins/v2/agent-attribution.mjs';

const fakeCtx = () => {
  const hooks = {};
  return { hooks, tool: { hook: async (n, f) => { hooks['tool:' + n] = f; } }, shell: { hook: async (n, f) => { hooks['shell:' + n] = f; } } };
};

test('sets attribution env for shells of a known session', async () => {
  const ctx = fakeCtx();
  await installAgentAttribution(ctx);
  await ctx.hooks['tool:execute.before']({ tool: 'shell', sessionID: 'ses_1', agent: 'builder' });
  const event = { command: 'git commit', env: { PATH: '/bin' }, metadata: { sessionID: 'ses_1' } };
  await ctx.hooks['shell:create.before'](event);
  assert.deepEqual(event.env, { PATH: '/bin', HARNESS_AGENT: 'builder', HARNESS_ROLE: 'builder', WORKRELAY_SESSION_ID: 'ses_1' });
});

test('existing values win and unknown sessions get only the session id', async () => {
  const ctx = fakeCtx();
  await installAgentAttribution(ctx);
  await ctx.hooks['tool:execute.before']({ sessionID: 'ses_1', agent: 'builder' });
  const preset = { env: { HARNESS_AGENT: 'harny', WORKRELAY_SESSION_ID: 'wr_9' }, metadata: { sessionID: 'ses_1' } };
  await ctx.hooks['shell:create.before'](preset);
  assert.deepEqual(preset.env, { HARNESS_AGENT: 'harny', HARNESS_ROLE: 'builder', WORKRELAY_SESSION_ID: 'wr_9' });
  const unknown = { env: {}, metadata: { sessionID: 'ses_2' } };
  await ctx.hooks['shell:create.before'](unknown);
  assert.deepEqual(unknown.env, { WORKRELAY_SESSION_ID: 'ses_2' });
  const terminal = { env: {} };
  await ctx.hooks['shell:create.before'](terminal);
  assert.deepEqual(terminal.env, {});
});

test('no-op without a shell hook API', async () => {
  const result = await installAgentAttribution({ tool: { hook: async () => { throw new Error('unused'); } } });
  assert.equal(result.agents.size, 0);
});
