import crypto from 'node:crypto';

const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = value => typeof value === 'string' ? value : value?.message;

// Only classify native admission failures and the observed native failed-run policy
// code. Do not inspect child output: a worker saying that it is blocked is not a
// native decision about dispatch.
export function admissionDenial(value) {
  const messages = [
    value instanceof Error ? value.message : undefined,
    text(value?.error), text(value?.metadata?.error), text(value?.output?.error),
  ].filter(Boolean);
  const category = value?.admission?.category ?? value?.metadata?.admission?.category ?? value?.output?.admission?.category;
  const codes = [value?.error?.code, value?.metadata?.error?.code, value?.output?.error?.code, value?.code];
  if (category === 'native_permission' || messages.some(message => /^Subagent denied:/i.test(message))) return 'native_permission';
  if (category === 'provider_refusal' || codes.includes('misalignment_policy_violation') || messages.some(message => /^Subagent failed \(sessionID: [^)]+\):[\s\S]*\bmisalignment_policy_violation\b/i.test(message))) return 'provider_refusal';
}

export function admissionInputs(input) {
  // Prompt and model are intentionally excluded. Changing either is not recovery
  // evidence and must not turn a denied admission into repeated retries.
  return digest({ agent: input.agent, operation: input.operation, requiredCapabilities: [...input.requiredCapabilities].sort(), writePaths: [...(input.writePaths ?? [])].sort(), background: input.background === true });
}

export function recoveryEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const { kind, scope, inputs, authorization, explanation, reference } = value;
  const nonblank = (item, max) => typeof item === 'string' && item.trim().length > 0 && item.length <= max;
  if (!['scope_changed','inputs_changed','authorization_changed'].includes(kind) || !nonblank(scope,160) ||
      !Array.isArray(inputs) || !inputs.length || inputs.length > 12 || inputs.some(item => !nonblank(item,160)) ||
      !nonblank(authorization,240) || !nonblank(explanation,240) || !nonblank(reference,240)) return;
  // Explanation is intentionally excluded: a paraphrase cannot become a new recovery.
  // Nothing from the declaration is persisted; it may itself contain sensitive details.
  return { hash: digest({ kind, scope, inputs: [...inputs].sort(), authorization, reference }) };
}

export function suppression(record, input) {
  const denial = record?.denial;
  if (!denial) return;
  const evidence = recoveryEvidence(input.recovery);
  if (!evidence || evidence.hash === denial.recoveryHash) return denial;
}

export function receipt(category, input) {
  const evidence = recoveryEvidence(input.recovery);
  return { category, inputsHash: admissionInputs(input), ...(evidence ? { recoveryHash: evidence.hash } : {}), recordedAt: Date.now() };
}

export const denialAdvice = category => category === 'native_permission'
  ? 'Native permission denied this admission. Do not retry unchanged work. Declare concrete changed scope, inputs, or authorization evidence; native admission will decide again.'
  : 'The provider refused this run. Do not retry unchanged work. Declare concrete changed scope, inputs, or authorization evidence; native admission will decide again.';
