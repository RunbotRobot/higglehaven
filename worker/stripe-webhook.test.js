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
    const builder = await signupBuilder(`${label}-builder`);
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

  function chargeRefundedEvent(paymentIntentId) {
    return { type: 'charge.refunded', data: { object: { id: 'ch_x', payment_intent: paymentIntentId } } };
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

  it('claws back the commission immediately on charge.dispute.created, before any resolution', async () => {
    const { builder, purchaseId, builderShareCents } = await createRealMoneyPurchase('webhook-dispute-created', 'pi_webhook_dispute_created');
    const before = await builderRow(builder.builderId);

    const response = await postStripeWebhook(disputeEvent('charge.dispute.created', 'pi_webhook_dispute_created', { status: 'warning_needs_response' }));
    expect(response.status).toBe(200);

    const purchaseRow = await env.DB.prepare('SELECT refunded_at FROM purchases WHERE purchase_id = ?').bind(purchaseId).first();
    expect(purchaseRow.refunded_at).not.toBeNull();
    const after = await builderRow(builder.builderId);
    expect(after.higgles_balance_cents).toBe(before.higgles_balance_cents - builderShareCents);
  });

  it('claws back the commission on charge.dispute.closed too, when no earlier event already did', async () => {
    const { builder, purchaseId, builderShareCents } = await createRealMoneyPurchase('webhook-dispute-closed', 'pi_webhook_dispute_closed');
    const before = await builderRow(builder.builderId);

    const response = await postStripeWebhook(disputeEvent('charge.dispute.closed', 'pi_webhook_dispute_closed', { status: 'lost' }));
    expect(response.status).toBe(200);

    const purchaseRow = await env.DB.prepare('SELECT refunded_at FROM purchases WHERE purchase_id = ?').bind(purchaseId).first();
    expect(purchaseRow.refunded_at).not.toBeNull();
    const after = await builderRow(builder.builderId);
    expect(after.higgles_balance_cents).toBe(before.higgles_balance_cents - builderShareCents);
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
  // first (a dispute created, then later closed) wins the clawback via
  // the same refunded_at-guarded update handlePurchaseRefund itself
  // uses — every later event for the same purchase must be a no-op, not
  // a second clawback.
  it('only claws back once across multiple reversal events for the same purchase', async () => {
    const { builder, builderShareCents } = await createRealMoneyPurchase('webhook-idempotent', 'pi_webhook_idempotent');
    const before = await builderRow(builder.builderId);

    const created = await postStripeWebhook(disputeEvent('charge.dispute.created', 'pi_webhook_idempotent', { status: 'warning_needs_response' }));
    expect(created.status).toBe(200);
    const closed = await postStripeWebhook(disputeEvent('charge.dispute.closed', 'pi_webhook_idempotent', { status: 'lost' }));
    expect(closed.status).toBe(200);
    // A retried delivery of the very same event, which Stripe's own
    // at-least-once delivery guarantee makes an ordinary occurrence, not
    // an edge case.
    const retried = await postStripeWebhook(disputeEvent('charge.dispute.closed', 'pi_webhook_idempotent', { status: 'lost' }));
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
