import { readFileSync } from 'node:fs';
import { statePath } from './paths.mjs';

const inferencePath = statePath('audit', 'inference-validation.json');

function readInferenceReceipts() {
  try {
    const value = JSON.parse(readFileSync(inferencePath, 'utf8'));
    return Array.isArray(value?.checks) ? value.checks : [];
  } catch {
    return [];
  }
}

function modelKey(model) {
  if (!model || typeof model !== 'object') return null;
  const provider = model.providerID ?? model.provider;
  const id = model.id ?? model.modelID;
  return typeof provider === 'string' && typeof id === 'string' ? `${provider}/${id}` : null;
}

function variantIDs(model) {
  return Array.isArray(model?.variants)
    ? model.variants.map(value => typeof value === 'string' ? value : value?.id).filter(Boolean)
    : [];
}

function roleStatus(agent, models, receipts) {
  const ref = agent?.model;
  const model = models.find(candidate => modelKey(candidate) === modelKey(ref));
  const key = modelKey(ref);
  const effort = ref?.variant ?? null;
  const receipt = receipts.filter(check =>
    check?.model === key && check?.effort === effort && check?.status === 'passed').at(-1);
  return {
    role: agent.id ?? agent.name,
    model: key,
    effort,
    mode: agent.mode ?? null,
    advertised_in_catalog: Boolean(model),
    effort_advertised_in_catalog: Boolean(model && effort && variantIDs(model).includes(effort)),
    availability_current: Boolean(model && (!effort || variantIDs(model).includes(effort))),
    inference_validation: receipt
      ? { status: 'historically_passed', checked_at: receipt.checked_at, session_id: receipt.session_id, evidence: receipt.evidence }
      : { status: 'unverified' },
  };
}

export async function collectStatus(ctx) {
  let agents, models;
  try {
    agents = (await ctx.agent.list()).data;
  } catch (error) {
    throw new Error(`model_status: ctx.agent.list failed: ${error?.message ?? error}`);
  }
  try {
    models = (await ctx.model.list()).data;
  } catch (error) {
    throw new Error(`model_status: ctx.model.list failed: ${error?.message ?? error}`);
  }
  if (!Array.isArray(agents)) throw new Error('model_status: ctx.agent.list returned no data array');
  if (!Array.isArray(models)) throw new Error('model_status: ctx.model.list returned no data array');
  const configured = agents.filter(agent => agent && agent.model);
  return {
    checked_at: null,
    snapshot_fresh: null,
    config_readable: true,
    source: 'effective V2 runtime catalog',
    roles: configured.map(agent => roleStatus(agent, models, readInferenceReceipts())),
    limitations: 'Runtime catalog advertisement is not backend entitlement. Inference remains unverified unless an exact matching audit receipt exists. No model calls or fallback occur.',
  };
}

export default {
  id: 'subscription.model-status',
  async setup(ctx) {
    await ctx.tool.transform(editor => editor.add({
      name: 'model_status',
      description: 'Read effective V2 agents, runtime model catalog, and exact inference receipts. No inference or spending.',
      input: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => ({ content: JSON.stringify(await collectStatus(ctx)) }),
    }));
  },
};
