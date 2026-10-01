// Seller feedback (issue #1096, owner decision via Control Room,
// 2026-10-01) — distinct from product_reviews (see reviews-auth.test.js):
// this rates a specific seller's own service for one specific purchase
// from them, not the product itself. #1123: eligibility now mirrors
// handleProductReviews' own post-#1113 shape — a real session +
// purchases.buyer_builder_id match, not a client-supplied authorLabel
// matched against free-text buyer_label.
import {
  applyD1Migrations, env,
} from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from './index.js';
import {
  api, signupBuilder, signupSeller,
} from './test-helpers.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

// instance_id/template_id have no FK constraints (migrations/0051's own
// "permanent receipt, not tied to a live reference" design), so this can
// insert directly without a real catalog template or placed instance —
// only builder_id needs a real row to satisfy its FK. sellerId defaults to
// a fabricated id (no real `sellers` row) since most of these tests only
// care about the purchase-gating logic, not seller-side effects — the one
// test that does (notifications) passes a real seller id explicitly.
// `buyer` is a signupBuilder() account (or omitted, for a legacy/pre-#1123
// purchase with no buyer identity at all), mirroring reviews-auth.test.js's
// own createPurchase shape.
async function createPurchase(buyer, { sellerId = 'seller-no-real-row', refunded = false } = {}) {
  // #1187: label is now unique case-insensitively, and most tests below
  // call this with the same default sellerId — a random suffix keeps each
  // throwaway host builder's own label from colliding with an earlier
  // call's, the same way its builder_id already does via
  // crypto.randomUUID() below.
  const host = (await api('/builders', { method: 'POST', body: JSON.stringify({ label: `Host for ${sellerId} ${crypto.randomUUID()}` }) })).body.builder;
  const purchaseId = `purchase-${crypto.randomUUID()}`;
  await env.DB.prepare(`
    INSERT INTO purchases
      (purchase_id, instance_id, template_id, builder_id, seller_id, buyer_label, buyer_builder_id,
       unit_price_cents, quantity, total_cents, commission_cents, builder_share_cents, platform_share_cents, refunded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 500, 1, 500, 10, 5, 5, ?)
  `).bind(purchaseId, `instance-${crypto.randomUUID()}`, `template-${crypto.randomUUID()}`, host.builderId, sellerId,
    buyer ? buyer.builder.label : null, buyer ? buyer.builderId : null,
    refunded ? new Date().toISOString() : null).run();
  return purchaseId;
}

describe('Seller feedback', () => {
  it('rejects feedback on a purchase that does not exist', async () => {
    const buyer = await signupBuilder('feedback-404-buyer');
    const rejected = await api('/purchases/purchase-does-not-exist/feedback', buyer.session({
      method: 'POST',
      body: JSON.stringify({ rating: 5 }),
    }));
    expect(rejected.response.status).toBe(404);
  });

  it('rejects feedback on a purchase with no seller', async () => {
    const buyer = await signupBuilder('feedback-no-seller-buyer');
    const purchaseId = await createPurchase(buyer, { sellerId: null });
    const rejected = await api(`/purchases/${purchaseId}/feedback`, buyer.session({
      method: 'POST',
      body: JSON.stringify({ rating: 5 }),
    }));
    expect(rejected.response.status).toBe(400);
    expect(rejected.body.error).toContain('no seller');
  });

  it('rejects an unauthenticated feedback attempt on a real purchase', async () => {
    const buyer = await signupBuilder('feedback-requires-session-buyer');
    const purchaseId = await createPurchase(buyer);
    const rejected = await api(`/purchases/${purchaseId}/feedback`, {
      method: 'POST',
      body: JSON.stringify({ rating: 5 }),
    });
    expect(rejected.response.status).toBe(401);
  });

  // #1123: the core spoofing gap this issue closes — a different builder's
  // session (not the purchase's own buyer_builder_id) must not be able to
  // leave feedback on someone else's purchase, however it was shaped
  // client-side (an old-API-style authorLabel field is now simply ignored).
  it('rejects feedback from a builder who is not the purchase\'s own buyer, even naming the real buyer\'s label', async () => {
    const buyer = await signupBuilder('feedback-gate-real-buyer');
    const stranger = await signupBuilder('feedback-gate-stranger');
    const purchaseId = await createPurchase(buyer);
    const rejected = await api(`/purchases/${purchaseId}/feedback`, stranger.session({
      method: 'POST',
      body: JSON.stringify({ authorLabel: buyer.builder.label, rating: 5 }),
    }));
    expect(rejected.response.status).toBe(400);
  });

  // A purchase with no buyer_builder_id (legacy/pre-#1123 row, or a
  // genuinely anonymous one) has no real buyer identity to match a session
  // against — it can never back feedback.
  it('rejects feedback backed only by a purchase with no buyer_builder_id', async () => {
    const purchaseId = await createPurchase(null);
    const shopper = await signupBuilder('feedback-no-buyer-id-shopper');
    const rejected = await api(`/purchases/${purchaseId}/feedback`, shopper.session({
      method: 'POST',
      body: JSON.stringify({ rating: 5 }),
    }));
    expect(rejected.response.status).toBe(400);
  });

  // Same #357 reasoning as product reviews: a shopper made whole by a
  // refund has no standing to also rate that transaction's service.
  it('rejects feedback on a refunded purchase', async () => {
    const buyer = await signupBuilder('feedback-refunded-buyer');
    const purchaseId = await createPurchase(buyer, { refunded: true });
    const rejected = await api(`/purchases/${purchaseId}/feedback`, buyer.session({
      method: 'POST',
      body: JSON.stringify({ rating: 5 }),
    }));
    expect(rejected.response.status).toBe(400);
  });

  it('accepts feedback from the real buyer of the purchase, deriving authorLabel from the session', async () => {
    const buyer = await signupBuilder('feedback-accept-buyer');
    const purchaseId = await createPurchase(buyer);
    const accepted = await api(`/purchases/${purchaseId}/feedback`, buyer.session({
      method: 'POST',
      body: JSON.stringify({ rating: 4, text: 'Great communication!' }),
    }));
    expect(accepted.response.status).toBe(201);
    expect(accepted.body.feedback.purchaseId).toBe(purchaseId);
    expect(accepted.body.feedback.rating).toBe(4);
    expect(accepted.body.feedback.text).toBe('Great communication!');
    // authorLabel is derived server-side from the session, never accepted
    // from the request body.
    expect(accepted.body.feedback.authorLabel).toBe(buyer.builder.label);
  });

  it('rejects a missing or out-of-range rating', async () => {
    const buyer = await signupBuilder('feedback-bad-rating-buyer');
    const purchaseId = await createPurchase(buyer);
    const missing = await api(`/purchases/${purchaseId}/feedback`, buyer.session({
      method: 'POST',
      body: JSON.stringify({}),
    }));
    expect(missing.response.status).toBe(400);

    for (const badRating of [0, 6, 3.5, 'five']) {
      const otherPurchase = await createPurchase(buyer);
      const rejected = await api(`/purchases/${otherPurchase}/feedback`, buyer.session({
        method: 'POST',
        body: JSON.stringify({ rating: badRating }),
      }));
      expect(rejected.response.status).toBe(400);
    }
  });

  it('rejects text over the 280 character cap', async () => {
    const buyer = await signupBuilder('feedback-too-long-buyer');
    const purchaseId = await createPurchase(buyer);
    const rejected = await api(`/purchases/${purchaseId}/feedback`, buyer.session({
      method: 'POST',
      body: JSON.stringify({ rating: 5, text: 'x'.repeat(281) }),
    }));
    expect(rejected.response.status).toBe(400);
  });

  it('rejects a second feedback for the same purchase — one feedback per purchase', async () => {
    const buyer = await signupBuilder('feedback-one-per-purchase-buyer');
    const purchaseId = await createPurchase(buyer);
    const first = await api(`/purchases/${purchaseId}/feedback`, buyer.session({
      method: 'POST',
      body: JSON.stringify({ rating: 5 }),
    }));
    expect(first.response.status).toBe(201);

    const second = await api(`/purchases/${purchaseId}/feedback`, buyer.session({
      method: 'POST',
      body: JSON.stringify({ rating: 1 }),
    }));
    expect(second.response.status).toBe(409);
  });

  // A separate SELECT-then-INSERT for the one-per-purchase check would be a
  // check-then-act race — see handleSellerFeedbackCreate's own comment and
  // reviews-auth.test.js's identically-shaped regression test for the
  // product-review case this mirrors.
  it('rejects a concurrent burst for the same purchase to exactly one feedback — regression test for a check-then-act race', async () => {
    const buyer = await signupBuilder('feedback-burst-race-buyer');
    const purchaseId = await createPurchase(buyer);
    const attempts = await Promise.all(
      Array.from({ length: 10 }, () => api(`/purchases/${purchaseId}/feedback`, buyer.session({
        method: 'POST',
        body: JSON.stringify({ rating: 5 }),
      }))),
    );
    const created = attempts.filter((a) => a.response.status === 201);
    const conflicted = attempts.filter((a) => a.response.status === 409);
    expect(created).toHaveLength(1);
    expect(conflicted).toHaveLength(9);
  });

  it('lists feedback for a seller with an average and count, scoped to that seller only', async () => {
    const sellerId = `seller-list-${crypto.randomUUID()}`;
    const otherSellerId = `seller-list-other-${crypto.randomUUID()}`;

    const emptyList = await api(`/sellers/${sellerId}/feedback`);
    expect(emptyList.response.status).toBe(200);
    expect(emptyList.body.feedback).toEqual([]);
    expect(emptyList.body.averageRating).toBeNull();
    expect(emptyList.body.count).toBe(0);

    const shopperA = await signupBuilder('feedback-list-shopper-a');
    const shopperB = await signupBuilder('feedback-list-shopper-b');
    const shopperC = await signupBuilder('feedback-list-shopper-c');
    const purchaseA = await createPurchase(shopperA, { sellerId });
    const purchaseB = await createPurchase(shopperB, { sellerId });
    const otherPurchase = await createPurchase(shopperC, { sellerId: otherSellerId });

    await api(`/purchases/${purchaseA}/feedback`, shopperA.session({ method: 'POST', body: JSON.stringify({ rating: 5 }) }));
    await api(`/purchases/${purchaseB}/feedback`, shopperB.session({ method: 'POST', body: JSON.stringify({ rating: 3 }) }));
    await api(`/purchases/${otherPurchase}/feedback`, shopperC.session({ method: 'POST', body: JSON.stringify({ rating: 1 }) }));

    const listed = await api(`/sellers/${sellerId}/feedback`);
    expect(listed.response.status).toBe(200);
    expect(listed.body.feedback).toHaveLength(2);
    expect(listed.body.count).toBe(2);
    expect(listed.body.averageRating).toBe(4);
    expect(listed.body.feedback.every((f) => f.sellerId === sellerId)).toBe(true);
  });

  it('notifies the seller (via their builder profile) when new feedback is posted', async () => {
    const seller = await signupSeller('feedback-notify-seller');
    const sellerBuilderId = (await api('/builders/me', seller.session())).body.builder.builderId;
    const shopper = await signupBuilder('feedback-notify-shopper');
    const purchaseId = await createPurchase(shopper, { sellerId: seller.sellerId });

    const posted = await api(`/purchases/${purchaseId}/feedback`, shopper.session({
      method: 'POST',
      body: JSON.stringify({ rating: 4 }),
    }));
    expect(posted.response.status).toBe(201);

    const { results } = await env.DB.prepare(
      'SELECT message FROM notifications WHERE builder_id = ?',
    ).bind(sellerBuilderId).all();
    expect(results).toHaveLength(1);
    expect(results[0].message).toContain(shopper.builder.label);
  });

  // A dangling seller_id (pointing at a seller row that's since been
  // deleted) has nobody to notify — must not throw trying to resolve a
  // notification target, same shape as reviews' own "seller-less template"
  // test.
  it('does not error posting feedback for a dangling seller_id — nobody to notify', async () => {
    const buyer = await signupBuilder('feedback-dangling-seller-buyer');
    const purchaseId = await createPurchase(buyer, { sellerId: `seller-dangling-${crypto.randomUUID()}` });
    const posted = await api(`/purchases/${purchaseId}/feedback`, buyer.session({
      method: 'POST',
      body: JSON.stringify({ rating: 5 }),
    }));
    expect(posted.response.status).toBe(201);
  });

  // #804/#1113's own precedent for product reviews: creation had no rate
  // limit at all before being keyed by builder_id. Mirrored here since
  // #1123 moved this endpoint to the same session-based shape.
  it('rate-limits repeated feedback creations from the same builder', async () => {
    const buyer = await signupBuilder('feedback-create-rate-limit-buyer');
    for (let i = 0; i < 20; i++) {
      const purchaseId = await createPurchase(buyer);
      const attempt = await api(`/purchases/${purchaseId}/feedback`, buyer.session({
        method: 'POST',
        body: JSON.stringify({ rating: 5 }),
      }));
      expect(attempt.response.status).not.toBe(429);
    }
    const finalPurchase = await createPurchase(buyer);
    const limited = await api(`/purchases/${finalPurchase}/feedback`, buyer.session({
      method: 'POST',
      body: JSON.stringify({ rating: 5 }),
    }));
    expect(limited.response.status).toBe(429);
  });
});
