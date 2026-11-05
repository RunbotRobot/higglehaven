import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { finalizeSucceededPaymentIntent } from './lib/purchase-creation.js';
import { api, signupAdmin, signupBuilder } from './test-helpers.js';

// #782: a charge that succeeded must produce exactly one purchase even if the
// buyer's POST /api/purchases/finalize never lands -- the signed
// payment_intent.succeeded webhook finalizes it through the same core.
// Own file (own D1/worker isolate), same reasoning as stripe-webhook.test.js.
let adminSession;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  env.STRIPE_WEBHOOK_SECRET = 'test-stripe-webhook-secret';
  adminSession = (await signupAdmin('pi-succeeded-admin')).session;
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

async function seed(label, { stock = null } = {}) {
  const seller = await signupBuilder(`${label}-seller`);
  const buyer = await signupBuilder(`${label}-buyer`);
  const landletId = `${label}-landlet`;
  await api('/landlets', adminSession({
    method: 'POST', body: JSON.stringify({ landletId, name: label, areaM2: 1000, status: 'greenbelt' }),
  }));
  await api(`/landlets/${landletId}/claim`, seller.session({ method: 'POST' }));
  await api('/catalog', {
    method: 'POST',
    body: JSON.stringify({
      templateId: `${label}-template`, name: `Product ${label}`, color: '#123456',
      dimensions: { width: 1, depth: 1, height: 1 }, priceCents: 1000,
    }),
  });
  if (stock != null) {
    await env.DB.prepare('UPDATE catalog_templates SET stock_quantity = ? WHERE template_id = ?')
      .bind(stock, `${label}-template`).run();
  }
  await api('/instances', seller.session({
    method: 'POST',
    body: JSON.stringify({ instanceId: `${label}-instance`, landletId, templateId: `${label}-template`, x: 0, y: 0 }),
  }));
  return { seller, buyer };
}

function succeededEvent(label, seller, buyer, paymentIntentId) {
  return {
    id: `evt_${paymentIntentId}`,
    type: 'payment_intent.succeeded',
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: paymentIntentId,
        status: 'succeeded',
        metadata: {
          instanceId: `${label}-instance`, templateId: `${label}-template`, builderId: seller.builderId,
          sellerId: '', quantity: '1', buyerLabel: '', unitPriceCents: '1000', totalCents: '1000',
          commissionCents: '100', builderShareCents: '700', platformShareCents: '200',
          isDigitalGood: 'false', buyerBuilderId: buyer.builderId, isAvatarCategory: 'false', isAnimationCategory: 'false',
        },
      },
    },
  };
}

const purchaseCount = async (pi) => (await env.DB.prepare('SELECT COUNT(*) AS n FROM purchases WHERE payment_intent_id = ?')
  .bind(pi).first()).n;
const earnings = async (builderId) => (await env.DB.prepare('SELECT COUNT(*) AS n FROM higgles_earnings_events WHERE builder_id = ?')
  .bind(builderId).first()).n;
const balance = async (builderId) => (await env.DB.prepare('SELECT higgles_balance_cents AS b FROM builders WHERE builder_id = ?')
  .bind(builderId).first()).b;

describe('payment_intent.succeeded webhook (#782)', () => {
  it('records exactly one purchase when finalize never lands, and a replay is a no-op', async () => {
    const { seller, buyer } = await seed('pi-basic');
    const event = succeededEvent('pi-basic', seller, buyer, 'pi_782_basic');
    const before = await balance(seller.builderId);

    expect((await postStripeWebhook(event)).status).toBe(200);
    expect(await purchaseCount('pi_782_basic')).toBe(1);
    expect(await balance(seller.builderId)).toBe(before + 700);
    expect(await earnings(seller.builderId)).toBe(1);
    const row = await env.DB.prepare('SELECT delivery_confirm_token_hash FROM purchases WHERE payment_intent_id = ?')
      .bind('pi_782_basic').first();
    expect(row.delivery_confirm_token_hash).toBeTruthy();

    expect((await postStripeWebhook(event)).status).toBe(200);
    expect(await purchaseCount('pi_782_basic')).toBe(1);
    expect(await balance(seller.builderId)).toBe(before + 700);
    expect(await earnings(seller.builderId)).toBe(1);
  });

  it('ignores a PaymentIntent that did not come from our checkout', async () => {
    const event = { type: 'payment_intent.succeeded', created: 1, data: { object: { id: 'pi_782_foreign', metadata: {} } } };
    expect((await postStripeWebhook(event)).status).toBe(200);
    expect(await purchaseCount('pi_782_foreign')).toBe(0);
  });

  it('concurrent client finalize and webhook produce one purchase, one credit, one stock decrement', async () => {
    const { seller, buyer } = await seed('pi-race', { stock: 5 });
    const event = succeededEvent('pi-race', seller, buyer, 'pi_782_race');
    const before = await balance(seller.builderId);

    const results = await Promise.allSettled([
      finalizeSucceededPaymentIntent(env, event.data.object),
      postStripeWebhook(event),
      finalizeSucceededPaymentIntent(env, event.data.object),
    ]);
    results.forEach((r) => expect(r.status).toBe('fulfilled'));

    expect(await purchaseCount('pi_782_race')).toBe(1);
    expect(await earnings(seller.builderId)).toBe(1);
    expect(await balance(seller.builderId)).toBe(before + 700);
    const tpl = await env.DB.prepare('SELECT stock_quantity FROM catalog_templates WHERE template_id = ?')
      .bind('pi-race-template').first();
    expect(tpl.stock_quantity).toBe(4);
  });

  it('item no longer available: still records the sale once (the #472 orphan path), replay is a no-op', async () => {
    const { seller, buyer } = await seed('pi-gone');
    const event = succeededEvent('pi-gone', seller, buyer, 'pi_782_gone');
    await env.DB.prepare('DELETE FROM placed_instances WHERE instance_id = ?').bind('pi-gone-instance').run();

    expect((await postStripeWebhook(event)).status).toBe(200);
    expect((await postStripeWebhook(event)).status).toBe(200);
    expect(await purchaseCount('pi_782_gone')).toBe(1);
    expect(await earnings(seller.builderId)).toBe(1);
  });
});
