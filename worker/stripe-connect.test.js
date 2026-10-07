import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { claimOrResumeBuilderRedemption } from './index.js';
import { api, signupAdmin, signupBuilder, signupSeller, createGreenbeltLandletAs } from './test-helpers.js';

let adminSession;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const admin = await signupAdmin('stripe-connect-admin');
  adminSession = admin.session;
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

  // #948: this endpoint makes a real outbound Stripe API call on every
  // valid submission, unlike every other authenticated mutation in this
  // file, which is always rate-limited. checkRateLimit is placed ahead of
  // the stripeConfigured check (same as #839's own precedent), which is
  // what makes the limiter itself exercisable here — every one of these 20
  // calls still 503s (Stripe never configured in this suite), the point is
  // that the limiter, not Stripe config, is what eventually returns 429.
  it('rate-limits repeated Stripe-account submissions from the same seller', async () => {
    const seller = await signupSeller('stripe-rate-limit-seller');
    for (let i = 0; i < 20; i++) {
      const attempt = await api('/sellers/me/stripe-account', seller.session({
        method: 'POST', body: JSON.stringify(validPayload()),
      }));
      expect(attempt.response.status).toBe(503);
    }
    const limited = await api('/sellers/me/stripe-account', seller.session({
      method: 'POST', body: JSON.stringify(validPayload()),
    }));
    expect(limited.response.status).toBe(429);
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

  // #948: same gap and fix as the seller-account rate-limit test above.
  it('rate-limits repeated Stripe-account submissions from the same builder', async () => {
    const builder = await signupBuilder('stripe-rate-limit-builder');
    for (let i = 0; i < 20; i++) {
      const attempt = await api('/builders/me/stripe-account', builder.session({
        method: 'POST', body: JSON.stringify(validPayload()),
      }));
      expect(attempt.response.status).toBe(503);
    }
    const limited = await api('/builders/me/stripe-account', builder.session({
      method: 'POST', body: JSON.stringify(validPayload()),
    }));
    expect(limited.response.status).toBe(429);
  });
});

// #1065 (sub-issue of #1404): once Stripe permanently disables/closes a
// connected account, the POST .../stripe-account handlers above only ever
// update the existing stripe_account_id, never clear it -- these are the
// admin-gated endpoints that make a fresh onboarding attempt possible
// again. Deliberately mechanical only: no judgment call here about
// whether reconnection *should* be allowed (that's #1407's future job).
describe('Stripe account reset (#1065)', () => {
  it("requires admin for both the seller and builder reset, 404s on an unknown id, and 409s with nothing connected", async () => {
    const seller = await signupSeller('stripe-reset-seller-guards');
    const builder = await signupBuilder('stripe-reset-builder-guards');

    const unauthSeller = await api(`/sellers/${seller.sellerId}/stripe-account-reset`, { method: 'POST' });
    expect(unauthSeller.response.status).toBe(401);
    const unauthBuilder = await api(`/builders/${builder.builderId}/stripe-account-reset`, { method: 'POST' });
    expect(unauthBuilder.response.status).toBe(401);

    const nonAdminSeller = await api(`/sellers/${seller.sellerId}/stripe-account-reset`, seller.session({ method: 'POST' }));
    expect(nonAdminSeller.response.status).toBe(403);
    const nonAdminBuilder = await api(`/builders/${builder.builderId}/stripe-account-reset`, builder.session({ method: 'POST' }));
    expect(nonAdminBuilder.response.status).toBe(403);

    const missingSeller = await api('/sellers/does-not-exist/stripe-account-reset', adminSession({ method: 'POST' }));
    expect(missingSeller.response.status).toBe(404);
    const missingBuilder = await api('/builders/does-not-exist/stripe-account-reset', adminSession({ method: 'POST' }));
    expect(missingBuilder.response.status).toBe(404);

    // Neither has a connected account yet (not_started, per the earlier
    // "reports not_started" tests above).
    const nothingToResetSeller = await api(`/sellers/${seller.sellerId}/stripe-account-reset`, adminSession({ method: 'POST' }));
    expect(nothingToResetSeller.response.status).toBe(409);
    const nothingToResetBuilder = await api(`/builders/${builder.builderId}/stripe-account-reset`, adminSession({ method: 'POST' }));
    expect(nothingToResetBuilder.response.status).toBe(409);
  });

  it('clears a dead stripe_account_id, logs the admin action, and lets a fresh account be created afterward', async () => {
    const seller = await signupSeller('stripe-reset-seller');
    await env.DB.prepare(`
      UPDATE sellers SET stripe_account_id = 'acct_dead_seller', stripe_onboarding_status = 'action_needed', stripe_requirements_due = '["individual.verification.document"]' WHERE seller_id = ?
    `).bind(seller.sellerId).run();

    const reset = await api(`/sellers/${seller.sellerId}/stripe-account-reset`, adminSession({ method: 'POST' }));
    expect(reset.response.status).toBe(200);
    expect(reset.body).toMatchObject({ connected: false, status: 'not_started', requirementsCurrentlyDue: [] });

    const row = await env.DB.prepare('SELECT stripe_account_id, stripe_onboarding_status, stripe_requirements_due FROM sellers WHERE seller_id = ?')
      .bind(seller.sellerId).first();
    expect(row.stripe_account_id).toBeNull();
    expect(row.stripe_onboarding_status).toBe('not_started');
    expect(row.stripe_requirements_due).toBeNull();

    // Same GET surface a seller sees themselves now reflects the reset.
    const status = await api('/sellers/me/stripe-account', seller.session());
    expect(status.body.connected).toBe(false);

    // A fresh onboarding submission is possible again rather than trying
    // (and failing) to update the dead account id -- same 503-before-ever-
    // reaching-Stripe shape every other unconfigured POST in this suite
    // hits, which is itself proof it took the "create" branch, not
    // "update acct_dead_seller".
    const resubmit = await api('/sellers/me/stripe-account', seller.session({
      method: 'POST', body: JSON.stringify(validPayload()),
    }));
    expect(resubmit.response.status).toBe(503);

    const me = await api('/auth/me', adminSession());
    const logRow = await env.DB.prepare(
      'SELECT * FROM admin_action_log WHERE action_type = ? AND target_id = ?',
    ).bind('stripe_account_reset', seller.sellerId).first();
    expect(logRow.admin_user_id).toBe(me.body.user.userId);
    expect(logRow.target_type).toBe('seller');
    expect(JSON.parse(logRow.detail_json)).toEqual({ previousAccountId: 'acct_dead_seller' });
  });

  it("resets a builder's dead account independently of the seller reset above", async () => {
    const builder = await signupBuilder('stripe-reset-builder');
    await env.DB.prepare(`
      UPDATE builders SET stripe_account_id = 'acct_dead_builder', stripe_onboarding_status = 'action_needed' WHERE builder_id = ?
    `).bind(builder.builderId).run();

    const reset = await api(`/builders/${builder.builderId}/stripe-account-reset`, adminSession({ method: 'POST' }));
    expect(reset.response.status).toBe(200);
    expect(reset.body).toMatchObject({ connected: false, status: 'not_started' });

    const row = await env.DB.prepare('SELECT stripe_account_id FROM builders WHERE builder_id = ?')
      .bind(builder.builderId).first();
    expect(row.stripe_account_id).toBeNull();

    const logRow = await env.DB.prepare(
      'SELECT * FROM admin_action_log WHERE action_type = ? AND target_id = ?',
    ).bind('stripe_account_reset', builder.builderId).first();
    expect(logRow.target_type).toBe('builder');
    expect(JSON.parse(logRow.detail_json)).toEqual({ previousAccountId: 'acct_dead_builder' });
  });

  // #1414: the UPDATE's own WHERE used to only constrain on builder_id/
  // seller_id, not the stripe_account_id this handler's own precondition
  // check just read -- so a reset request built from a stale read could
  // land after the builder/seller already reconnected a brand-new account
  // and silently null that one out instead. Same db.prepare monkey-patch
  // idiom worker/commerce.test.js's own mark-shipped/confirm-delivery
  // refund-race tests use to inject a concurrent write mid-request.
  it('rejects resetting a builder whose dead account was already replaced by a real reconnect in the window between the check and the write', async () => {
    const builder = await signupBuilder('stripe-reset-builder-race');
    await env.DB.prepare(`
      UPDATE builders SET stripe_account_id = 'acct_dead_builder_race', stripe_onboarding_status = 'action_needed' WHERE builder_id = ?
    `).bind(builder.builderId).run();

    const originalPrepare = env.DB.prepare.bind(env.DB);
    let armed = true;
    env.DB.prepare = (sql) => {
      if (armed && sql.includes('UPDATE builders') && sql.includes('stripe_account_id = NULL')) {
        armed = false;
        originalPrepare(`
          UPDATE builders SET stripe_account_id = 'acct_new_builder_race', stripe_onboarding_status = 'complete' WHERE builder_id = ?
        `).bind(builder.builderId).run();
      }
      return originalPrepare(sql);
    };
    let rejected;
    try {
      rejected = await api(`/builders/${builder.builderId}/stripe-account-reset`, adminSession({ method: 'POST' }));
    } finally {
      env.DB.prepare = originalPrepare;
    }
    expect(rejected.response.status).toBe(409);
    expect(rejected.body.error).toMatch(/changed concurrently/);

    const row = await env.DB.prepare('SELECT stripe_account_id, stripe_onboarding_status FROM builders WHERE builder_id = ?')
      .bind(builder.builderId).first();
    expect(row.stripe_account_id).toBe('acct_new_builder_race');
    expect(row.stripe_onboarding_status).toBe('complete');

    const logRow = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM admin_action_log WHERE action_type = ? AND target_id = ?',
    ).bind('stripe_account_reset', builder.builderId).first();
    expect(logRow.count).toBe(0);
  });

  it('rejects resetting a seller whose dead account was already replaced by a real reconnect in the window between the check and the write', async () => {
    const seller = await signupSeller('stripe-reset-seller-race');
    await env.DB.prepare(`
      UPDATE sellers SET stripe_account_id = 'acct_dead_seller_race', stripe_onboarding_status = 'action_needed' WHERE seller_id = ?
    `).bind(seller.sellerId).run();

    const originalPrepare = env.DB.prepare.bind(env.DB);
    let armed = true;
    env.DB.prepare = (sql) => {
      if (armed && sql.includes('UPDATE sellers') && sql.includes('stripe_account_id = NULL')) {
        armed = false;
        originalPrepare(`
          UPDATE sellers SET stripe_account_id = 'acct_new_seller_race', stripe_onboarding_status = 'complete' WHERE seller_id = ?
        `).bind(seller.sellerId).run();
      }
      return originalPrepare(sql);
    };
    let rejected;
    try {
      rejected = await api(`/sellers/${seller.sellerId}/stripe-account-reset`, adminSession({ method: 'POST' }));
    } finally {
      env.DB.prepare = originalPrepare;
    }
    expect(rejected.response.status).toBe(409);
    expect(rejected.body.error).toMatch(/changed concurrently/);

    const row = await env.DB.prepare('SELECT stripe_account_id, stripe_onboarding_status FROM sellers WHERE seller_id = ?')
      .bind(seller.sellerId).first();
    expect(row.stripe_account_id).toBe('acct_new_seller_race');
    expect(row.stripe_onboarding_status).toBe('complete');

    const logRow = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM admin_action_log WHERE action_type = ? AND target_id = ?',
    ).bind('stripe_account_reset', seller.sellerId).first();
    expect(logRow.count).toBe(0);
  });
});

// #625 (sub-issue of #349/#324): redeeming a builder's higgles balance for
// real cash. Stripe is never configured in this suite (see this file's own
// top-of-suite convention), so the actual transfer+payout round trip isn't
// exercised here — only everything this endpoint checks before ever
// reaching Stripe, same limitation as "Seller payouts"' own real-money
// tests in worker/commerce.test.js.
describe('Higgles redemption (#625)', () => {
  async function connectBuilder(builder) {
    await env.DB.prepare(`
      UPDATE builders SET stripe_account_id = 'acct_test_redeem', stripe_onboarding_status = 'complete' WHERE builder_id = ?
    `).bind(builder.builderId).run();
  }

  async function creditHiggles(builder, amountCents) {
    await env.DB.prepare('UPDATE builders SET higgles_balance_cents = ? WHERE builder_id = ?')
      .bind(amountCents, builder.builderId).run();
  }

  it('requires a session for both GET and POST', async () => {
    const got = await api('/builders/me/redeem');
    expect(got.response.status).toBe(401);

    const posted = await api('/builders/me/redeem', { method: 'POST', body: JSON.stringify({}) });
    expect(posted.response.status).toBe(401);
  });

  it("reports availableCents from the builder's own higgles balance", async () => {
    const builder = await signupBuilder('redeem-status');
    await creditHiggles(builder, 5000);
    const { response, body } = await api('/builders/me/redeem', builder.session());
    expect(response.status).toBe(200);
    expect(body.availableCents).toBe(5000);
    expect(body.connected).toBe(false); // no Stripe account yet
  });

  // #1029: handleAuctionBids already nets a bidder's currently-leading bid
  // on their other active auctions out of what a NEW bid may spend (#629's
  // "held until outbid or the auction closes"), but handleBuilderRedeem
  // used to report/allow redeeming the raw balance with no such netting —
  // so a builder with a leading bid could see (and would eventually have
  // been able to redeem) higgles their own bid still needs.
  it("nets out higgles held by the caller's own active auction bid from availableCents", async () => {
    const seller = await signupBuilder('redeem-held-bid-seller');
    const builder = await signupBuilder('redeem-held-bid-bidder');
    await creditHiggles(builder, 5000);
    // Generous land-cap headroom so only the higgles hold is under test —
    // same reasoning as commerce.test.js's own "Balance holding (#629)"
    // tests.
    await api(`/builders/${builder.builderId}/land-cap-grants`, adminSession({
      method: 'POST', body: JSON.stringify({ amountCents: 100_000_000 }),
    }));
    await createGreenbeltLandletAs(adminSession, 'redeem-held-bid-landlet');
    await api('/landlets/redeem-held-bid-landlet/claim', seller.session({ method: 'POST' }));
    const started = await api('/landlets/redeem-held-bid-landlet/auction', seller.session({
      method: 'POST', body: JSON.stringify({}),
    }));
    expect(started.response.status).toBe(201);

    const bid = await api(`/auctions/${started.body.auction.auctionId}/bids`, builder.session({
      method: 'POST', body: JSON.stringify({ amountCents: 2000 }),
    }));
    expect(bid.response.status).toBe(201);

    // 3000, not the raw 5000 balance — 2000 is held by the leading bid.
    const status = await api('/builders/me/redeem', builder.session());
    expect(status.body.availableCents).toBe(3000);

    const tooMuch = await api('/builders/me/redeem', builder.session({
      method: 'POST', body: JSON.stringify({ amountCents: 3001 }),
    }));
    expect(tooMuch.response.status).toBe(400);
    expect(tooMuch.body.error).toMatch(/\$30\.00/);
  });

  it('rejects redeeming with nothing available', async () => {
    const builder = await signupBuilder('redeem-empty');
    const got = await api('/builders/me/redeem', builder.session({ method: 'POST', body: JSON.stringify({}) }));
    expect(got.response.status).toBe(400);
  });

  it('rejects redeeming more than the available balance', async () => {
    const builder = await signupBuilder('redeem-too-much');
    await creditHiggles(builder, 1000);
    const got = await api('/builders/me/redeem', builder.session({
      method: 'POST', body: JSON.stringify({ amountCents: 5000 }),
    }));
    expect(got.response.status).toBe(400);

    // Rejected before ever touching the balance.
    const status = await api('/builders/me/redeem', builder.session());
    expect(status.body.availableCents).toBe(1000);
  });

  it('blocks redemption once combined earnings cross the reporting threshold with no tax paperwork on file', async () => {
    const builder = await signupBuilder('redeem-threshold');
    await connectBuilder(builder);
    // Over the $20,000 threshold via the same higgles_earnings_events
    // ledger annualGrossIncome reads — a real earnings event, not just a
    // balance bump, so it's actually counted as this year's gross income.
    await api(`/builders/${builder.builderId}/land-cap-grants`, adminSession({
      method: 'POST', body: JSON.stringify({ amountCents: 2_000_001 }),
    }));
    await creditHiggles(builder, 2_000_001);

    const got = await api('/builders/me/redeem', builder.session({
      method: 'POST', body: JSON.stringify({}),
    }));
    expect(got.response.status).toBe(403);
    expect(got.body.error).toMatch(/tax-reporting/i);

    // Blocked before ever touching the balance.
    const status = await api('/builders/me/redeem', builder.session());
    expect(status.body.availableCents).toBe(2_000_001);
  });

  // Owner (Control Room, 2026-09-10, on #651): higgles_balance_cents has no
  // provenance back to real money — the free/simulated purchase path
  // credits builder commission exactly like a real Stripe sale does, so
  // redeeming it is a zero-capital, zero-auth mint of real cash. Same
  // stopgap-first shape as the (since-lifted) #629 auction pause:
  // REDEMPTION_PAUSED_PENDING_PROVENANCE now occupies the same slot —
  // after every other validation, ahead of the stripeConfigured check —
  // which is the actual reason the test just below still sees 503 too.
  it('pauses redemption pending the provenance-tracking fix, ahead of the Stripe-configured check, leaving the balance untouched', async () => {
    const builder = await signupBuilder('redeem-paused-provenance');
    await connectBuilder(builder);
    await creditHiggles(builder, 5000);
    const got = await api('/builders/me/redeem', builder.session({
      method: 'POST', body: JSON.stringify({}),
    }));
    expect(got.response.status).toBe(503);
    expect(got.body.error).toMatch(/paused/i);

    const status = await api('/builders/me/redeem', builder.session());
    expect(status.body.availableCents).toBe(5000);
  });

  it('returns the same pause 503 even once Stripe would otherwise be configured (message differs from the plain unconfigured case)', async () => {
    const builder = await signupBuilder('redeem-unconfigured');
    await creditHiggles(builder, 5000);
    const got = await api('/builders/me/redeem', builder.session({
      method: 'POST', body: JSON.stringify({}),
    }));
    expect(got.response.status).toBe(503);

    const status = await api('/builders/me/redeem', builder.session());
    expect(status.body.availableCents).toBe(5000);
  });

  // #1050: same "real outbound Stripe API call on the shared key" gap
  // #839/#948 already fixed for the stripe-account handlers -- this
  // endpoint's own Stripe transfers/payouts calls (unreachable today while
  // REDEMPTION_PAUSED_PENDING_PROVENANCE holds, but not forever) need the
  // identical guard. Same coverage shape as those handlers' own tests.
  it('rate-limits repeated redemption attempts from the same builder', async () => {
    const builder = await signupBuilder('redeem-rate-limit');
    await creditHiggles(builder, 5000);
    for (let i = 0; i < 20; i++) {
      const attempt = await api('/builders/me/redeem', builder.session({
        method: 'POST', body: JSON.stringify({}),
      }));
      expect(attempt.response.status).toBe(503);
    }
    const limited = await api('/builders/me/redeem', builder.session({
      method: 'POST', body: JSON.stringify({}),
    }));
    expect(limited.response.status).toBe(429);
  });

  // #869: POST /builders/me/redeem itself always 503s in this suite
  // (REDEMPTION_PAUSED_PENDING_PROVENANCE, on top of Stripe never being
  // configured), so the actual fix -- resuming an in-flight redemption
  // instead of always minting a fresh one with a fresh (and therefore
  // useless) idempotency key -- is tested directly against the exported
  // claim/resume primitive, the same "no real Stripe call needed" shape
  // commerce.test.js's own claimPurchasesForPayout tests already use.
  it('claimOrResumeBuilderRedemption claims a fresh redemption and debits the balance when nothing is pending', async () => {
    const builder = await signupBuilder('redeem-claim-fresh');
    await creditHiggles(builder, 5000);

    const { redemption, resumed } = await claimOrResumeBuilderRedemption(env.DB, builder.builderId, 2000);
    expect(resumed).toBe(false);
    expect(redemption.builder_id).toBe(builder.builderId);
    expect(redemption.amount_cents).toBe(2000);
    expect(redemption.stripe_transfer_id).toBeNull();
    expect(redemption.stripe_payout_id).toBeNull();

    const row = await env.DB.prepare('SELECT higgles_balance_cents FROM builders WHERE builder_id = ?')
      .bind(builder.builderId).first();
    expect(row.higgles_balance_cents).toBe(3000);
  });

  it('claimOrResumeBuilderRedemption resumes an existing incomplete redemption instead of claiming a second one', async () => {
    const builder = await signupBuilder('redeem-resume');
    await creditHiggles(builder, 5000);

    // Manufactures the exact state a lost-response retry leaves behind:
    // the transfer leg already succeeded (stripe_transfer_id set), the
    // payout leg's outcome is unknown (stripe_payout_id still NULL), and
    // the balance was already debited for it (never refunded, since the
    // original attempt never definitively failed).
    await env.DB.prepare('UPDATE builders SET higgles_balance_cents = higgles_balance_cents - 2000 WHERE builder_id = ?')
      .bind(builder.builderId).run();
    await env.DB.prepare(`
      INSERT INTO higgles_redemptions (redemption_id, builder_id, amount_cents, stripe_transfer_id, stripe_payout_id)
      VALUES ('redemption-resume-test', ?, 2000, 'tr_already_succeeded', NULL)
    `).bind(builder.builderId).run();

    const { redemption, resumed } = await claimOrResumeBuilderRedemption(env.DB, builder.builderId, 2000);
    expect(resumed).toBe(true);
    expect(redemption.redemption_id).toBe('redemption-resume-test');
    expect(redemption.stripe_transfer_id).toBe('tr_already_succeeded');

    // Not debited a second time -- claimOrResumeBuilderRedemption must not
    // touch the balance at all when resuming.
    const row = await env.DB.prepare('SELECT higgles_balance_cents FROM builders WHERE builder_id = ?')
      .bind(builder.builderId).first();
    expect(row.higgles_balance_cents).toBe(3000);

    // No second row was created either.
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM higgles_redemptions WHERE builder_id = ?')
      .bind(builder.builderId).first();
    expect(count.n).toBe(1);
  });
});
