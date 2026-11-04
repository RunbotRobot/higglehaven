import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, signupAdmin } from './test-helpers.js';

// Own file (own D1/worker isolate), same reasoning as stripe-webhook.test.js.
let adminSession;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  env.STRIPE_WEBHOOK_SECRET = 'test-stripe-webhook-secret';
  adminSession = (await signupAdmin('dispute-order-admin')).session;
});

afterAll(() => {
  env.STRIPE_WEBHOOK_SECRET = undefined;
});

async function postStripeWebhook(eventObject) {
  const rawBody = JSON.stringify(eventObject);
  const ts = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}.${rawBody}`)));
  const hex = [...sig].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return SELF.fetch('https://higglehaven.test/api/auth/stripe-webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': `t=${ts},v1=${hex}` },
    body: rawBody,
  });
}

async function createRealMoneyPurchase(label, paymentIntentId) {
  const builder = await signupAdmin(`${label}-builder`);
  const landletId = `${label}-landlet`;
  await api('/landlets', adminSession({
    method: 'POST', body: JSON.stringify({ landletId, name: label, areaM2: 1000, status: 'greenbelt' }),
  }));
  await api(`/landlets/${landletId}/claim`, builder.session({ method: 'POST' }));
  await api('/catalog', {
    method: 'POST',
    body: JSON.stringify({
      templateId: `${label}-template`, name: `Product ${label}`, color: '#123456',
      dimensions: { width: 1, depth: 1, height: 1 }, priceCents: 10000,
    }),
  });
  await api('/instances', builder.session({
    method: 'POST',
    body: JSON.stringify({ instanceId: `${label}-instance`, landletId, templateId: `${label}-template`, x: 0, y: 0 }),
  }));
  const purchased = await api(`/instances/${label}-instance/purchase`, builder.session({ method: 'POST' }));
  const { purchaseId } = purchased.body.purchase;
  await env.DB.prepare('UPDATE purchases SET payment_intent_id = ? WHERE purchase_id = ?')
    .bind(paymentIntentId, purchaseId).run();
  return { builder, purchaseId };
}

const dispute = (type, paymentIntentId, created) => ({
  id: `evt_${type}_${created}`, type, created, data: { object: { id: 'dp_x', payment_intent: paymentIntentId } },
});

describe('Dispute webhook delivery order', () => {
  it('a funds_withdrawn delivered after the funds_reinstated that followed it must not reverse a won dispute', async () => {
    const { builder, purchaseId } = await createRealMoneyPurchase('order', 'pi_dispute_order');
    const balance = async () => (await env.DB.prepare('SELECT higgles_balance_cents FROM builders WHERE builder_id = ?')
      .bind(builder.builderId).first()).higgles_balance_cents;
    const before = await balance();

    // Stripe emitted withdrawn at t=1000 and reinstated at t=2000 (the dispute was won), but delivered
    // them reinstated-first (webhook retries and ordering are not guaranteed).
    expect((await postStripeWebhook(dispute('charge.dispute.funds_reinstated', 'pi_dispute_order', 2000))).status).toBe(200);
    expect((await postStripeWebhook(dispute('charge.dispute.funds_withdrawn', 'pi_dispute_order', 1000))).status).toBe(200);

    const row = await env.DB.prepare('SELECT refunded_at FROM purchases WHERE purchase_id = ?').bind(purchaseId).first();
    expect(row.refunded_at).toBeNull();
    expect(await balance()).toBe(before);
  });

  it('still applies a withdrawn then a reinstated delivered in order, and a later second dispute cycle', async () => {
    const { builder, purchaseId } = await createRealMoneyPurchase('inorder', 'pi_dispute_inorder');
    const refundedAt = async () => (await env.DB.prepare('SELECT refunded_at FROM purchases WHERE purchase_id = ?')
      .bind(purchaseId).first()).refunded_at;
    const balance = async () => (await env.DB.prepare('SELECT higgles_balance_cents FROM builders WHERE builder_id = ?')
      .bind(builder.builderId).first()).higgles_balance_cents;
    const before = await balance();

    await postStripeWebhook(dispute('charge.dispute.funds_withdrawn', 'pi_dispute_inorder', 1000));
    expect(await refundedAt()).not.toBeNull();
    // A retried delivery of the same event changes nothing further.
    await postStripeWebhook(dispute('charge.dispute.funds_withdrawn', 'pi_dispute_inorder', 1000));
    await postStripeWebhook(dispute('charge.dispute.funds_reinstated', 'pi_dispute_inorder', 2000));
    expect(await refundedAt()).toBeNull();
    expect(await balance()).toBe(before);

    // A genuinely newer second dispute on the same purchase is not mistaken for a stale event.
    await postStripeWebhook(dispute('charge.dispute.funds_withdrawn', 'pi_dispute_inorder', 3000));
    expect(await refundedAt()).not.toBeNull();
  });
});
