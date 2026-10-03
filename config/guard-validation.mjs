export function validateFinancial(verification) {
  if (verification.auto_top_up_off !== true || verification.automatic_reload_off !== true ||
      verification.purchased_credit_balance_ui !== 0 || !verification.verified_at)
    throw new Error('Subscription guard: verify zero purchased credits and disabled automatic top-up/reload before inference.');
}
