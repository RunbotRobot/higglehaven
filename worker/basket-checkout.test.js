// #4614 (Basket 4/7): paying a basket. Stripe is mocked (it is never configured in this suite). One PaymentIntent for
// the whole basket, one purchase per line, one Transfer per seller, nothing recorded twice, nothing charged when a line
// cannot be bought, and the whole route off unless BASKET_CHECKOUT_ENABLED is set.
import { applyD1Migrations, env } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { api, signupAdmin, signupSeller, signupBuilder, TEST_SHIPPING_ADDRESS } from './test-helpers.js';
import { finalizeSucceededPaymentIntent } from './lib/purchase-creation.js';

let adminSession;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  adminSession = (await signupAdmin('bkco-admin')).session;
});
afterEach(() => { env.BASKET_CHECKOUT_ENABLED = undefined; });

async function world(tag) {
  const host = await signupBuilder(`bkco-host-${tag}`);
  const buyer = await signupBuilder(`bkco-buyer-${tag}`);
  const sellers = [await signupSeller(`bkco-s1-${tag}`), await signupSeller(`bkco-s2-${tag}`)];
  const landletId = `bkco-lot-${tag}`;
  await api('/landlets', adminSession({ method: 'POST', body: JSON.stringify({ landletId, name: landletId, areaM2: 1000, status: 'greenbelt' }) }));
  await api(`/landlets/${landletId}/claim`, host.session({ method: 'POST' }));
  const instances = [];
  for (const [i, seller] of sellers.entries()) {
    const templateId = `bkco-t${i}-${tag}`;
    const made = await api('/catalog', seller.session({ method: 'POST', body: JSON.stringify({
      templateId, name: `Thing ${i} ${tag}`, color: '#123456', dimensions: { width: 1, depth: 1, height: 1 }, priceCents: i ? 2500 : 1000, sellerId: seller.sellerId,
    }) }));
    expect(made.response.status).toBe(201);
    await env.DB.prepare("UPDATE sellers SET stripe_account_id = ?, stripe_onboarding_status = 'complete', stripe_updated_at = ? WHERE seller_id = ?")
      .bind(`acct_${i}_${tag}`, new Date().toISOString(), seller.sellerId).run();
    const instanceId = `bkco-i${i}-${tag}`;
    expect((await api('/instances', host.session({ method: 'POST', body: JSON.stringify({ instanceId, landletId, templateId, x: i, y: 0 }) }))).response.status).toBe(201);
    instances.push(instanceId);
    expect((await api('/basket', buyer.session({ method: 'POST', body: JSON.stringify({ instanceId }) }))).response.status).toBe(201);
  }
  return { buyer, sellers, instances };
}

function mockStripe() {
  const calls = [];
  const originalFetch = globalThis.fetch;
  env.STRIPE_SECRET_KEY = 'test-stripe-key';
  globalThis.fetch = async (input, init) => {
    const url = String(typeof input === 'string' ? input : input.url);
    if (!url.includes('stripe.com')) return originalFetch(input, init);
    const path = url.split('/v1/')[1];
    calls.push({ path, body: new URLSearchParams(String(init?.body || '')) });
    const body = path === 'payment_intents' ? { id: `pi_bk_${crypto.randomUUID()}`, client_secret: 'cs_bk' } : { id: `tr_${calls.length}` };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, restore() { globalThis.fetch = originalFetch; env.STRIPE_SECRET_KEY = undefined; } };
}

const checkout = (who, body = { shippingAddress: TEST_SHIPPING_ADDRESS }) =>
  api('/basket/checkout', who.session({ method: 'POST', body: JSON.stringify(body) }));

describe('paying a basket (#4614)', () => {
  it('is off unless the flag is set', async () => {
    const { buyer } = await world('off');
    expect((await checkout(buyer)).response.status).toBe(404);
  });

  it('starts one payment for the whole basket and writes nothing it was not paid for', async () => {
    env.BASKET_CHECKOUT_ENABLED = 'true';
    const { buyer } = await world('start');
    const stripe = mockStripe();
    try {
      const started = await checkout(buyer);
      expect(started.response.status, JSON.stringify(started.body)).toBe(200);
      expect(started.body.totalCents).toBe(3500);
      const created = stripe.calls.filter((c) => c.path === 'payment_intents');
      expect(created).toHaveLength(1);
      expect(created[0].body.get('amount')).toBe('3500');
      expect(created[0].body.get('transfer_data[destination]')).toBeNull(); // no single destination: it pays two sellers
      expect(created[0].body.get('metadata[basketOrderId]')).toBe(started.body.basketOrderId);
      const order = await env.DB.prepare('SELECT * FROM basket_orders WHERE basket_order_id = ?').bind(started.body.basketOrderId).first();
      expect(order).toMatchObject({ status: 'pending', total_cents: 3500 });
      expect(order.payment_intent_id).toBe(started.body.paymentIntentId);
      expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM purchases WHERE basket_order_id = ?').bind(order.basket_order_id).first()).n).toBe(0);
    } finally { stripe.restore(); }
  });

  it('charges nothing and says why when a line cannot be bought', async () => {
    env.BASKET_CHECKOUT_ENABLED = 'true';
    const { buyer } = await world('refuse');
    await env.DB.prepare("UPDATE catalog_templates SET stock_quantity = 0 WHERE template_id = 'bkco-t1-refuse'").run();
    const stripe = mockStripe();
    try {
      const refused = await checkout(buyer);
      expect(refused.response.status).toBe(409);
      expect(refused.body.lines.map((l) => l.status)).toEqual(['ok', 'sold_out']);
      expect(stripe.calls).toHaveLength(0);
    } finally { stripe.restore(); }
  });

  it('records every line and one transfer per seller, once, however often finalize runs', async () => {
    env.BASKET_CHECKOUT_ENABLED = 'true';
    const { buyer, sellers } = await world('final');
    const stripe = mockStripe();
    try {
      const started = await checkout(buyer);
      expect(started.response.status, JSON.stringify(started.body)).toBe(200);
      const pi = { id: started.body.paymentIntentId, status: 'succeeded', amount: 3500, latest_charge: 'ch_bk', metadata: {
        basketOrderId: started.body.basketOrderId, shippingAddress: JSON.stringify(TEST_SHIPPING_ADDRESS) } };
      const first = await finalizeSucceededPaymentIntent(env, pi);
      expect(first.status).toBe(200);
      await finalizeSucceededPaymentIntent(env, pi); // the webhook arriving after the buyer's own call
      const { results: rows } = await env.DB.prepare('SELECT * FROM purchases WHERE basket_order_id = ? ORDER BY basket_line_no').bind(started.body.basketOrderId).all();
      expect(rows.map((r) => r.basket_line_no)).toEqual([1, 2]);
      expect(rows.every((r) => r.payment_intent_id === started.body.paymentIntentId && r.stripe_transfer_id && r.shipping_address_json)).toBe(true);
      const transfers = stripe.calls.filter((c) => c.path === 'transfers');
      expect(transfers).toHaveLength(2);
      for (const row of rows) {
        const t = transfers.find((c) => c.body.get('metadata[sellerId]') === row.seller_id);
        expect(t.body.get('amount')).toBe(String(row.total_cents - row.commission_cents));
        expect(t.body.get('source_transaction')).toBe('ch_bk');
      }
      expect(new Set(rows.map((r) => r.seller_id))).toEqual(new Set(sellers.map((s) => s.sellerId)));
      expect((await env.DB.prepare('SELECT status FROM basket_orders WHERE basket_order_id = ?').bind(started.body.basketOrderId).first()).status).toBe('paid');
      expect((await api('/basket', buyer.session())).body.lines).toHaveLength(0);
    } finally { stripe.restore(); }
  });

  it('refuses a payment whose amount is not the order total', async () => {
    env.BASKET_CHECKOUT_ENABLED = 'true';
    const { buyer } = await world('amount');
    const stripe = mockStripe();
    try {
      const started = await checkout(buyer);
      expect(started.response.status, JSON.stringify(started.body)).toBe(200);
      await expect(finalizeSucceededPaymentIntent(env, { id: started.body.paymentIntentId, status: 'succeeded', amount: 100, metadata: { basketOrderId: started.body.basketOrderId } })).rejects.toThrow();
      expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM purchases WHERE basket_order_id = ?').bind(started.body.basketOrderId).first()).n).toBe(0);
    } finally { stripe.restore(); }
  });
});
