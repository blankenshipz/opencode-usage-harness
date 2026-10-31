import { readFileSync } from 'node:fs';
import path from 'node:path';
import { managedConfigRoot } from './paths.mjs';

// This is deliberately an exact acknowledgement instead of a permissive flag:
// an absent, partial, or misspelled local file keeps the public default.
export const APP_MANAGED_CREDITS_ACKNOWLEDGEMENT = 'I authorize Anthropic app-managed usage credits';

const subscriptionOnly = Object.freeze({ mode: 'subscription_only' });

export function validateAnthropicFinancialPolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 3 || value.version !== 1
    || value.mode !== 'app_managed_credits'
    || value.acknowledgement !== APP_MANAGED_CREDITS_ACKNOWLEDGEMENT)
    throw new Error('Subscription guard: Anthropic financial policy is invalid; app-managed credits are not authorized.');
  return Object.freeze({ mode: 'app_managed_credits' });
}

export function readAnthropicFinancialPolicy({ readFile = readFileSync,
  policyPath = path.join(managedConfigRoot, 'anthropic-financial-policy.json') } = {}) {
  try { return validateAnthropicFinancialPolicy(JSON.parse(readFile(policyPath, 'utf8'))); }
  catch (error) {
    if (error?.code === 'ENOENT') return subscriptionOnly;
    throw error;
  }
}
