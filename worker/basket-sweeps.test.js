// #4615 (Basket 5/7): the sweeps that keep a paid basket from being lost. Stripe is mocked. A pending basket whose
// payment succeeded is finished, one nobody paid in a day is cancelled and closed, a seller's share that could not be
// transferred is sent once they can be paid, and none of it runs twice.
import { applyD1Migrations, env } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { api, signupAdmin, signupSeller, signupBuilder, TEST_SHIPPING_ADDRESS } from './test-helpers.js';
import { finalizeSucceededPaymentIntent } from './lib/purchase-creation.js';
import { sweepBaskets, BASKET_HEAL_AFTER_MS, BASKET_CANCEL_AFTER_MS } from './lib/basket-sweeps.js';

let adminSession;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  adminSession = (await signupAdmin('bksw-admin')).session;
});
afterEach(() => { env.BASKET_CHECKOUT_ENABLED = undefined; });

async function world(tag) {
  const host = await signupBuilder(`bksw-host-${tag}`);
  const buyer = await signupBuilder(`bksw-buyer-${tag}`);
  const sellers = [await signupSeller(`bksw-s1-${tag}`), await signupSeller(`bksw-s2-${tag}`)];
  const landletId = `bksw-lot-${tag}`;
  await api('/landlets', adminSession({ method: 'POST', body: JSON.stringify({ landletId, name: landletId, areaM2: 1000, status: 'greenbelt' }) }));
  await api(`/landlets/${landletId}/claim`, host.session({ method: 'POST' }));
  for (const [i, seller] of sellers.entries()) {
    const templateId = `bksw-t${i}-${tag}`;
    expect((await api('/catalog', seller.session({ method: 'POST', body: JSON.stringify({
      templateId, name: `Thing ${i} ${tag}`, color: '#123456', dimensions: { width: 1, depth: 1, height: 1 }, priceCents: i ? 2500 : 1000, sellerId: seller.sellerId,
    }) }))).response.status).toBe(201);
    await env.DB.prepare("UPDATE sellers SET stripe_account_id = ?, stripe_onboarding_status = 'complete', stripe_updated_at = ? WHERE seller_id = ?")
      .bind(`acct_${i}_${tag}`, new Date().toISOString(), seller.sellerId).run();
    const instanceId = `bksw-i${i}-${tag}`;
    expect((await api('/instances', host.session({ method: 'POST', body: JSON.stringify({ instanceId, landletId, templateId, x: i, y: 0 }) }))).response.status).toBe(201);
    expect((await api('/basket', buyer.session({ method: 'POST', body: JSON.stringify({ instanceId }) }))).response.status).toBe(201);
  }
  return { buyer, sellers };
}

// `payments` maps a PaymentIntent id to what Stripe would answer for it.
function mockStripe(payments = new Map()) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  env.STRIPE_SECRET_KEY = 'test-stripe-key';
  globalThis.fetch = async (input, init) => {
    const url = String(typeof input === 'string' ? input : input.url);
    if (!url.includes('stripe.com')) return originalFetch(input, init);
    const path = url.split('/v1/')[1];
    const method = init?.method || 'GET';
    calls.push({ method, path, body: new URLSearchParams(String(init?.body || '')) });
    let body = { id: `tr_${calls.length}` };
    if (path === 'payment_intents') body = { id: `pi_sw_${crypto.randomUUID()}`, client_secret: 'cs_sw' };
    else if (method === 'GET' && path.startsWith('payment_intents/')) body = payments.get(path.split('/')[1]) || { id: path.split('/')[1], status: 'requires_payment_method' };
    else if (path.endsWith('/cancel')) body = { id: path.split('/')[1], status: 'canceled' };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, payments, restore() { globalThis.fetch = originalFetch; env.STRIPE_SECRET_KEY = undefined; } };
}

async function startedOrder(buyer) {
  env.BASKET_CHECKOUT_ENABLED = 'true';
  const started = await api('/basket/checkout', buyer.session({ method: 'POST', body: JSON.stringify({ shippingAddress: TEST_SHIPPING_ADDRESS }) }));
  expect(started.response.status, JSON.stringify(started.body)).toBe(200);
  return started.body;
}
const ageOrder = (basketOrderId, ms) => env.DB.prepare('UPDATE basket_orders SET created_at = ? WHERE basket_order_id = ?')
  .bind(new Date(Date.now() - ms).toISOString(), basketOrderId).run();
const orderStatus = async (id) => (await env.DB.prepare('SELECT status FROM basket_orders WHERE basket_order_id = ?').bind(id).first()).status;
const succeeded = (order) => ({ id: order.paymentIntentId, status: 'succeeded', amount: order.totalCents, latest_charge: 'ch_sw', metadata: {
  basketOrderId: order.basketOrderId, shippingAddress: JSON.stringify(TEST_SHIPPING_ADDRESS) } });

describe('pending baskets (#4615)', () => {
  it('leaves a basket alone until it has been pending a quarter of an hour, and asks Stripe nothing', async () => {
    const { buyer } = await world('young');
    const stripe = mockStripe();
    try {
      const order = await startedOrder(buyer);
      stripe.calls.length = 0;
      await ageOrder(order.basketOrderId, BASKET_HEAL_AFTER_MS - 60 * 1000);
      expect(await sweepBaskets(env)).toMatchObject({ healed: 0, cancelled: 0 });
      expect(stripe.calls).toHaveLength(0);
      expect(await orderStatus(order.basketOrderId)).toBe('pending');
    } finally { stripe.restore(); }
  });

  it('finishes a basket whose payment succeeded but never reached us: every line, every seller, then paid', async () => {
    const { buyer } = await world('heal');
    const stripe = mockStripe();
    try {
      const order = await startedOrder(buyer);
      stripe.payments.set(order.paymentIntentId, succeeded(order));
      await ageOrder(order.basketOrderId, BASKET_HEAL_AFTER_MS + 60 * 1000);
      expect(await sweepBaskets(env)).toMatchObject({ healed: 1 });
      const { results: rows } = await env.DB.prepare('SELECT * FROM purchases WHERE basket_order_id = ? ORDER BY basket_line_no').bind(order.basketOrderId).all();
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.stripe_transfer_id)).toBe(true);
      expect(stripe.calls.filter((c) => c.path === 'transfers')).toHaveLength(2);
      expect(await orderStatus(order.basketOrderId)).toBe('paid');
      // Run again: nothing more is recorded or transferred, and the paid order is not looked at.
      const before = stripe.calls.length;
      expect(await sweepBaskets(env)).toMatchObject({ healed: 0, cancelled: 0, retried: 0 });
      expect(stripe.calls.length).toBe(before);
      expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM purchases WHERE basket_order_id = ?').bind(order.basketOrderId).first()).n).toBe(2);
    } finally { stripe.restore(); }
  });

  it('finishes a succeeded payment even when it is older than a day, and never cancels money that moved', async () => {
    const { buyer } = await world('paidold');
    const stripe = mockStripe();
    try {
      const order = await startedOrder(buyer);
      stripe.payments.set(order.paymentIntentId, succeeded(order));
      await ageOrder(order.basketOrderId, BASKET_CANCEL_AFTER_MS + 60 * 1000);
      expect(await sweepBaskets(env)).toMatchObject({ healed: 1, cancelled: 0 });
      expect(stripe.calls.some((c) => c.path.endsWith('/cancel'))).toBe(false);
      expect(await orderStatus(order.basketOrderId)).toBe('paid');
    } finally { stripe.restore(); }
  });

  it('cancels at Stripe and closes a basket nobody paid in a day, and keeps one that is only a few hours old', async () => {
    const { buyer } = await world('stale');
    const stripe = mockStripe();
    try {
      const order = await startedOrder(buyer);
      await ageOrder(order.basketOrderId, 5 * 60 * 60 * 1000);
      expect(await sweepBaskets(env)).toMatchObject({ cancelled: 0 });
      expect(await orderStatus(order.basketOrderId)).toBe('pending');
      await ageOrder(order.basketOrderId, BASKET_CANCEL_AFTER_MS + 60 * 1000);
      expect(await sweepBaskets(env)).toMatchObject({ cancelled: 1 });
      expect(stripe.calls.filter((c) => c.method === 'POST' && c.path === `payment_intents/${order.paymentIntentId}/cancel`)).toHaveLength(1);
      expect(await orderStatus(order.basketOrderId)).toBe('cancelled');
      expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM purchases WHERE basket_order_id = ?').bind(order.basketOrderId).first()).n).toBe(0);
    } finally { stripe.restore(); }
  });

  it('closes a basket Stripe has already cancelled, and one whose payment was never created', async () => {
    const { buyer } = await world('closed');
    const stripe = mockStripe();
    try {
      const order = await startedOrder(buyer);
      stripe.payments.set(order.paymentIntentId, { id: order.paymentIntentId, status: 'canceled' });
      await ageOrder(order.basketOrderId, BASKET_HEAL_AFTER_MS + 60 * 1000);
      await sweepBaskets(env);
      expect(await orderStatus(order.basketOrderId)).toBe('cancelled');

      await env.DB.prepare(`INSERT INTO basket_orders (basket_order_id, user_id, total_cents, created_at) VALUES ('bko_never', 'nobody', 100, ?)`)
        .bind(new Date(Date.now() - BASKET_CANCEL_AFTER_MS - 60 * 1000).toISOString()).run();
      const before = stripe.calls.length;
      await sweepBaskets(env);
      expect(await orderStatus('bko_never')).toBe('cancelled');
      expect(stripe.calls.length).toBe(before); // nothing to look up or cancel anywhere
    } finally { stripe.restore(); }
  });

  it('leaves a basket pending, and goes on with the rest, when Stripe cannot be reached for it', async () => {
    const { buyer } = await world('error');
    const stripe = mockStripe();
    try {
      const order = await startedOrder(buyer);
      await ageOrder(order.basketOrderId, BASKET_HEAL_AFTER_MS + 60 * 1000);
      const reachable = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        if (String(typeof input === 'string' ? input : input.url).includes('stripe.com')) return new Response('{}', { status: 500 });
        return reachable(input, init);
      };
      expect(await sweepBaskets(env)).toMatchObject({ healed: 0, cancelled: 0 });
      expect(await orderStatus(order.basketOrderId)).toBe('pending');
    } finally { stripe.restore(); }
  });
});

describe('a seller\'s share that could not be transferred (#4615)', () => {
  it('is sent once the seller can be paid, the seller is told once, and it is not sent twice', async () => {
    const { buyer, sellers } = await world('transfer');
    const stripe = mockStripe();
    try {
      const order = await startedOrder(buyer);
      // The second seller loses their payout account between checkout and the payment succeeding.
      await env.DB.prepare('UPDATE sellers SET stripe_account_id = NULL WHERE seller_id = ?').bind(sellers[1].sellerId).run();
      const paymentIntent = succeeded(order);
      stripe.payments.set(order.paymentIntentId, paymentIntent);
      await finalizeSucceededPaymentIntent(env, paymentIntent);
      expect(await orderStatus(order.basketOrderId)).toBe('paid');
      const missing = () => env.DB.prepare('SELECT COUNT(*) AS n FROM purchases WHERE basket_order_id = ? AND stripe_transfer_id IS NULL').bind(order.basketOrderId).first();
      expect((await missing()).n).toBe(1);
      const transfersBefore = stripe.calls.filter((c) => c.path === 'transfers').length;

      // Not yet payable: nothing to retry, nothing sent.
      await env.DB.prepare('UPDATE purchases SET created_at = ? WHERE basket_order_id = ?').bind(new Date(Date.now() - 60 * 60 * 1000).toISOString(), order.basketOrderId).run();
      expect(await sweepBaskets(env)).toMatchObject({ retried: 0 });
      expect(stripe.calls.filter((c) => c.path === 'transfers')).toHaveLength(transfersBefore);

      // The seller finishes setting up.
      await env.DB.prepare('UPDATE sellers SET stripe_account_id = ? WHERE seller_id = ?').bind('acct_late', sellers[1].sellerId).run();
      expect(await sweepBaskets(env)).toMatchObject({ retried: 1 });
      const sent = stripe.calls.filter((c) => c.path === 'transfers');
      expect(sent).toHaveLength(transfersBefore + 1);
      expect(sent.at(-1).body.get('destination')).toBe('acct_late');
      expect(sent.at(-1).body.get('amount')).toBe('2450'); // 2500 less the 2% commission
      expect((await missing()).n).toBe(0);
      const notices = await env.DB.prepare(`
        SELECT n.message FROM notifications n JOIN builders b ON b.builder_id = n.builder_id
        JOIN sellers s ON s.user_id = b.user_id WHERE s.seller_id = ?
      `).bind(sellers[1].sellerId).all();
      expect(notices.results.filter((n) => /has now been sent/.test(n.message))).toHaveLength(1);

      // Again: nothing is missing, so nothing more happens.
      expect(await sweepBaskets(env)).toMatchObject({ retried: 0 });
      expect(stripe.calls.filter((c) => c.path === 'transfers')).toHaveLength(transfersBefore + 1);
    } finally { stripe.restore(); }
  });
});
