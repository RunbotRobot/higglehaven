import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, signupBuilder, signupSeller } from './test-helpers.js';

// Own file (own D1/worker isolate — see test-helpers.js's own comment on
// why the suite is split by file), same reasoning as
// worker/didit-verification.test.js: setting env.STRIPE_WEBHOOK_SECRET
// here can't leak into worker/reviews-auth.test.js, which relies on it
// staying unset to exercise the 503-unconfigured path for this same
// endpoint. STRIPE_SECRET_KEY is deliberately left unset even in this
// file — nothing here needs a real outbound call to Stripe, only the
// webhook's own signature verification and DB reconciliation.
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  env.STRIPE_WEBHOOK_SECRET = 'test-stripe-webhook-secret';
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
