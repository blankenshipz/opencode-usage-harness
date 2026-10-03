import test from 'node:test';
import assert from 'node:assert/strict';
import plugin from '../plugins/v2/model-status.mjs';

async function install(ctx) {
  const tools = [];
  await plugin.setup({
    ...ctx,
    tool: { transform: async callback => callback({ add: tool => tools.push(tool) }) },
  });
  assert.equal(tools.length, 1);
  return tools[0];
}

test('reports effective V2 agent model and runtime advertisement', async () => {
  const tool = await install({
    agent: { list: async () => ({ data: [{ id: 'router', name: 'router', mode: 'primary', model: { providerID: 'openai', id: 'gpt-6-luna', variant: 'low' } }] }) },
    model: { list: async () => ({ data: [{ providerID: 'openai', id: 'gpt-6-luna', name: 'Luna', variants: [{ id: 'low' }], status: 'active' }] }) },
  });
  const result = JSON.parse((await tool.execute()).content);
  assert.equal(result.source, 'effective V2 runtime catalog');
  assert.equal(result.roles[0].role, 'router');
  assert.equal(result.roles[0].model, 'openai/gpt-6-luna');
  assert.equal(result.roles[0].effort, 'low');
  assert.equal(result.roles[0].mode, 'primary');
  assert.equal(result.roles[0].advertised_in_catalog, true);
  assert.equal(result.roles[0].effort_advertised_in_catalog, true);
  assert.equal(result.roles[0].availability_current, true);
  assert.ok(['historically_passed', 'unverified'].includes(result.roles[0].inference_validation.status));
});

test('does not infer availability or validation from a missing runtime model', async () => {
  const tool = await install({
    agent: { list: async () => ({ data: [{ id: 'builder', model: { providerID: 'openai', id: 'gpt-6-sol', variant: 'unlisted-effort' } }] }) },
    model: { list: async () => ({ data: [] }) },
  });
  const result = JSON.parse((await tool.execute()).content);
  assert.equal(result.roles[0].advertised_in_catalog, false);
  assert.equal(result.roles[0].availability_current, false);
  assert.equal(result.roles[0].inference_validation.status, 'unverified');
});

test('returns useful errors when runtime queries fail or are malformed', async () => {
  const failed = await install({
    agent: { list: async () => { throw new Error('offline'); } },
    model: { list: async () => ({ data: [] }) },
  });
  await assert.rejects(failed.execute(), /ctx\.agent\.list failed: offline/);
  const malformed = await install({
    agent: { list: async () => ({}) },
    model: { list: async () => ({ data: [] }) },
  });
  await assert.rejects(malformed.execute(), /ctx\.agent\.list returned no data array/);
});
