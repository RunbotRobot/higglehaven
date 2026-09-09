import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, signupBuilder, signupSeller } from './test-helpers.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

// Every KYC field a valid POST needs — individually overridden per test to
// exercise one missing/invalid field at a time.
function validPayload(overrides = {}) {
  return {
    individual: {
      firstName: 'Ada',
      lastName: 'Seller',
      dobDay: 12,
      dobMonth: 6,
      dobYear: 1990,
      ssnLast4: '1234',
      addressLine1: '123 Main St',
      addressCity: 'Seattle',
      addressState: 'WA',
      addressPostalCode: '98101',
      addressCountry: 'US',
      ...overrides.individual,
    },
    externalAccount: {
      routingNumber: '110000000',
      accountNumber: '000123456789',
      currency: 'usd',
      ...overrides.externalAccount,
    },
  };
}

describe('Seller Stripe Connect account', () => {
  it('requires a session for both GET and POST', async () => {
    const got = await api('/sellers/me/stripe-account');
    expect(got.response.status).toBe(401);

    const posted = await api('/sellers/me/stripe-account', { method: 'POST', body: JSON.stringify(validPayload()) });
    expect(posted.response.status).toBe(401);
  });

  it('reports not_started with no Stripe account yet', async () => {
    const seller = await signupSeller('stripe-status');
    const { response, body } = await api('/sellers/me/stripe-account', seller.session());
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      configured: false,
      connected: false,
      status: 'not_started',
      requirementsCurrentlyDue: [],
    });
  });

  // The test environment never configures STRIPE_SECRET_KEY (same
  // dev-mode-friendly pattern as RESEND_API_KEY elsewhere in this file) —
  // this proves a fully valid submission still gets real 400 validation
  // before ever reaching that check, and only fails at the "not
  // configured" step once the payload itself is sound.
  it('validates required KYC fields before ever touching Stripe', async () => {
    const seller = await signupSeller('stripe-validate');

    const missingField = await api('/sellers/me/stripe-account', seller.session({
      method: 'POST',
      body: JSON.stringify(validPayload({ individual: { firstName: undefined } })),
    }));
    expect(missingField.response.status).toBe(400);

    const badSsn = await api('/sellers/me/stripe-account', seller.session({
      method: 'POST',
      body: JSON.stringify(validPayload({ individual: { ssnLast4: '12' } })),
    }));
    expect(badSsn.response.status).toBe(400);

    const badDob = await api('/sellers/me/stripe-account', seller.session({
      method: 'POST',
      body: JSON.stringify(validPayload({ individual: { dobMonth: 13 } })),
    }));
    expect(badDob.response.status).toBe(400);
  });

  it('returns 503 once the payload is valid but Stripe is not configured', async () => {
    const seller = await signupSeller('stripe-unconfigured');
    const { response, body } = await api('/sellers/me/stripe-account', seller.session({
      method: 'POST',
      body: JSON.stringify(validPayload()),
    }));
    expect(response.status).toBe(503);
    expect(body.error).toMatch(/not configured/i);

    // No account should have been recorded for an attempt that never
    // reached Stripe.
    const status = await api('/sellers/me/stripe-account', seller.session());
    expect(status.body.connected).toBe(false);
  });

  it("never persists KYC fields onto the seller's own row", async () => {
    const seller = await signupSeller('stripe-no-pii');
    await api('/sellers/me/stripe-account', seller.session({
      method: 'POST',
      body: JSON.stringify(validPayload()),
    }));
    const { body } = await api('/sellers/me', seller.session());
    const serialized = JSON.stringify(body.seller);
    expect(serialized).not.toContain('1234'); // ssnLast4
    expect(serialized).not.toContain('110000000'); // routing number
  });
});

// #624 (sub-issue of #349/#324): the same Custom-account onboarding flow
// as above, mirrored for builders — the prerequisite for #625's
// higgles-to-cash redemption. Same coverage shape, reusing this file's own
// validPayload() helper since the KYC field validation itself is identical
// (buildStripeIndividualParams doesn't distinguish builder from seller).
describe('Builder Stripe Connect account (#624)', () => {
  it('requires a session for both GET and POST', async () => {
    const got = await api('/builders/me/stripe-account');
    expect(got.response.status).toBe(401);

    const posted = await api('/builders/me/stripe-account', { method: 'POST', body: JSON.stringify(validPayload()) });
    expect(posted.response.status).toBe(401);
  });

  it('reports not_started with no Stripe account yet', async () => {
    const builder = await signupBuilder('builder-stripe-status');
    const { response, body } = await api('/builders/me/stripe-account', builder.session());
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      configured: false,
      connected: false,
      status: 'not_started',
      requirementsCurrentlyDue: [],
    });
  });

  it('validates required KYC fields before ever touching Stripe', async () => {
    const builder = await signupBuilder('builder-stripe-validate');

    const missingField = await api('/builders/me/stripe-account', builder.session({
      method: 'POST',
      body: JSON.stringify(validPayload({ individual: { firstName: undefined } })),
    }));
    expect(missingField.response.status).toBe(400);

    const badSsn = await api('/builders/me/stripe-account', builder.session({
      method: 'POST',
      body: JSON.stringify(validPayload({ individual: { ssnLast4: '12' } })),
    }));
    expect(badSsn.response.status).toBe(400);
  });

  it('returns 503 once the payload is valid but Stripe is not configured', async () => {
    const builder = await signupBuilder('builder-stripe-unconfigured');
    const { response, body } = await api('/builders/me/stripe-account', builder.session({
      method: 'POST',
      body: JSON.stringify(validPayload()),
    }));
    expect(response.status).toBe(503);
    expect(body.error).toMatch(/not configured/i);

    const status = await api('/builders/me/stripe-account', builder.session());
    expect(status.body.connected).toBe(false);
  });

  it("never persists KYC fields onto the builder's own row", async () => {
    const builder = await signupBuilder('builder-stripe-no-pii');
    await api('/builders/me/stripe-account', builder.session({
      method: 'POST',
      body: JSON.stringify(validPayload()),
    }));
    const { body } = await api('/builders/me', builder.session());
    const serialized = JSON.stringify(body.builder);
    expect(serialized).not.toContain('1234'); // ssnLast4
    expect(serialized).not.toContain('110000000'); // routing number
  });

  it("keeps a builder's and a seller's Stripe onboarding independent", async () => {
    // Same account, both roles — every user is auto-provisioned a builder
    // profile (see getOrCreateBuilderForUser's own comment), and this
    // seller-signup path lazily creates the seller one too. Submitting
    // only the builder's own onboarding shouldn't touch the seller row at
    // all, since they're genuinely separate Stripe Connect accounts.
    const seller = await signupSeller('dual-role-stripe');
    await api('/builders/me/stripe-account', seller.session({
      method: 'POST',
      body: JSON.stringify(validPayload()),
    }));
    const sellerStatus = await api('/sellers/me/stripe-account', seller.session());
    expect(sellerStatus.body.connected).toBe(false);
  });
});
