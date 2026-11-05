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

// #2928 (part 2): hand-off to Stripe's own onboarding step, and resuming
// after it. Stripe is mocked at fetch (same idiom as stripe-connect.test.js).
describe('Stripe onboarding hand-off and resume (#2928)', () => {
  async function withStripe(handler, run) {
    const originalFetch = globalThis.fetch;
    env.STRIPE_SECRET_KEY = 'test-stripe-key';
    const calls = [];
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (!url.startsWith('https://api.stripe.com/')) return originalFetch(input, init);
      const call = { url, method: init?.method, headers: init?.headers, body: init?.body ? JSON.parse(init.body) : null };
      calls.push(call);
      const result = handler(call);
      return new Response(JSON.stringify(result.body), { status: result.status || 200, headers: { 'content-type': 'application/json' } });
    };
    try {
      return await run(calls);
    } finally {
      globalThis.fetch = originalFetch;
      env.STRIPE_SECRET_KEY = undefined;
    }
  }

  const accountWith = (currentlyDue) => ({
    id: 'acct_handoff', charges_enabled: false, payouts_enabled: false,
    requirements: { currently_due: currentlyDue },
  });

  it('creates a hosted v2 account link only when Stripe needs a step, never sending configurations', async () => {
    const seller = await signupSeller('stripe-handoff-seller');
    await env.DB.prepare("UPDATE sellers SET stripe_account_id = 'acct_handoff', stripe_onboarding_status = 'requirements_due', stripe_requirements_due = '[]' WHERE seller_id = ?")
      .bind(seller.sellerId).run();

    await withStripe((call) => {
      if (call.url.endsWith('/v1/accounts/acct_handoff')) return { body: accountWith(['individual.id_number']) };
      if (call.url.endsWith('/v2/core/account_links')) return { body: { url: 'https://connect.stripe.com/setup/e/abc', expires_at: '2026-11-05T17:00:00Z' } };
      return { status: 404, body: {} };
    }, async (calls) => {
      const res = await api('/sellers/me/stripe-onboarding-link', seller.session({ method: 'POST' }));
      expect(res.response.status).toBe(200);
      expect(res.body.url).toBe('https://connect.stripe.com/setup/e/abc');
      const link = calls.find((c) => c.url.endsWith('/v2/core/account_links'));
      expect(link.body.account).toBe('acct_handoff');
      expect(link.body.use_case.type).toBe('account_onboarding');
      const onboarding = link.body.use_case.account_onboarding;
      expect(onboarding).not.toHaveProperty('configurations');
      expect(onboarding.return_url).toContain('stripe=return');
      expect(onboarding.refresh_url).toContain('stripe=refresh');
      expect(onboarding.collection_options).toEqual({ fields: 'currently_due' });
    });
    // The refreshed requirements were stored, so the status now shows the step.
    const status = await api('/sellers/me/stripe-account', seller.session());
    expect(status.body.stripeStepRequirements).toEqual(['individual.id_number']);
  });

  it('refuses to hand off when Stripe needs nothing we cannot collect, or there is no account yet', async () => {
    const seller = await signupSeller('stripe-handoff-none');
    const noAccount = await withStripe(() => ({ body: {} }), () =>
      api('/sellers/me/stripe-onboarding-link', seller.session({ method: 'POST' })));
    expect(noAccount.response.status).toBe(409);

    await env.DB.prepare("UPDATE sellers SET stripe_account_id = 'acct_handoff' WHERE seller_id = ?").bind(seller.sellerId).run();
    const nothing = await withStripe((call) => (
      call.url.includes('/v1/accounts/') ? { body: accountWith(['individual.phone']) } : { status: 500, body: {} }
    ), async (calls) => {
      const res = await api('/sellers/me/stripe-onboarding-link', seller.session({ method: 'POST' }));
      expect(calls.some((c) => c.url.endsWith('/v2/core/account_links'))).toBe(false);
      return res;
    });
    expect(nothing.response.status).toBe(409);
  });

  it('requires a session, and 503s when Stripe is not configured', async () => {
    expect((await api('/sellers/me/stripe-onboarding-link', { method: 'POST' })).response.status).toBe(401);
    const seller = await signupSeller('stripe-handoff-unconfigured');
    const res = await api('/sellers/me/stripe-onboarding-link', seller.session({ method: 'POST' }));
    expect(res.response.status).toBe(503);
  });

  it('serves the same hand-off for a builder', async () => {
    const { signupBuilder } = await import('./test-helpers.js');
    const builder = await signupBuilder('stripe-handoff-builder');
    await env.DB.prepare("UPDATE builders SET stripe_account_id = 'acct_handoff' WHERE builder_id = ?").bind(builder.builderId).run();
    await withStripe((call) => (
      call.url.includes('/v1/accounts/') ? { body: accountWith(['individual.verification.document']) } : { body: { url: 'https://connect.stripe.com/setup/e/b' } }
    ), async (calls) => {
      const res = await api('/builders/me/stripe-onboarding-link', builder.session({ method: 'POST' }));
      expect(res.response.status).toBe(200);
      expect(res.body.url).toBe('https://connect.stripe.com/setup/e/b');
      expect(calls.find((c) => c.url.endsWith('/v2/core/account_links')).body.use_case.account_onboarding.return_url).toContain('role=builder');
    });
  });

  it('re-reads Stripe on GET ?refresh=1 (resume), and falls back to the stored status if Stripe is down', async () => {
    const seller = await signupSeller('stripe-resume');
    await env.DB.prepare("UPDATE sellers SET stripe_account_id = 'acct_handoff', stripe_onboarding_status = 'requirements_due', stripe_requirements_due = ? WHERE seller_id = ?")
      .bind(JSON.stringify(['individual.id_number']), seller.sellerId).run();

    // Without refresh=1 Stripe is never called.
    await withStripe(() => ({ status: 500, body: {} }), async (calls) => {
      const plain = await api('/sellers/me/stripe-account', seller.session());
      expect(plain.body.stripeStepRequirements).toEqual(['individual.id_number']);
      expect(calls).toHaveLength(0);
    });

    // Back from Stripe's step: requirements cleared, account complete.
    await withStripe(() => ({ body: { id: 'acct_handoff', charges_enabled: true, payouts_enabled: true, requirements: { currently_due: [] } } }), async () => {
      const resumed = await api('/sellers/me/stripe-account?refresh=1', seller.session());
      expect(resumed.body.status).toBe('complete');
      expect(resumed.body.stripeStepRequirements).toEqual([]);
    });

    // Stripe unreachable: the stored (now complete) status still renders.
    await withStripe(() => ({ status: 500, body: {} }), async () => {
      const down = await api('/sellers/me/stripe-account?refresh=1', seller.session());
      expect(down.response.status).toBe(200);
      expect(down.body.status).toBe('complete');
    });
  });
});
