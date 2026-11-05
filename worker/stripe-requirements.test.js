// #2928 (part 1): the classifier that decides which outstanding Stripe
// requirements go to Stripe's own onboarding step. Pure unit tests, plus the
// status endpoint's use of it.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { classifyStripeRequirements, isRequirementCollectedByUs } from './lib/stripe-requirements.js';
import { api, signupSeller } from './test-helpers.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe('classifyStripeRequirements (#2928)', () => {
  it('sends identity-document and full-ID items to Stripe, never to our forms', () => {
    const result = classifyStripeRequirements([
      'individual.id_number',
      'individual.verification.document',
      'individual.verification.additional_document',
    ]);
    expect(result.needsStripeStep).toEqual([
      'individual.id_number',
      'individual.verification.document',
      'individual.verification.additional_document',
    ]);
    expect(result.ours).toEqual([]);
  });

  it('treats everything our own forms already send as ours', () => {
    const ours = [
      'individual.first_name', 'individual.last_name', 'individual.dob.day', 'individual.dob.month',
      'individual.dob.year', 'individual.address.line1', 'individual.address.postal_code',
      'individual.ssn_last_4', 'individual.phone', 'individual.email', 'business_type',
      'business_profile.mcc', 'business_profile.url', 'settings.payments.statement_descriptor',
      'external_account', 'tos_acceptance.date', 'tos_acceptance.ip', 'capabilities',
    ];
    const result = classifyStripeRequirements(ours);
    expect(result.ours).toEqual(ours);
    expect(result.needsStripeStep).toEqual([]);
  });

  it('splits a mixed list and keeps input order', () => {
    const result = classifyStripeRequirements(['individual.phone', 'individual.id_number', 'company.tax_id', 'external_account']);
    expect(result.ours).toEqual(['individual.phone', 'external_account']);
    expect(result.needsStripeStep).toEqual(['individual.id_number', 'company.tax_id']);
  });

  it('does not match a prefix as a substring, and ignores non-string input', () => {
    expect(isRequirementCollectedByUs('individual.phone_number_extra')).toBe(false);
    expect(isRequirementCollectedByUs('individual.dob')).toBe(false);
    expect(classifyStripeRequirements(null)).toEqual({ ours: [], needsStripeStep: [] });
    expect(classifyStripeRequirements([null, 7, '', 'individual.id_number'])).toEqual({
      ours: [], needsStripeStep: ['individual.id_number'],
    });
  });
});

describe('GET /sellers/me/stripe-account stripeStepRequirements (#2928)', () => {
  it('is empty with no Stripe account, and lists only what Stripe must collect', async () => {
    const seller = await signupSeller('stripe-step-requirements');
    const empty = await api('/sellers/me/stripe-account', seller.session());
    expect(empty.body.stripeStepRequirements).toEqual([]);

    await env.DB.prepare(
      "UPDATE sellers SET stripe_account_id = 'acct_step_req', stripe_onboarding_status = 'requirements_due', stripe_requirements_due = ? WHERE seller_id = ?",
    ).bind(JSON.stringify(['individual.phone', 'individual.id_number']), seller.sellerId).run();
    const status = await api('/sellers/me/stripe-account', seller.session());
    expect(status.body.requirementsCurrentlyDue).toEqual(['individual.phone', 'individual.id_number']);
    expect(status.body.stripeStepRequirements).toEqual(['individual.id_number']);
  });
});
