import test from 'node:test';
import assert from 'node:assert/strict';
import { APP_MANAGED_CREDITS_ACKNOWLEDGEMENT, readAnthropicFinancialPolicy, validateAnthropicFinancialPolicy } from '../plugins/v2/anthropic-financial-policy.mjs';

test('Anthropic app-managed credits are absent by default and require an exact local acknowledgement', () => {
  assert.deepEqual(readAnthropicFinancialPolicy({ readFile: () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; } }), { mode: 'subscription_only' });
  const enabled = { version: 1, mode: 'app_managed_credits', acknowledgement: APP_MANAGED_CREDITS_ACKNOWLEDGEMENT };
  assert.deepEqual(validateAnthropicFinancialPolicy(enabled), { mode: 'app_managed_credits' });
  assert.throws(() => validateAnthropicFinancialPolicy({ ...enabled, acknowledgement: true }), /financial policy is invalid/);
  assert.throws(() => validateAnthropicFinancialPolicy({ ...enabled, extra: true }), /financial policy is invalid/);
});
