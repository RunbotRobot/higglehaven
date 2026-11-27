import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, signupBuilder, signupSeller } from './test-helpers.js';

// #4573 (the buying walk): a card order's refund sends 99% of the total (#651), but the buyer's notice named the full
// price, so "$24.00 is on its way back" was 24 cents more than arrived. An order with no card payment has nothing
// sent and still names its total. Stripe is mocked: it is never configured in this suite.
beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

async function refundOrder(label, { card }) {
  const seller = await signupSeller(`${label}-seller`);
  const host = await signupBuilder(`${label}-host`);
  const buyer = await signupBuilder(`${label}-buyer`);
  await api('/catalog', seller.session({
    method: 'POST',
    body: JSON.stringify({ templateId: `${label}-t`, name: `Product ${label}`, color: '#123456', dimensions: { width: 1, depth: 1, height: 1 }, priceCents: 2400, sellerId: seller.sellerId }),
  }));
  await env.DB.prepare(`
    INSERT INTO purchases (purchase_id, instance_id, template_id, seller_id, builder_id, buyer_builder_id, unit_price_cents, quantity,
      total_cents, commission_cents, builder_share_cents, platform_share_cents, payment_intent_id)
    VALUES (?, 'i', ?, ?, ?, ?, 2400, 1, 2400, 48, 24, 24, ?)
  `).bind(`${label}-p`, `${label}-t`, seller.sellerId, host.builderId, buyer.builderId, card ? `pi_${label}` : null).run();
  const originalFetch = globalThis.fetch;
  env.STRIPE_SECRET_KEY = 'test-stripe-key';
  globalThis.fetch = async (input, init) => {
    if (String(typeof input === 'string' ? input : input.url).includes('stripe.com')) {
      return new Response(JSON.stringify({ id: 're_test' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return originalFetch(input, init);
  };
  try {
    const done = await api(`/purchases/${label}-p/refund`, seller.session({ method: 'POST' }));
    expect(done.response.status).toBe(200);
  } finally {
    globalThis.fetch = originalFetch;
    env.STRIPE_SECRET_KEY = undefined;
  }
  return env.DB.prepare("SELECT message FROM notifications WHERE builder_id = ? AND message LIKE '%was refunded%'").bind(buyer.builderId).first();
}

describe("the buyer's refund notice names what is sent (#4573)", () => {
  it('names 99% of a card order, the amount Stripe is asked to send', async () => {
    const note = await refundOrder('bn-card', { card: true });
    expect(note.message).toContain('$23.76');
    expect(note.message).not.toContain('$24.00');
  });

  it('names the total of an order with no card payment', async () => {
    const note = await refundOrder('bn-nocard', { card: false });
    expect(note.message).toContain('$24.00');
  });
});
