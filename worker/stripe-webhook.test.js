import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, signupAdmin, signupBuilder, signupSeller } from './test-helpers.js';

// Own file (own D1/worker isolate — see test-helpers.js's own comment on
// why the suite is split by file), same reasoning as
// worker/didit-verification.test.js: setting env.STRIPE_WEBHOOK_SECRET
// here can't leak into worker/reviews-auth.test.js, which relies on it
// staying unset to exercise the 503-unconfigured path for this same
// endpoint. STRIPE_SECRET_KEY is deliberately left unset even in this
// file — nothing here needs a real outbound call to Stripe, only the
// webhook's own signature verification and DB reconciliation.
let adminSession;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  env.STRIPE_WEBHOOK_SECRET = 'test-stripe-webhook-secret';
  const admin = await signupAdmin('stripe-webhook-admin');
  adminSession = admin.session;
});

afterAll(() => {
  env.STRIPE_WEBHOOK_SECRET = undefined;
});

async function signStripePayload(timestamp, rawBody) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const signatureBytes = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${rawBody}`)),
  );
  return [...signatureBytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function postStripeWebhook(eventObject, { signatureHeader, body, timestamp } = {}) {
  const rawBody = body !== undefined ? body : JSON.stringify(eventObject);
  const ts = timestamp !== undefined ? timestamp : Math.floor(Date.now() / 1000);
  const headers = { 'content-type': 'application/json' };
  headers['stripe-signature'] = signatureHeader !== undefined
    ? signatureHeader
    : `t=${ts},v1=${await signStripePayload(ts, rawBody)}`;
  return SELF.fetch('https://higglehaven.test/api/auth/stripe-webhook', {
    method: 'POST',
    headers,
    body: rawBody,
  });
}

function accountUpdatedEvent(accountId, accountOverrides = {}) {
  return {
    type: 'account.updated',
    data: {
      object: {
        id: accountId,
        charges_enabled: false,
        payouts_enabled: false,
        requirements: { currently_due: [] },
        ...accountOverrides,
      },
    },
  };
}

describe('Stripe account.updated webhook (#766)', () => {
  it('rejects a webhook with a missing or wrong signature', async () => {
    const seller = await signupSeller('stripe-webhook-badsig');
    await env.DB.prepare(
      "UPDATE sellers SET stripe_account_id = 'acct_badsig', stripe_onboarding_status = 'complete' WHERE seller_id = ?",
    ).bind(seller.sellerId).run();

    const noSig = await postStripeWebhook(accountUpdatedEvent('acct_badsig'), { signatureHeader: '' });
    expect(noSig.status).toBe(401);

    const wrongSig = await postStripeWebhook(accountUpdatedEvent('acct_badsig'), {
      signatureHeader: `t=${Math.floor(Date.now() / 1000)},v1=${'a'.repeat(64)}`,
    });
    expect(wrongSig.status).toBe(401);

    // Neither attempt should have touched the seller's still-'complete' row.
    const row = await env.DB.prepare('SELECT stripe_onboarding_status FROM sellers WHERE seller_id = ?')
      .bind(seller.sellerId).first();
    expect(row.stripe_onboarding_status).toBe('complete');
  });

  // #2418: during a secret rotation Stripe keeps the old secret active for
  // up to 24h and signs each event with BOTH secrets, sending every
  // resulting v1 signature in the same header -- this server must accept
  // the event as long as ANY v1 value matches its own current secret, not
  // just whichever one happens to appear last.
  it('accepts a webhook whose header carries multiple v1 signatures, as long as one matches (#2418)', async () => {
    const seller = await signupSeller('stripe-webhook-multi-v1');
    await env.DB.prepare(
      "UPDATE sellers SET stripe_account_id = 'acct_multi_v1', stripe_onboarding_status = 'complete' WHERE seller_id = ?",
    ).bind(seller.sellerId).run();

    const ts = Math.floor(Date.now() / 1000);
    const event = accountUpdatedEvent('acct_multi_v1', {
      requirements: { disabled_reason: 'requirements.past_due', currently_due: ['individual.verification.document'] },
    });
    const rawBody = JSON.stringify(event);
    const realSignature = await signStripePayload(ts, rawBody);
    // The real signature appears FIRST and a wrong one LAST — the pre-
    // #2418 Object.fromEntries parsing kept only the LAST v1 value, so
    // this exact ordering is what it got wrong (a real signature that
    // isn't the final v1 entry); this test pins the real fix (checking
    // every v1 value) rather than happening to use the one ordering the
    // old, buggy code tolerated by accident.
    const headers = { 'content-type': 'application/json' };
    headers['stripe-signature'] = `t=${ts},v1=${realSignature},v1=${'a'.repeat(64)}`;
    const response = await SELF.fetch('https://higglehaven.test/api/auth/stripe-webhook', {
      method: 'POST', headers, body: rawBody,
    });
    expect(response.status).toBe(200);

    const row = await env.DB.prepare('SELECT stripe_onboarding_status FROM sellers WHERE seller_id = ?')
      .bind(seller.sellerId).first();
    expect(row.stripe_onboarding_status).toBe('action_needed');
  });

  it('still rejects a webhook with multiple v1 signatures when none of them match', async () => {
    const seller = await signupSeller('stripe-webhook-multi-v1-bad');
    await env.DB.prepare(
      "UPDATE sellers SET stripe_account_id = 'acct_multi_v1_bad', stripe_onboarding_status = 'complete' WHERE seller_id = ?",
    ).bind(seller.sellerId).run();

    const ts = Math.floor(Date.now() / 1000);
    const rawBody = JSON.stringify(accountUpdatedEvent('acct_multi_v1_bad'));
    const headers = { 'content-type': 'application/json' };
    headers['stripe-signature'] = `t=${ts},v1=${'a'.repeat(64)},v1=${'b'.repeat(64)}`;
    const response = await SELF.fetch('https://higglehaven.test/api/auth/stripe-webhook', {
      method: 'POST', headers, body: rawBody,
    });
    expect(response.status).toBe(401);

    const row = await env.DB.prepare('SELECT stripe_onboarding_status FROM sellers WHERE seller_id = ?')
      .bind(seller.sellerId).first();
    expect(row.stripe_onboarding_status).toBe('complete');
  });

  // #872: Stripe's own webhook-verification guidance is to reject a
  // signature whose timestamp is too old, even when the HMAC itself is
  // valid -- otherwise a captured payload could be replayed indefinitely.
  it('rejects a webhook whose signature is correctly signed but too old', async () => {
    const seller = await signupSeller('stripe-webhook-stale-timestamp');
    await env.DB.prepare(
      "UPDATE sellers SET stripe_account_id = 'acct_stale', stripe_onboarding_status = 'complete' WHERE seller_id = ?",
    ).bind(seller.sellerId).run();

    const staleTimestamp = Math.floor(Date.now() / 1000) - 10 * 60;
    const stale = await postStripeWebhook(accountUpdatedEvent('acct_stale'), { timestamp: staleTimestamp });
    expect(stale.status).toBe(401);

    const row = await env.DB.prepare('SELECT stripe_onboarding_status FROM sellers WHERE seller_id = ?')
      .bind(seller.sellerId).first();
    expect(row.stripe_onboarding_status).toBe('complete');
  });

  it('re-derives and writes a disabled seller account back to action_needed', async () => {
    const seller = await signupSeller('stripe-webhook-seller-disabled');
    await env.DB.prepare(
      "UPDATE sellers SET stripe_account_id = 'acct_seller_disabled', stripe_onboarding_status = 'complete' WHERE seller_id = ?",
    ).bind(seller.sellerId).run();

    const response = await postStripeWebhook(accountUpdatedEvent('acct_seller_disabled', {
      requirements: { disabled_reason: 'requirements.past_due', currently_due: ['individual.verification.document'] },
    }));
    expect(response.status).toBe(200);

    const row = await env.DB.prepare('SELECT stripe_onboarding_status, stripe_requirements_due FROM sellers WHERE seller_id = ?')
      .bind(seller.sellerId).first();
    expect(row.stripe_onboarding_status).toBe('action_needed');
    expect(JSON.parse(row.stripe_requirements_due)).toEqual(['individual.verification.document']);

    // The same live status is reflected back out through the seller's own
    // GET endpoint, not just the raw DB row.
    const status = await api('/sellers/me/stripe-account', seller.session());
    expect(status.body.status).toBe('action_needed');
  });

  it('re-derives and writes a builder account the same way, independent of the sellers table', async () => {
    const builder = await signupBuilder('stripe-webhook-builder-disabled');
    await env.DB.prepare(
      "UPDATE builders SET stripe_account_id = 'acct_builder_disabled', stripe_onboarding_status = 'complete' WHERE builder_id = ?",
    ).bind(builder.builderId).run();

    const response = await postStripeWebhook(accountUpdatedEvent('acct_builder_disabled', {
      requirements: { disabled_reason: 'rejected.fraud', currently_due: [] },
    }));
    expect(response.status).toBe(200);

    const row = await env.DB.prepare('SELECT stripe_onboarding_status FROM builders WHERE builder_id = ?')
      .bind(builder.builderId).first();
    expect(row.stripe_onboarding_status).toBe('action_needed');

    const status = await api('/builders/me/stripe-account', builder.session());
    expect(status.body.status).toBe('action_needed');
  });

  it('writes complete once charges_enabled and payouts_enabled are both true with no requirements due', async () => {
    const seller = await signupSeller('stripe-webhook-seller-complete');
    await env.DB.prepare(
      "UPDATE sellers SET stripe_account_id = 'acct_seller_complete', stripe_onboarding_status = 'requirements_due' WHERE seller_id = ?",
    ).bind(seller.sellerId).run();

    const response = await postStripeWebhook(accountUpdatedEvent('acct_seller_complete', {
      charges_enabled: true,
      payouts_enabled: true,
    }));
    expect(response.status).toBe(200);

    const row = await env.DB.prepare('SELECT stripe_onboarding_status FROM sellers WHERE seller_id = ?')
      .bind(seller.sellerId).first();
    expect(row.stripe_onboarding_status).toBe('complete');
  });

  it('is a safe no-op for an account id that matches no seller or builder', async () => {
    const response = await postStripeWebhook(accountUpdatedEvent('acct_does_not_exist'));
    expect(response.status).toBe(200);
  });

  it('ignores event types other than account.updated', async () => {
    const seller = await signupSeller('stripe-webhook-wrong-type');
    await env.DB.prepare(
      "UPDATE sellers SET stripe_account_id = 'acct_wrong_type', stripe_onboarding_status = 'complete' WHERE seller_id = ?",
    ).bind(seller.sellerId).run();

    const response = await postStripeWebhook({
      type: 'account.application.deauthorized',
      data: { object: { id: 'acct_wrong_type' } },
    });
    expect(response.status).toBe(200);

    const row = await env.DB.prepare('SELECT stripe_onboarding_status FROM sellers WHERE seller_id = ?')
      .bind(seller.sellerId).first();
    expect(row.stripe_onboarding_status).toBe('complete');
  });

  // #2921 (sub-issue of #2919): confirms this webhook handler needs no
  // code changes for a v2-created account, not just by inspection but by
  // actually driving both halves of the real flow -- #2920's own
  // createOrUpdateStripeAccount (POST /v2/core/accounts, mocked the same
  // way worker/stripe-connect.test.js's "Accounts v2 migration (#2920)"
  // suite already does) to create a real v2 account, then this same
  // signed account.updated webhook against that exact resulting account
  // id. Per Stripe's own docs
  // (docs.stripe.com/connect/accounts-v2/migrate-integration), updating a
  // v2 Account still emits a full v1-shaped account.updated snapshot
  // (requirements.currently_due/charges_enabled/payouts_enabled), which is
  // exactly what deriveStripeOnboardingStatus already reads -- this proves
  // there's no discontinuity between the v2 creation half and the
  // (unchanged) webhook-update half for one real account, not just that
  // each half independently accepts v1-shaped input.
  it('re-derives status from a v1-shaped webhook payload for an account created via the v2 API (#2921)', async () => {
    const seller = await signupSeller('stripe-webhook-v2-created');
    const originalFetch = globalThis.fetch;
    env.STRIPE_SECRET_KEY = 'test-stripe-key';
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url === 'https://api.stripe.com/v2/core/accounts' && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'acct_v2_webhook_test', object: 'v2.core.account' }), { status: 200 });
      }
      if (url === 'https://api.stripe.com/v1/accounts/acct_v2_webhook_test' && init?.method === 'POST') {
        return new Response(JSON.stringify({
          id: 'acct_v2_webhook_test', requirements: { currently_due: [] }, charges_enabled: false, payouts_enabled: false,
        }), { status: 200 });
      }
      return originalFetch(input, init);
    };
    let created;
    try {
      created = await api('/sellers/me/stripe-account', seller.session({
        method: 'POST',
        body: JSON.stringify({
          individual: {
            firstName: 'Ada', lastName: 'Seller', dobDay: 12, dobMonth: 6, dobYear: 1990, ssnLast4: '1234', phone: '206-555-0100',
            addressLine1: '123 Main St', addressCity: 'Seattle', addressState: 'WA', addressPostalCode: '98101', addressCountry: 'US',
          },
          externalAccount: { routingNumber: '110000000', accountNumber: '000123456789', currency: 'usd' },
        }),
      }));
    } finally {
      globalThis.fetch = originalFetch;
      env.STRIPE_SECRET_KEY = undefined;
    }
    expect(created.response.status).toBe(200);
    const createdRow = await env.DB.prepare('SELECT stripe_account_id, stripe_onboarding_status FROM sellers WHERE seller_id = ?')
      .bind(seller.sellerId).first();
    expect(createdRow.stripe_account_id).toBe('acct_v2_webhook_test');
    expect(createdRow.stripe_onboarding_status).toBe('pending');

    // Now Stripe tells us (via the same v1-shaped account.updated event
    // every other test in this file already exercises) that this exact
    // v2-created account still has a requirement outstanding.
    const response = await postStripeWebhook(accountUpdatedEvent('acct_v2_webhook_test', {
      requirements: { disabled_reason: 'requirements.past_due', currently_due: ['individual.verification.document'] },
    }));
    expect(response.status).toBe(200);

    const updatedRow = await env.DB.prepare('SELECT stripe_onboarding_status, stripe_requirements_due FROM sellers WHERE seller_id = ?')
      .bind(seller.sellerId).first();
    expect(updatedRow.stripe_onboarding_status).toBe('action_needed');
    expect(JSON.parse(updatedRow.stripe_requirements_due)).toEqual(['individual.verification.document']);
  });
});

// #1086: a charge can be reversed by Stripe's own initiative (a bank
// chargeback, or a dashboard-initiated refund) entirely outside this
// app's own POST /purchases/:id/refund — these three event types are how
// this app finds out and claws the builder's commission back the same
// way that endpoint already does. Same setup pattern as
// commerce.test.js's own "Real-money refunds" tests: a purchase is
// created through the real purchase flow, then a payment_intent_id is
// attached directly (standing in for one handlePurchaseFinalize would
// have written via a real Stripe checkout, which this suite never
// configures) since these webhook tests only care that the id is set,
// not how it got there.
describe('Stripe purchase-reversal webhooks (#1086)', () => {
  async function createGreenbeltLandletWithArea(landletId, areaM2) {
    return api('/landlets', adminSession({
      method: 'POST',
      body: JSON.stringify({ landletId, name: `Test ${landletId}`, areaM2, status: 'greenbelt' }),
    }));
  }

  async function claim(landletId, builder) {
    return api(`/landlets/${landletId}/claim`, builder.session({ method: 'POST' }));
  }

  async function createTemplate(templateId, { priceCents } = {}) {
    const created = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId,
        name: `Purchasable product ${templateId}`,
        color: '#123456',
        dimensions: { width: 1, depth: 1, height: 1 },
        priceCents,
      }),
    });
    expect(created.response.status).toBe(201);
    return templateId;
  }

  async function placeInstance(instanceId, landletId, templateId, builder) {
    const placed = await api('/instances', builder.session({
      method: 'POST',
      body: JSON.stringify({ instanceId, landletId, templateId, x: 0, y: 0 }),
    }));
    expect(placed.response.status).toBe(201);
    return instanceId;
  }

  async function builderRow(builderId) {
    return env.DB.prepare('SELECT * FROM builders WHERE builder_id = ?').bind(builderId).first();
  }

  // Full setup: a real-money purchase (payment_intent_id attached, same
  // technique as commerce.test.js's own refund tests), whose host builder
  // earns builder_share_cents commission on sale — returns everything a
  // reversal-event test needs to assert against.
  async function createRealMoneyPurchase(label, paymentIntentId) {
    // #653: the simulated purchase path (what this writes before the test
    // itself bolts on a payment_intent_id to stand in for a real one) is
    // now admin-only.
    const builder = await signupAdmin(`${label}-builder`);
    await createGreenbeltLandletWithArea(`${label}-landlet`, 1000);
    await claim(`${label}-landlet`, builder);
    await createTemplate(`${label}-template`, { priceCents: 10000 });
    await placeInstance(`${label}-instance`, `${label}-landlet`, `${label}-template`, builder);
    const purchased = await api(`/instances/${label}-instance/purchase`, builder.session({ method: 'POST' }));
    const { purchaseId, builderShareCents } = purchased.body.purchase;
    await env.DB.prepare('UPDATE purchases SET payment_intent_id = ? WHERE purchase_id = ?')
      .bind(paymentIntentId, purchaseId).run();
    return { builder, purchaseId, builderShareCents };
  }

  // #2232: defaults to a fully-refunded charge (refunded: true) -- the only
  // case that should trigger a full clawback. Pass { refunded: false } to
  // simulate a partial refund.
  function chargeRefundedEvent(paymentIntentId, overrides = {}) {
    return { type: 'charge.refunded', data: { object: { id: 'ch_x', payment_intent: paymentIntentId, refunded: true, ...overrides } } };
  }

  function disputeEvent(type, paymentIntentId, overrides = {}) {
    return { type, data: { object: { id: 'dp_x', payment_intent: paymentIntentId, ...overrides } } };
  }

  it('claws back the full builder commission on charge.refunded', async () => {
    const { builder, purchaseId, builderShareCents } = await createRealMoneyPurchase('webhook-refunded', 'pi_webhook_refunded');
    const before = await builderRow(builder.builderId);

    const response = await postStripeWebhook(chargeRefundedEvent('pi_webhook_refunded'));
    expect(response.status).toBe(200);

    const purchaseRow = await env.DB.prepare('SELECT refunded_at FROM purchases WHERE purchase_id = ?').bind(purchaseId).first();
    expect(purchaseRow.refunded_at).not.toBeNull();
    const after = await builderRow(builder.builderId);
    expect(after.higgles_balance_cents).toBe(before.higgles_balance_cents - builderShareCents);
  });

  // #2232: a charge.refunded event with refunded: false is a PARTIAL
  // refund (Stripe fires this event for any refund amount, not just a
  // full one) -- treating it as a full reversal clawed back the entire
  // commission and revoked ownership over e.g. a $1 goodwill refund on a
  // $100 purchase. #2247 (owner decision 2026-10-25) later resolved what
  // SHOULD happen instead: a proportional clawback of exactly the
  // refunded fraction, not zero and not the full amount -- see
  // handlePartialRefundWebhookEvent's own comment.
  it('proportionally claws back the builder commission on a partial refund (#2247)', async () => {
    const { builder, purchaseId, builderShareCents } = await createRealMoneyPurchase('webhook-partial-refund', 'pi_webhook_partial_refund');
    const before = await builderRow(builder.builderId);

    // 1000 of 10000 total_cents -- a clean 10% refund fraction.
    const response = await postStripeWebhook(chargeRefundedEvent('pi_webhook_partial_refund', { refunded: false, amount_refunded: 1000 }));
    expect(response.status).toBe(200);

    const purchaseRow = await env.DB.prepare('SELECT refunded_at, refunded_amount_cents FROM purchases WHERE purchase_id = ?').bind(purchaseId).first();
    expect(purchaseRow.refunded_at).toBeNull();
    expect(purchaseRow.refunded_amount_cents).toBe(1000);
    const expectedClawbackCents = Math.round(builderShareCents * 0.1);
    expect(expectedClawbackCents).toBeGreaterThan(0);
    const after = await builderRow(builder.builderId);
    expect(after.higgles_balance_cents).toBe(before.higgles_balance_cents - expectedClawbackCents);
  });

  // A second, later partial refund on the same purchase must claw back
  // only the NEWLY-refunded fraction, not the whole cumulative total again
  // -- charge.amount_refunded is always the charge's running total, not a
  // per-event delta, so naively treating it as a delta would massively
  // over-claw-back on a second event.
  it('claws back only the incremental fraction on a second partial refund of the same purchase', async () => {
    const { builder, purchaseId, builderShareCents } = await createRealMoneyPurchase('webhook-second-partial-refund', 'pi_webhook_second_partial_refund');
    const before = await builderRow(builder.builderId);

    await postStripeWebhook(chargeRefundedEvent('pi_webhook_second_partial_refund', { refunded: false, amount_refunded: 1000 }));
    const response = await postStripeWebhook(chargeRefundedEvent('pi_webhook_second_partial_refund', { refunded: false, amount_refunded: 3000 }));
    expect(response.status).toBe(200);

    const purchaseRow = await env.DB.prepare('SELECT refunded_at, refunded_amount_cents FROM purchases WHERE purchase_id = ?').bind(purchaseId).first();
    expect(purchaseRow.refunded_at).toBeNull();
    expect(purchaseRow.refunded_amount_cents).toBe(3000);
    const expectedTotalClawbackCents = Math.round(builderShareCents * 0.3);
    const after = await builderRow(builder.builderId);
    expect(after.higgles_balance_cents).toBe(before.higgles_balance_cents - expectedTotalClawbackCents);
  });

  // A retried webhook delivery (Stripe retries any non-2xx response) must
  // not double-claw-back -- re-delivering the identical amount_refunded is
  // a no-op the second time.
  it('is idempotent against a retried delivery reporting the same amount_refunded again', async () => {
    const { builder, purchaseId, builderShareCents } = await createRealMoneyPurchase('webhook-partial-refund-retry', 'pi_webhook_partial_refund_retry');
    const before = await builderRow(builder.builderId);

    await postStripeWebhook(chargeRefundedEvent('pi_webhook_partial_refund_retry', { refunded: false, amount_refunded: 1000 }));
    const retry = await postStripeWebhook(chargeRefundedEvent('pi_webhook_partial_refund_retry', { refunded: false, amount_refunded: 1000 }));
    expect(retry.status).toBe(200);

    const purchaseRow = await env.DB.prepare('SELECT refunded_amount_cents FROM purchases WHERE purchase_id = ?').bind(purchaseId).first();
    expect(purchaseRow.refunded_amount_cents).toBe(1000);
    const expectedClawbackCents = Math.round(builderShareCents * 0.1);
    const after = await builderRow(builder.builderId);
    expect(after.higgles_balance_cents).toBe(before.higgles_balance_cents - expectedClawbackCents);
  });

  // A subsequent charge.refunded delivery reporting the charge is now FULLY
  // refunded (refunded: true, e.g. once cumulative partial refunds reach
  // the full amount) must still claw back normally -- the partial-refund
  // fix must not accidentally suppress a genuine full reversal.
  it('still claws back once a later charge.refunded event reports the charge as fully refunded', async () => {
    const { builder, purchaseId, builderShareCents } = await createRealMoneyPurchase('webhook-then-full-refund', 'pi_webhook_then_full_refund');
    const before = await builderRow(builder.builderId);

    const partial = await postStripeWebhook(chargeRefundedEvent('pi_webhook_then_full_refund', { refunded: false }));
    expect(partial.status).toBe(200);

    const full = await postStripeWebhook(chargeRefundedEvent('pi_webhook_then_full_refund', { refunded: true }));
    expect(full.status).toBe(200);

    const purchaseRow = await env.DB.prepare('SELECT refunded_at FROM purchases WHERE purchase_id = ?').bind(purchaseId).first();
    expect(purchaseRow.refunded_at).not.toBeNull();
    const after = await builderRow(builder.builderId);
    expect(after.higgles_balance_cents).toBe(before.higgles_balance_cents - builderShareCents);
  });

  // #2247: a genuine partial refund (amount_refunded actually set, unlike
  // the degenerate case above) followed by a later full reversal must claw
  // back only the REMAINING, not-yet-recovered portion of the commission
  // on the full event -- clawBackPurchaseCommission would otherwise claw
  // back the full creditedCents a second time on top of what the partial
  // event already recovered, double-counting it and driving the builder's
  // balance further negative than the purchase ever actually cost them.
  it('does not double-claw-back commission already recovered by an earlier partial refund once the charge is later fully refunded', async () => {
    const { builder, purchaseId, builderShareCents } = await createRealMoneyPurchase('webhook-partial-then-full-refund', 'pi_webhook_partial_then_full_refund');
    const before = await builderRow(builder.builderId);

    const partial = await postStripeWebhook(chargeRefundedEvent('pi_webhook_partial_then_full_refund', { refunded: false, amount_refunded: 4000 }));
    expect(partial.status).toBe(200);

    const full = await postStripeWebhook(chargeRefundedEvent('pi_webhook_partial_then_full_refund', { refunded: true }));
    expect(full.status).toBe(200);

    const purchaseRow = await env.DB.prepare('SELECT refunded_at, refunded_amount_cents FROM purchases WHERE purchase_id = ?').bind(purchaseId).first();
    expect(purchaseRow.refunded_at).not.toBeNull();
    expect(purchaseRow.refunded_amount_cents).toBe(10000);
    const after = await builderRow(builder.builderId);
    // The total clawback across BOTH events must equal exactly
    // builderShareCents -- not more (double-counted) and not less
    // (under-recovered).
    expect(after.higgles_balance_cents).toBe(before.higgles_balance_cents - builderShareCents);
  });

  it('claws back the commission on charge.dispute.funds_withdrawn, the real money-movement signal', async () => {
    const { builder, purchaseId, builderShareCents } = await createRealMoneyPurchase('webhook-dispute-withdrawn', 'pi_webhook_dispute_withdrawn');
    const before = await builderRow(builder.builderId);

    const response = await postStripeWebhook(disputeEvent('charge.dispute.funds_withdrawn', 'pi_webhook_dispute_withdrawn'));
    expect(response.status).toBe(200);

    const purchaseRow = await env.DB.prepare('SELECT refunded_at FROM purchases WHERE purchase_id = ?').bind(purchaseId).first();
    expect(purchaseRow.refunded_at).not.toBeNull();
    const after = await builderRow(builder.builderId);
    expect(after.higgles_balance_cents).toBe(before.higgles_balance_cents - builderShareCents);
  });

  // #2419 (owner decision 2026-10-25): charge.dispute.created also fires
  // for a pre-dispute INQUIRY (status warning_*), which never actually
  // withdraws any funds -- only charge.dispute.funds_withdrawn does.
  // Neither charge.dispute.created nor charge.dispute.closed is in
  // STRIPE_PURCHASE_REVERSAL_EVENT_TYPES anymore, so both must be safe
  // no-ops now, regardless of status -- this is the regression test for
  // the bug #2419 itself describes (an inquiry used to claw back the
  // full commission immediately, with nothing that ever reversed it).
  it('does not claw back anything on charge.dispute.created or charge.dispute.closed -- only funds_withdrawn/funds_reinstated are real money-movement signals', async () => {
    const { builder, purchaseId, builderShareCents } = await createRealMoneyPurchase('webhook-dispute-inquiry', 'pi_webhook_dispute_inquiry');
    const before = await builderRow(builder.builderId);
    expect(builderShareCents).toBeGreaterThan(0);

    const created = await postStripeWebhook(disputeEvent('charge.dispute.created', 'pi_webhook_dispute_inquiry', { status: 'warning_needs_response' }));
    expect(created.status).toBe(200);
    const closedWon = await postStripeWebhook(disputeEvent('charge.dispute.closed', 'pi_webhook_dispute_inquiry', { status: 'won' }));
    expect(closedWon.status).toBe(200);
    const closedLost = await postStripeWebhook(disputeEvent('charge.dispute.closed', 'pi_webhook_dispute_inquiry', { status: 'lost' }));
    expect(closedLost.status).toBe(200);

    const purchaseRow = await env.DB.prepare('SELECT refunded_at FROM purchases WHERE purchase_id = ?').bind(purchaseId).first();
    expect(purchaseRow.refunded_at).toBeNull();
    const after = await builderRow(builder.builderId);
    expect(after.higgles_balance_cents).toBe(before.higgles_balance_cents);
  });

  // #2419: charge.dispute.funds_reinstated is the real reversal signal --
  // the dispute resolved in the merchant's favor and the card network
  // actually returned the withheld funds. Credits back the exact amount
  // funds_withdrawn clawed back, and un-marks the purchase as reversed.
  it('reinstates the commission and un-marks the purchase on charge.dispute.funds_reinstated', async () => {
    const { builder, purchaseId, builderShareCents } = await createRealMoneyPurchase('webhook-dispute-reinstated', 'pi_webhook_dispute_reinstated');
    const before = await builderRow(builder.builderId);

    const withdrawn = await postStripeWebhook(disputeEvent('charge.dispute.funds_withdrawn', 'pi_webhook_dispute_reinstated'));
    expect(withdrawn.status).toBe(200);
    const afterWithdrawn = await builderRow(builder.builderId);
    expect(afterWithdrawn.higgles_balance_cents).toBe(before.higgles_balance_cents - builderShareCents);

    const reinstated = await postStripeWebhook(disputeEvent('charge.dispute.funds_reinstated', 'pi_webhook_dispute_reinstated'));
    expect(reinstated.status).toBe(200);

    const purchaseRow = await env.DB.prepare('SELECT refunded_at, refunded_amount_cents FROM purchases WHERE purchase_id = ?').bind(purchaseId).first();
    expect(purchaseRow.refunded_at).toBeNull();
    expect(purchaseRow.refunded_amount_cents).toBe(0);
    const afterReinstated = await builderRow(builder.builderId);
    expect(afterReinstated.higgles_balance_cents).toBe(before.higgles_balance_cents);
  });

  // #2901: a partial refund that happened BEFORE the dispute is a separate,
  // already-settled event the buyer keeps permanently regardless of how the
  // dispute resolves -- funds_withdrawn correctly claws back only the
  // REMAINING, not-yet-recovered portion (same alreadyClawedBackCents shape
  // as the partial-then-full-refund test above), so funds_reinstated must
  // credit back only that same remaining portion, not the purchase's full
  // commission. Crediting back the full amount would double-refund the
  // portion the earlier partial refund already (correctly) clawed back --
  // the bug this regression test guards against.
  it('reinstates only the portion this dispute itself clawed back when an earlier partial refund already recovered some commission', async () => {
    const { builder, purchaseId, builderShareCents } = await createRealMoneyPurchase('webhook-partial-dispute-reinst', 'pi_webhook_partial_then_dispute_reinstated');
    const before = await builderRow(builder.builderId);

    // 4000 of 10000 total_cents -- a clean 40% refund fraction, before any dispute.
    const partial = await postStripeWebhook(chargeRefundedEvent('pi_webhook_partial_then_dispute_reinstated', { refunded: false, amount_refunded: 4000 }));
    expect(partial.status).toBe(200);
    const partialClawbackCents = Math.round(builderShareCents * 0.4);
    const afterPartial = await builderRow(builder.builderId);
    expect(afterPartial.higgles_balance_cents).toBe(before.higgles_balance_cents - partialClawbackCents);

    const withdrawn = await postStripeWebhook(disputeEvent('charge.dispute.funds_withdrawn', 'pi_webhook_partial_then_dispute_reinstated'));
    expect(withdrawn.status).toBe(200);
    const disputeClawbackCents = builderShareCents - partialClawbackCents;
    const afterWithdrawn = await builderRow(builder.builderId);
    // Total clawed back across both events must equal exactly builderShareCents.
    expect(afterWithdrawn.higgles_balance_cents).toBe(before.higgles_balance_cents - builderShareCents);
    const withdrawnRow = await env.DB.prepare('SELECT refunded_amount_cents, pre_dispute_refunded_amount_cents FROM purchases WHERE purchase_id = ?').bind(purchaseId).first();
    expect(withdrawnRow.refunded_amount_cents).toBe(10000);
    expect(withdrawnRow.pre_dispute_refunded_amount_cents).toBe(4000);

    const reinstated = await postStripeWebhook(disputeEvent('charge.dispute.funds_reinstated', 'pi_webhook_partial_then_dispute_reinstated'));
    expect(reinstated.status).toBe(200);

    const purchaseRow = await env.DB.prepare('SELECT refunded_at, refunded_amount_cents, pre_dispute_refunded_amount_cents FROM purchases WHERE purchase_id = ?').bind(purchaseId).first();
    expect(purchaseRow.refunded_at).toBeNull();
    // Restored to the pre-dispute partial-refund total, not zeroed -- the
    // buyer still permanently keeps that earlier partial refund.
    expect(purchaseRow.refunded_amount_cents).toBe(4000);
    expect(purchaseRow.pre_dispute_refunded_amount_cents).toBeNull();
    const afterReinstated = await builderRow(builder.builderId);
    // Only the dispute's own clawback is reversed -- net balance change is
    // exactly the earlier partial refund's clawback, matching afterPartial.
    expect(afterReinstated.higgles_balance_cents).toBe(before.higgles_balance_cents - partialClawbackCents);
    expect(afterReinstated.higgles_balance_cents).toBe(afterWithdrawn.higgles_balance_cents + disputeClawbackCents);
  });

  // A retried delivery of funds_reinstated (Stripe's at-least-once
  // guarantee) must not double-credit -- the second one finds refunded_at
  // already NULL and no-ops.
  it('is idempotent against a retried funds_reinstated delivery', async () => {
    const { builder, builderShareCents } = await createRealMoneyPurchase('webhook-dispute-reinstated-retry', 'pi_webhook_dispute_reinstated_retry');
    const before = await builderRow(builder.builderId);

    await postStripeWebhook(disputeEvent('charge.dispute.funds_withdrawn', 'pi_webhook_dispute_reinstated_retry'));
    await postStripeWebhook(disputeEvent('charge.dispute.funds_reinstated', 'pi_webhook_dispute_reinstated_retry'));
    const retried = await postStripeWebhook(disputeEvent('charge.dispute.funds_reinstated', 'pi_webhook_dispute_reinstated_retry'));
    expect(retried.status).toBe(200);

    const after = await builderRow(builder.builderId);
    expect(after.higgles_balance_cents).toBe(before.higgles_balance_cents);
  });

  // funds_reinstated arriving for a purchase that was never actually
  // reversed (no prior funds_withdrawn, refunded_at already NULL) must be
  // a safe no-op, not a free, unearned credit.
  it('does nothing when funds_reinstated arrives for a purchase that was never reversed', async () => {
    const { builder } = await createRealMoneyPurchase('webhook-dispute-never-reversed', 'pi_webhook_dispute_never_reversed');
    const before = await builderRow(builder.builderId);

    const response = await postStripeWebhook(disputeEvent('charge.dispute.funds_reinstated', 'pi_webhook_dispute_never_reversed'));
    expect(response.status).toBe(200);

    const after = await builderRow(builder.builderId);
    expect(after.higgles_balance_cents).toBe(before.higgles_balance_cents);
  });

  it('is allowed to drive the builder balance negative, same as the /refund endpoint', async () => {
    const { builder, purchaseId } = await createRealMoneyPurchase('webhook-negative-balance', 'pi_webhook_negative_balance');
    await env.DB.prepare('UPDATE builders SET higgles_balance_cents = 0 WHERE builder_id = ?').bind(builder.builderId).run();

    const response = await postStripeWebhook(chargeRefundedEvent('pi_webhook_negative_balance'));
    expect(response.status).toBe(200);

    const purchaseRow = await env.DB.prepare('SELECT refunded_at FROM purchases WHERE purchase_id = ?').bind(purchaseId).first();
    expect(purchaseRow.refunded_at).not.toBeNull();
    const after = await builderRow(builder.builderId);
    expect(after.higgles_balance_cents).toBeLessThan(0);
  });

  // Whichever of a purchase's possibly-several reversal events lands
  // first (a retried webhook delivery, say) wins the clawback via the
  // same refunded_at-guarded update handlePurchaseRefund itself uses —
  // every later event for the same purchase must be a no-op, not a
  // second clawback.
  it('only claws back once across multiple reversal events for the same purchase', async () => {
    const { builder, builderShareCents } = await createRealMoneyPurchase('webhook-idempotent', 'pi_webhook_idempotent');
    const before = await builderRow(builder.builderId);

    const withdrawn = await postStripeWebhook(disputeEvent('charge.dispute.funds_withdrawn', 'pi_webhook_idempotent'));
    expect(withdrawn.status).toBe(200);
    // A retried delivery of the very same event, which Stripe's own
    // at-least-once delivery guarantee makes an ordinary occurrence, not
    // an edge case.
    const retried = await postStripeWebhook(disputeEvent('charge.dispute.funds_withdrawn', 'pi_webhook_idempotent'));
    expect(retried.status).toBe(200);

    const after = await builderRow(builder.builderId);
    expect(after.higgles_balance_cents).toBe(before.higgles_balance_cents - builderShareCents);
  });

  it('is a safe no-op when no purchase matches the event\'s payment_intent', async () => {
    const response = await postStripeWebhook(chargeRefundedEvent('pi_does_not_exist'));
    expect(response.status).toBe(200);
  });

  it('is a safe no-op when the event object carries no payment_intent at all', async () => {
    const response = await postStripeWebhook({ type: 'charge.refunded', data: { object: { id: 'ch_no_pi' } } });
    expect(response.status).toBe(200);
  });
});
