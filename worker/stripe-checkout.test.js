// #453: real-money checkout alongside the pre-existing simulated purchase
// flow ("Real checkout (Stripe)" in docs/API.md). Same testing limit
// worker/stripe-connect.test.js already established for #452: the test
// environment never configures a real STRIPE_SECRET_KEY, and this suite
// runs inside workerd via @cloudflare/vitest-pool-workers, not a mockable
// Node/jsdom fetch — so only what's reachable WITHOUT an actual Stripe
// network call is covered here. Actually creating/retrieving a
// PaymentIntent was verified by direct code reading against Stripe's own
// documented API shape instead.
import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  api, signupBuilder, signupSeller, signupAdmin, createGreenbeltLandletAs,
} from './test-helpers.js';

let adminSession;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const admin = await signupAdmin('stripe-checkout-shared-admin');
  adminSession = admin.session;
});

function createGreenbeltLandlet(landletId) {
  return createGreenbeltLandletAs(adminSession, landletId);
}

async function claim(landletId, builder) {
  return api(`/landlets/${landletId}/claim`, builder.session({ method: 'POST' }));
}

async function createTemplate(templateId, seller, priceCents) {
  const created = await api('/catalog', seller.session({
    method: 'POST',
    body: JSON.stringify({
      templateId,
      name: `Checkout product ${templateId}`,
      color: '#654321',
      dimensions: { width: 1, depth: 1, height: 1 },
      priceCents,
      sellerId: seller.sellerId,
    }),
  }));
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

// Full fixture: a seller's priced product, placed on a builder-owned
// landlet — the shared setup every test below needs before it can even
// reach the purchase-intent/purchase endpoints.
async function setUpPurchasableInstance(idPrefix, { priceCents = 2500 } = {}) {
  const seller = await signupSeller(`${idPrefix}-seller`);
  const builder = await signupBuilder(`${idPrefix}-builder`);
  const landletId = `${idPrefix}-landlet`;
  const templateId = `${idPrefix}-template`;
  const instanceId = `${idPrefix}-instance`;
  await createGreenbeltLandlet(landletId);
  await claim(landletId, builder);
  await createTemplate(templateId, seller, priceCents);
  await placeInstance(instanceId, landletId, templateId, builder);
  return { seller, builder, landletId, templateId, instanceId };
}

async function markSellerStripeComplete(sellerId, stripeAccountId) {
  await env.DB.prepare(`
    UPDATE sellers SET stripe_account_id = ?, stripe_onboarding_status = 'complete' WHERE seller_id = ?
  `).bind(stripeAccountId, sellerId).run();
}

describe('Real checkout (Stripe) — purchase-intent', () => {
  it('reports configured: false when the server has no Stripe key at all', async () => {
    const { instanceId } = await setUpPurchasableInstance('intent-unconfigured');
    const { response, body } = await api(`/instances/${instanceId}/purchase-intent`, { method: 'POST' });
    expect(response.status).toBe(200);
    expect(body).toEqual({ configured: false });
  });

  it('reports configured: false for a 404 instance even before checking Stripe config', async () => {
    const missing = await api('/instances/checkout-missing-instance/purchase-intent', { method: 'POST' });
    expect(missing.response.status).toBe(404);
  });

  it('reports sellerReady: false once Stripe is configured but this seller has not finished onboarding', async () => {
    const { instanceId } = await setUpPurchasableInstance('intent-not-onboarded');
    const original = env.STRIPE_SECRET_KEY;
    env.STRIPE_SECRET_KEY = 'sk_test_fake_key_for_config_check_only';
    try {
      const { response, body } = await api(`/instances/${instanceId}/purchase-intent`, { method: 'POST' });
      expect(response.status).toBe(200);
      expect(body).toEqual({ configured: true, sellerReady: false });
    } finally {
      env.STRIPE_SECRET_KEY = original;
    }
  });

  it('still reports configured: false for a seller-less template even with a Stripe key set (never Stripe-ready, no sellerId to check)', async () => {
    const builder = await signupBuilder('intent-no-seller-builder');
    await createGreenbeltLandlet('intent-no-seller-landlet');
    await claim('intent-no-seller-landlet', builder);
    const created = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'intent-no-seller-template', name: 'No seller product', color: '#111111',
        dimensions: { width: 1, depth: 1, height: 1 }, priceCents: 1000,
      }),
    });
    expect(created.response.status).toBe(201);
    await placeInstance('intent-no-seller-instance', 'intent-no-seller-landlet', 'intent-no-seller-template', builder);

    const original = env.STRIPE_SECRET_KEY;
    env.STRIPE_SECRET_KEY = 'sk_test_fake_key_for_config_check_only';
    try {
      const { response, body } = await api('/instances/intent-no-seller-instance/purchase-intent', { method: 'POST' });
      expect(response.status).toBe(200);
      expect(body).toEqual({ configured: false });
    } finally {
      env.STRIPE_SECRET_KEY = original;
    }
  });
});

describe('Real checkout (Stripe) — purchase confirm guard', () => {
  it('rejects the old simulated shape (no paymentIntentId) once this seller is Stripe-ready', async () => {
    const { seller, instanceId } = await setUpPurchasableInstance('confirm-guard');
    await markSellerStripeComplete(seller.sellerId, 'acct_test_fake');
    const original = env.STRIPE_SECRET_KEY;
    env.STRIPE_SECRET_KEY = 'sk_test_fake_key_for_config_check_only';
    try {
      const rejected = await api(`/instances/${instanceId}/purchase`, { method: 'POST' });
      expect(rejected.response.status).toBe(400);
      expect(rejected.body.error).toMatch(/real payment/i);
    } finally {
      env.STRIPE_SECRET_KEY = original;
    }
  });

  it('still allows the simulated shape for a non-Stripe-ready seller even once the server has a key configured', async () => {
    const { instanceId } = await setUpPurchasableInstance('confirm-not-ready');
    const original = env.STRIPE_SECRET_KEY;
    env.STRIPE_SECRET_KEY = 'sk_test_fake_key_for_config_check_only';
    try {
      const accepted = await api(`/instances/${instanceId}/purchase`, { method: 'POST' });
      expect(accepted.response.status).toBe(201);
      expect(accepted.body.purchase.stripePaymentIntentId).toBeNull();
    } finally {
      env.STRIPE_SECRET_KEY = original;
    }
  });

  it('503s a real-payment confirm attempt if Stripe is not configured at all', async () => {
    const { instanceId } = await setUpPurchasableInstance('confirm-no-config');
    const attempted = await api(`/instances/${instanceId}/purchase`, {
      method: 'POST',
      body: JSON.stringify({ paymentIntentId: 'pi_fake_never_created' }),
    });
    expect(attempted.response.status).toBe(503);
  });

  it('409s a paymentIntentId that has already been applied to a purchase, without ever calling Stripe', async () => {
    const { instanceId, templateId, landletId } = await setUpPurchasableInstance('confirm-dup');
    const template = await env.DB.prepare('SELECT * FROM catalog_templates WHERE template_id = ?').bind(templateId).first();
    const landlet = await env.DB.prepare('SELECT owner_builder_id FROM landlets WHERE landlet_id = ?').bind(landletId).first();

    // Plants a purchase row already carrying this stripe_payment_intent_id
    // directly (the same "manipulate D1 directly for a fixture only the
    // real flow would otherwise produce" pattern this suite's sibling
    // files already use for auction/version races) — this test only
    // needs to prove the 409/uniqueness guard, not a full real checkout.
    await env.DB.prepare(`
      INSERT INTO purchases
        (purchase_id, instance_id, template_id, builder_id, seller_id, buyer_label,
         unit_price_cents, quantity, total_cents, commission_cents, builder_share_cents, platform_share_cents,
         stripe_payment_intent_id)
      VALUES ('purchase-confirm-dup-existing', ?, ?, ?, ?, NULL, 2500, 1, 2500, 50, 25, 25, 'pi_already_used')
    `).bind(instanceId, template.template_id, landlet.owner_builder_id, template.seller_id).run();

    const original = env.STRIPE_SECRET_KEY;
    env.STRIPE_SECRET_KEY = 'sk_test_fake_key_for_config_check_only';
    try {
      const attempted = await api(`/instances/${instanceId}/purchase`, {
        method: 'POST',
        body: JSON.stringify({ paymentIntentId: 'pi_already_used' }),
      });
      expect(attempted.response.status).toBe(409);
    } finally {
      env.STRIPE_SECRET_KEY = original;
    }
  });
});
