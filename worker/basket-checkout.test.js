// #4614 (Basket 4/7): paying a basket. Stripe is mocked (it is never configured in this suite). One PaymentIntent for
// the whole basket, one purchase per line, one Transfer per seller, nothing recorded twice, nothing charged when a line
// cannot be bought, and the whole route off unless BASKET_CHECKOUT_ENABLED is set.
import { applyD1Migrations, env } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { api, signupAdmin, signupSeller, signupBuilder, TEST_SHIPPING_ADDRESS } from './test-helpers.js';
import { finalizeSucceededPaymentIntent } from './lib/purchase-creation.js';
import { SELF } from 'cloudflare:test';

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
  const emails = []; // #4617: what the mail provider was asked to send
  const originalFetch = globalThis.fetch;
  env.STRIPE_SECRET_KEY = 'test-stripe-key';
  env.RESEND_API_KEY = 'test-resend-key';
  globalThis.fetch = async (input, init) => {
    const url = String(typeof input === 'string' ? input : input.url);
    if (url.includes('api.resend.com')) {
      emails.push(JSON.parse(String(init?.body || '{}')));
      return new Response('{}', { status: 200 });
    }
    if (!url.includes('stripe.com')) return originalFetch(input, init);
    const path = url.split('/v1/')[1];
    calls.push({ path, body: new URLSearchParams(String(init?.body || '')) });
    const body = path === 'payment_intents' ? { id: `pi_bk_${crypto.randomUUID()}`, client_secret: 'cs_bk' } : { id: `tr_${calls.length}` };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, emails, restore() { globalThis.fetch = originalFetch; env.STRIPE_SECRET_KEY = undefined; env.RESEND_API_KEY = undefined; } };
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
      // #4617: one receipt for the whole basket, sent once however often finalize runs, naming each seller and the total.
      expect(stripe.emails).toHaveLength(1);
      expect(stripe.emails[0].subject).toBe('Your higglehaven order');
      expect(stripe.emails[0].text).toContain('Total paid: $35.00.');
      expect(stripe.emails[0].text.match(/From /g)).toHaveLength(2);
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

async function paid(tag) {
  env.BASKET_CHECKOUT_ENABLED = 'true';
  const w = await world(tag);
  const stripe = mockStripe();
  const started = await checkout(w.buyer);
  const pi = { id: started.body.paymentIntentId, status: 'succeeded', amount: 3500, latest_charge: 'ch_bk', metadata: {
    basketOrderId: started.body.basketOrderId, shippingAddress: JSON.stringify(TEST_SHIPPING_ADDRESS) } };
  await finalizeSucceededPaymentIntent(env, pi);
  return { ...w, stripe, pi, orderId: started.body.basketOrderId };
}

describe('refunds, disputes and a stopped seller for a basket line (#4616)', () => {
  it('refunds one line against the shared payment and pulls back only that seller part of the Transfer', async () => {
    const w = await paid('refund');
    try {
      const { results: rows } = await env.DB.prepare('SELECT * FROM purchases WHERE basket_order_id = ? ORDER BY basket_line_no').bind(w.orderId).all();
      const done = await api(`/purchases/${rows[0].purchase_id}/refund`, w.sellers[0].session({ method: 'POST' }));
      expect(done.response.status, JSON.stringify(done.body)).toBe(200);
      const refund = w.stripe.calls.filter((c) => c.path === 'refunds');
      expect(refund).toHaveLength(1);
      expect(refund[0].body.get('payment_intent')).toBe(w.pi.id);
      expect(refund[0].body.get('amount')).toBe(String(Math.floor(rows[0].total_cents * 0.99)));
      expect(refund[0].body.get('reverse_transfer')).toBeNull();
      const reversal = w.stripe.calls.find((c) => c.path === `transfers/${rows[0].stripe_transfer_id}/reversals`);
      expect(reversal.body.get('amount')).toBe(String(rows[0].total_cents - rows[0].commission_cents));
      const after = await env.DB.prepare('SELECT purchase_id, refunded_at FROM purchases WHERE basket_order_id = ? ORDER BY basket_line_no').bind(w.orderId).all();
      expect(after.results.map((r) => !!r.refunded_at)).toEqual([true, false]);
    } finally { w.stripe.restore(); }
  });

  it('does not let a refund event for the shared charge touch an arbitrary line', async () => {
    const w = await paid('refundevent');
    try {
      env.STRIPE_WEBHOOK_SECRET = 'test-stripe-webhook-secret';
      const body = JSON.stringify({ id: 'evt_bk', type: 'charge.refunded', created: 1, data: { object: { payment_intent: w.pi.id, refunded: true } } });
      const ts = Math.floor(Date.now() / 1000);
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const sig = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}.${body}`)))].map((b) => b.toString(16).padStart(2, '0')).join('');
      const res = await SELF.fetch('https://higglehaven.test/api/auth/stripe-webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': `t=${ts},v1=${sig}` }, body });
      expect(res.status).toBe(200);
      const { results } = await env.DB.prepare('SELECT refunded_at FROM purchases WHERE basket_order_id = ?').bind(w.orderId).all();
      expect(results.every((r) => r.refunded_at === null)).toBe(true);
    } finally { w.stripe.restore(); env.STRIPE_WEBHOOK_SECRET = undefined; }
  });

  it('applies a dispute on the shared charge to every line of the order', async () => {
    const w = await paid('dispute');
    try {
      env.STRIPE_WEBHOOK_SECRET = 'test-stripe-webhook-secret';
      const body = JSON.stringify({ id: 'evt_bkd', type: 'charge.dispute.funds_withdrawn', created: 5, data: { object: { payment_intent: w.pi.id } } });
      const ts = Math.floor(Date.now() / 1000);
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const sig = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}.${body}`)))].map((b) => b.toString(16).padStart(2, '0')).join('');
      const res = await SELF.fetch('https://higglehaven.test/api/auth/stripe-webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': `t=${ts},v1=${sig}` }, body });
      expect(res.status).toBe(200);
      const { results } = await env.DB.prepare('SELECT refunded_at FROM purchases WHERE basket_order_id = ?').bind(w.orderId).all();
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.refunded_at !== null)).toBe(true);
    } finally { w.stripe.restore(); env.STRIPE_WEBHOOK_SECRET = undefined; }
  });

  it('refunds a line whole, and pays no Transfer, when its seller was stopped before the payment was recorded', async () => {
    env.BASKET_CHECKOUT_ENABLED = 'true';
    const w = await world('stopped');
    const stripe = mockStripe();
    try {
      const started = await checkout(w.buyer);
      const sellerUser = (await env.DB.prepare('SELECT user_id FROM sellers WHERE seller_id = ?').bind(w.sellers[0].sellerId).first()).user_id;
      await env.DB.prepare("INSERT INTO account_suspensions (suspension_id, user_id, admin_user_id, reason, grace_period_ends_at) VALUES ('sus-bk', ?, ?, 'x', '2099-01-01T00:00:00Z')").bind(sellerUser, sellerUser).run();
      await finalizeSucceededPaymentIntent(env, { id: started.body.paymentIntentId, status: 'succeeded', amount: 3500, latest_charge: 'ch_bk', metadata: { basketOrderId: started.body.basketOrderId, shippingAddress: '' } });
      const { results: rows } = await env.DB.prepare('SELECT * FROM purchases WHERE basket_order_id = ? ORDER BY basket_line_no').bind(started.body.basketOrderId).all();
      expect(rows[0].refunded_at).not.toBeNull();
      expect(rows[0].stripe_transfer_id).toBeNull();
      expect(rows[1].stripe_transfer_id).not.toBeNull();
      const refund = stripe.calls.find((c) => c.path === 'refunds');
      expect(refund.body.get('amount')).toBe(String(rows[0].total_cents));
      expect(stripe.calls.filter((c) => c.path === 'transfers')).toHaveLength(1);
    } finally { stripe.restore(); }
  });
});
