import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, signupAdmin, signupSeller } from './test-helpers.js';

// #3072: every path that reverses a sale reduced the seller's earnings but
// only the hosting builder was told. Own file (own D1/worker isolate), same
// reasoning as stripe-webhook.test.js.
let adminSession;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  env.STRIPE_WEBHOOK_SECRET = 'test-stripe-webhook-secret';
  adminSession = (await signupAdmin('seller-notice-admin')).session;
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

const dollars = (cents) => `$${(cents / 100).toFixed(2)}`;

// A real-money-shaped purchase of a seller-owned product hosted on a
// separate builder's landlet. The seller also gets a builder row (the
// notice goes to the seller's builder, resolved via user_id).
async function createSellerPurchase(label, paymentIntentId) {
  const seller = await signupSeller(`${label}-seller`);
  const sellerBuilder = await api('/builders/me', seller.session());
  const host = await signupAdmin(`${label}-host`);
  const landletId = `${label}-landlet`;
  await api('/landlets', adminSession({
    method: 'POST', body: JSON.stringify({ landletId, name: label, areaM2: 1000, status: 'greenbelt' }),
  }));
  await api(`/landlets/${landletId}/claim`, host.session({ method: 'POST' }));
  const created = await api('/catalog', seller.session({
    method: 'POST',
    body: JSON.stringify({
      templateId: `${label}-template`, sellerId: seller.sellerId, name: `Product ${label}`, color: '#123456',
      dimensions: { width: 1, depth: 1, height: 1 }, priceCents: 10000,
    }),
  }));
  expect(created.response.status).toBe(201);
  await api('/instances', host.session({
    method: 'POST',
    body: JSON.stringify({ instanceId: `${label}-instance`, landletId, templateId: `${label}-template`, x: 0, y: 0 }),
  }));
  const purchased = await api(`/instances/${label}-instance/purchase`, host.session({ method: 'POST' }));
  const { purchaseId } = purchased.body.purchase;
  await env.DB.prepare('UPDATE purchases SET payment_intent_id = ? WHERE purchase_id = ?')
    .bind(paymentIntentId, purchaseId).run();
  const row = await env.DB.prepare('SELECT total_cents, commission_cents FROM purchases WHERE purchase_id = ?')
    .bind(purchaseId).first();
  return {
    seller, sellerBuilderId: sellerBuilder.body.builder.builderId, purchaseId,
    shareCents: row.total_cents - row.commission_cents, totalCents: row.total_cents,
  };
}

async function sellerNotices(builderId) {
  const { results } = await env.DB.prepare(
    'SELECT message FROM notifications WHERE builder_id = ? ORDER BY created_at, notification_id',
  ).bind(builderId).all();
  return results.map((row) => row.message);
}

const chargeRefunded = (paymentIntentId, charge) => ({
  id: `evt_refund_${paymentIntentId}_${charge.amount_refunded}`,
  type: 'charge.refunded',
  data: { object: { payment_intent: paymentIntentId, ...charge } },
});
const dispute = (type, paymentIntentId, created) => ({
  id: `evt_${type}_${created}`, type, created, data: { object: { id: 'dp_x', payment_intent: paymentIntentId } },
});

describe('The seller is told when a sale they earned is reversed (#3072)', () => {
  it('a full refund webhook notifies the seller once, not again on redelivery', async () => {
    const ctx = await createSellerPurchase('full', 'pi_notice_full');
    const event = chargeRefunded('pi_notice_full', { refunded: true, amount_refunded: ctx.totalCents });
    expect((await postStripeWebhook(event)).status).toBe(200);
    expect((await postStripeWebhook(event)).status).toBe(200);
    const notices = await sellerNotices(ctx.sellerBuilderId);
    expect(notices).toEqual([
      `A sale of "Product full" was refunded or disputed, so ${dollars(ctx.shareCents)} will no longer be part of your earnings from it.`,
    ]);
  });

  it('a partial refund notifies the seller of the reduction once per new refunded total', async () => {
    const ctx = await createSellerPurchase('partial', 'pi_notice_partial');
    const reduction = ctx.shareCents - Math.round((ctx.shareCents * (ctx.totalCents - 2000)) / ctx.totalCents);
    const event = chargeRefunded('pi_notice_partial', { refunded: false, amount_refunded: 2000 });
    expect((await postStripeWebhook(event)).status).toBe(200);
    expect((await postStripeWebhook(event)).status).toBe(200);
    expect(await sellerNotices(ctx.sellerBuilderId)).toEqual([
      `A sale of "Product partial" was partially refunded, so your earnings from it are reduced by ${dollars(reduction)}.`,
    ]);
  });

  it('a dispute withdrawal and its reinstatement each notify once', async () => {
    const ctx = await createSellerPurchase('dispute', 'pi_notice_dispute');
    await postStripeWebhook(dispute('charge.dispute.funds_withdrawn', 'pi_notice_dispute', 1000));
    await postStripeWebhook(dispute('charge.dispute.funds_withdrawn', 'pi_notice_dispute', 1000));
    await postStripeWebhook(dispute('charge.dispute.funds_reinstated', 'pi_notice_dispute', 2000));
    await postStripeWebhook(dispute('charge.dispute.funds_reinstated', 'pi_notice_dispute', 2000));
    expect(await sellerNotices(ctx.sellerBuilderId)).toEqual([
      `A sale of "Product dispute" was refunded or disputed, so ${dollars(ctx.shareCents)} will no longer be part of your earnings from it.`,
      `A dispute over a sale of "Product dispute" was resolved in your favor, so ${dollars(ctx.shareCents)} counts toward your earnings from it again.`,
    ]);
  });

  it('an in-app refund notifies the seller once', async () => {
    const ctx = await createSellerPurchase('inapp', 'pi_notice_inapp');
    await env.DB.prepare('UPDATE purchases SET payment_intent_id = NULL WHERE purchase_id = ?').bind(ctx.purchaseId).run();
    const refunded = await api(`/purchases/${ctx.purchaseId}/refund`, ctx.seller.session({ method: 'POST' }));
    expect(refunded.response.status).toBe(200);
    const again = await api(`/purchases/${ctx.purchaseId}/refund`, ctx.seller.session({ method: 'POST' }));
    expect(again.response.status).toBe(409);
    const notices = await sellerNotices(ctx.sellerBuilderId);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('"Product inapp" was refunded or disputed');
  });

  it('notifies nobody and still completes the reversal when the seller row is gone', async () => {
    const ctx = await createSellerPurchase('gone', 'pi_notice_gone');
    await env.DB.prepare('DELETE FROM sellers WHERE seller_id = ?').bind(ctx.seller.sellerId).run();
    const event = chargeRefunded('pi_notice_gone', { refunded: true, amount_refunded: ctx.totalCents });
    expect((await postStripeWebhook(event)).status).toBe(200);
    const row = await env.DB.prepare('SELECT refunded_at FROM purchases WHERE purchase_id = ?').bind(ctx.purchaseId).first();
    expect(row.refunded_at).not.toBeNull();
    expect(await sellerNotices(ctx.sellerBuilderId)).toEqual([]);
  });
});
