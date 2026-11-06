// #3196 (2/5 of #2115, "My Purchases"): GET /api/purchases/mine, a buyer's own
// purchase list keyed on the account (purchases.buyer_user_id, #3195). Rows are
// inserted directly (purchases are permanent receipts with no FK to a live
// instance, migrations/0051), so these tests need no placed instance; the
// cross-checks at the end drive the real feedback and dispute endpoints so the
// list's booleans cannot drift from what those endpoints actually allow.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, signupBuilder, signupSeller } from './test-helpers.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

async function createTemplate(templateId, name) {
  const created = await api('/catalog', {
    method: 'POST',
    body: JSON.stringify({
      templateId, name, color: '#123456', dimensions: { width: 1, depth: 1, height: 1 }, priceCents: 500,
    }),
  });
  expect(created.response.status).toBe(201);
  return templateId;
}

async function hostBuilderId() {
  const host = await api('/builders', { method: 'POST', body: JSON.stringify({ label: `Host ${crypto.randomUUID()}` }) });
  return host.body.builder.builderId;
}

// buyer: a signupBuilder() account. createdAt makes ordering explicit.
async function addPurchase(buyer, {
  templateId = `template-${crypto.randomUUID()}`, sellerId = null, createdAt = new Date().toISOString(),
  refundedAt = null, paidOutAt = null, totalCents = 500, quantity = 1, digital = 0, linkBuilder = true,
} = {}) {
  const purchaseId = `purchase-${crypto.randomUUID()}`;
  const userId = (await env.DB.prepare('SELECT user_id FROM builders WHERE builder_id = ?').bind(buyer.builderId).first()).user_id;
  await env.DB.prepare(`
    INSERT INTO purchases
      (purchase_id, instance_id, template_id, builder_id, seller_id, buyer_label, buyer_builder_id, buyer_user_id,
       unit_price_cents, quantity, total_cents, commission_cents, builder_share_cents, platform_share_cents,
       is_digital_good, created_at, refunded_at, paid_out_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 10, 5, 5, ?, ?, ?, ?)
  `).bind(purchaseId, `instance-${crypto.randomUUID()}`, templateId, await hostBuilderId(), sellerId, buyer.builder.label,
    linkBuilder ? buyer.builderId : null, userId, totalCents, quantity, totalCents, digital, createdAt, refundedAt, paidOutAt).run();
  return purchaseId;
}

const mine = (who, query = '') => api(`/purchases/mine${query}`, who.session());

describe('GET /api/purchases/mine (#3196)', () => {
  it('requires a session', async () => {
    expect((await api('/purchases/mine')).response.status).toBe(401);
  });

  it('returns an empty list for an account with no purchases', async () => {
    const buyer = await signupBuilder('mine-empty');
    const res = await mine(buyer);
    expect(res.response.status).toBe(200);
    expect(res.body).toEqual({ purchases: [], nextCursor: null });
  });

  it('lists only the caller\'s purchases, newest first, and pages through them with the cursor', async () => {
    const buyer = await signupBuilder('mine-paging');
    const other = await signupBuilder('mine-paging-other');
    const oldest = await addPurchase(buyer, { createdAt: '2026-01-01T00:00:00.000Z' });
    const middle = await addPurchase(buyer, { createdAt: '2026-02-01T00:00:00.000Z' });
    const newest = await addPurchase(buyer, { createdAt: '2026-03-01T00:00:00.000Z' });
    await addPurchase(other, { createdAt: '2026-02-15T00:00:00.000Z' });

    const all = await mine(buyer);
    expect(all.body.purchases.map((p) => p.purchaseId)).toEqual([newest, middle, oldest]);
    expect(all.body.nextCursor).toBeNull();

    const seen = [];
    let cursor = null;
    do {
      const page = await mine(buyer, `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(page.body.purchases.length).toBeLessThanOrEqual(2);
      seen.push(...page.body.purchases.map((p) => p.purchaseId));
      cursor = page.body.nextCursor;
    } while (cursor);
    expect(seen).toEqual([newest, middle, oldest]);

    expect((await mine(buyer, '?limit=0')).response.status).toBe(400);
    expect((await mine(buyer, '?cursor=not-base64')).response.status).toBe(400);
  });

  it('shows the product and seller names, with neutral fallbacks for a removed product or seller, and nothing internal', async () => {
    const buyer = await signupBuilder('mine-names');
    const seller = await signupSeller('mine-names-seller');
    const templateId = await createTemplate('mine-names-template', 'A Lovely Lamp');
    const named = await addPurchase(buyer, { templateId, sellerId: seller.sellerId, quantity: 2, totalCents: 1000, digital: 1 });
    const orphan = await addPurchase(buyer, { createdAt: '2020-01-01T00:00:00.000Z', sellerId: 'seller-long-gone' });

    const res = await mine(buyer);
    const byId = Object.fromEntries(res.body.purchases.map((p) => [p.purchaseId, p]));
    expect(byId[named]).toMatchObject({
      productName: 'A Lovely Lamp', sellerName: seller.seller.label, quantity: 2, totalCents: 1000, isDigitalGood: true,
    });
    expect(byId[orphan]).toMatchObject({ productName: '(removed product)', sellerName: '(former seller)' });

    // The list must not become a way to read anything the buyer did not already see.
    const allowed = [
      'purchaseId', 'createdAt', 'productName', 'sellerName', 'quantity', 'totalCents', 'isDigitalGood', 'shippedAt',
      'refundedAt', 'refundedAmountCents', 'canLeaveFeedback', 'feedback', 'canDispute',
    ].sort();
    for (const purchase of res.body.purchases) expect(Object.keys(purchase).sort()).toEqual(allowed);
    expect(JSON.stringify(res.body)).not.toMatch(/paymentIntent|payment_intent|tokenHash|commission|builderShare|platformShare/i);
  });

  it('still lists a receipt after the buyer\'s builder profile is deleted, but offers no actions on it', async () => {
    const buyer = await signupBuilder('mine-reset');
    const seller = await signupSeller('mine-reset-seller');
    const purchaseId = await addPurchase(buyer, { sellerId: seller.sellerId });
    expect((await mine(buyer)).body.purchases[0]).toMatchObject({ purchaseId, canLeaveFeedback: true, canDispute: true });

    await env.DB.prepare('DELETE FROM builders WHERE builder_id = ?').bind(buyer.builderId).run();
    const after = await mine(buyer);
    expect(after.response.status).toBe(200);
    expect(after.body.purchases[0]).toMatchObject({ purchaseId, canLeaveFeedback: false, canDispute: false });
  });
});

// The booleans must agree with what the real endpoints do. Each scenario uses
// its own buyer (a lone purchase is never an "established" buyer, so a dispute
// on it cannot auto-refund and move money in this test).
describe('GET /api/purchases/mine flags agree with the feedback and dispute endpoints (#3196)', () => {
  const postFeedback = (buyer, purchaseId) => api(`/purchases/${purchaseId}/feedback`, buyer.session({
    method: 'POST', body: JSON.stringify({ rating: 4, text: 'Fine' }),
  }));
  const postDispute = (buyer, purchaseId) => api(`/purchases/${purchaseId}/dispute`, buyer.session({ method: 'POST' }));
  const flags = async (buyer) => {
    const { purchases } = (await mine(buyer)).body;
    return purchases[0];
  };

  it('an open purchase with a seller: feedback and dispute are both allowed, and leaving feedback flips the flag', async () => {
    const buyer = await signupBuilder('mine-flags-open');
    const seller = await signupSeller('mine-flags-open-seller');
    const purchaseId = await addPurchase(buyer, { sellerId: seller.sellerId });
    expect(await flags(buyer)).toMatchObject({ canLeaveFeedback: true, canDispute: true, feedback: null });

    expect((await postDispute(buyer, purchaseId)).response.status).toBe(200);
    expect((await postFeedback(buyer, purchaseId)).response.status).toBe(201);
    expect(await flags(buyer)).toMatchObject({ canLeaveFeedback: false, feedback: { rating: 4, text: 'Fine' } });
    expect((await postFeedback(buyer, purchaseId)).response.status).toBe(409);
  });

  it('a refunded purchase: neither feedback nor dispute', async () => {
    const buyer = await signupBuilder('mine-flags-refunded');
    const seller = await signupSeller('mine-flags-refunded-seller');
    const purchaseId = await addPurchase(buyer, { sellerId: seller.sellerId, refundedAt: new Date().toISOString() });
    expect(await flags(buyer)).toMatchObject({ canLeaveFeedback: false, canDispute: false });
    expect((await postFeedback(buyer, purchaseId)).response.status).toBe(400);
    expect((await postDispute(buyer, purchaseId)).response.status).toBe(409);
  });

  it('a paid-out purchase: feedback allowed, dispute not', async () => {
    const buyer = await signupBuilder('mine-flags-paidout');
    const seller = await signupSeller('mine-flags-paidout-seller');
    const purchaseId = await addPurchase(buyer, { sellerId: seller.sellerId, paidOutAt: new Date().toISOString() });
    expect(await flags(buyer)).toMatchObject({ canLeaveFeedback: true, canDispute: false });
    expect((await postDispute(buyer, purchaseId)).response.status).toBe(409);
    expect((await postFeedback(buyer, purchaseId)).response.status).toBe(201);
  });

  it('a purchase with no seller on record: no feedback, dispute still allowed', async () => {
    const buyer = await signupBuilder('mine-flags-noseller');
    const purchaseId = await addPurchase(buyer, { sellerId: null });
    expect(await flags(buyer)).toMatchObject({ canLeaveFeedback: false, canDispute: true });
    expect((await postFeedback(buyer, purchaseId)).response.status).toBe(400);
    expect((await postDispute(buyer, purchaseId)).response.status).toBe(200);
  });
});
