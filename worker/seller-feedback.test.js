// Seller feedback (issue #1096, owner decision via Control Room,
// 2026-10-01) — distinct from product_reviews (see reviews-auth.test.js):
// this rates a specific seller's own service for one specific purchase
// from them, not the product itself. Mirrors reviews-auth.test.js's own
// purchase-gating test shape closely, since worker/index.js's
// handleSellerFeedbackCreate mirrors handleProductReviews' own purchase
// eligibility check.
import {
  applyD1Migrations, env,
} from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from './index.js';
import {
  api, signupSeller,
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
async function createPurchase(buyerLabel, { sellerId = 'seller-no-real-row', refunded = false } = {}) {
  const builder = (await api('/builders', { method: 'POST', body: JSON.stringify({ label: `Purchaser for ${sellerId}` }) })).body.builder;
  const purchaseId = `purchase-${crypto.randomUUID()}`;
  await env.DB.prepare(`
    INSERT INTO purchases
      (purchase_id, instance_id, template_id, builder_id, seller_id, buyer_label,
       unit_price_cents, quantity, total_cents, commission_cents, builder_share_cents, platform_share_cents, refunded_at)
    VALUES (?, ?, ?, ?, ?, ?, 500, 1, 500, 10, 5, 5, ?)
  `).bind(purchaseId, `instance-${crypto.randomUUID()}`, `template-${crypto.randomUUID()}`, builder.builderId, sellerId, buyerLabel,
    refunded ? new Date().toISOString() : null).run();
  return purchaseId;
}

describe('Seller feedback', () => {
  it('rejects feedback on a purchase that does not exist', async () => {
    const rejected = await api('/purchases/purchase-does-not-exist/feedback', {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'A Shopper', rating: 5 }),
    });
    expect(rejected.response.status).toBe(404);
  });

  it('rejects feedback on a purchase with no seller', async () => {
    const purchaseId = await createPurchase('A Shopper', { sellerId: null });
    const rejected = await api(`/purchases/${purchaseId}/feedback`, {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'A Shopper', rating: 5 }),
    });
    expect(rejected.response.status).toBe(400);
    expect(rejected.body.error).toContain('no seller');
  });

  it('rejects feedback whose authorLabel does not match the purchase\'s buyer_label', async () => {
    const purchaseId = await createPurchase('A Shopper');
    const rejected = await api(`/purchases/${purchaseId}/feedback`, {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'Someone Else', rating: 5 }),
    });
    expect(rejected.response.status).toBe(400);
  });

  it('rejects feedback on an anonymous (null buyer_label) purchase', async () => {
    const purchaseId = await createPurchase(null);
    const rejected = await api(`/purchases/${purchaseId}/feedback`, {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'Someone', rating: 5 }),
    });
    expect(rejected.response.status).toBe(400);
  });

  // Same #357 reasoning as product reviews: a shopper made whole by a
  // refund has no standing to also rate that transaction's service.
  it('rejects feedback on a refunded purchase', async () => {
    const purchaseId = await createPurchase('Refunded Shopper', { refunded: true });
    const rejected = await api(`/purchases/${purchaseId}/feedback`, {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'Refunded Shopper', rating: 5 }),
    });
    expect(rejected.response.status).toBe(400);
  });

  it('accepts feedback whose authorLabel matches the purchase\'s buyer_label, case-insensitively', async () => {
    const purchaseId = await createPurchase('A Shopper');
    const accepted = await api(`/purchases/${purchaseId}/feedback`, {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'a shopper', rating: 4, text: 'Great communication!' }),
    });
    expect(accepted.response.status).toBe(201);
    expect(accepted.body.feedback.purchaseId).toBe(purchaseId);
    expect(accepted.body.feedback.rating).toBe(4);
    expect(accepted.body.feedback.text).toBe('Great communication!');
  });

  it('rejects a missing or out-of-range rating', async () => {
    const purchaseId = await createPurchase('A Shopper');
    const missing = await api(`/purchases/${purchaseId}/feedback`, {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'A Shopper' }),
    });
    expect(missing.response.status).toBe(400);

    for (const badRating of [0, 6, 3.5, 'five']) {
      const purchase = await createPurchase('A Shopper');
      const rejected = await api(`/purchases/${purchase}/feedback`, {
        method: 'POST',
        body: JSON.stringify({ authorLabel: 'A Shopper', rating: badRating }),
      });
      expect(rejected.response.status).toBe(400);
    }
  });

  it('rejects text over the 280 character cap', async () => {
    const purchaseId = await createPurchase('A Shopper');
    const rejected = await api(`/purchases/${purchaseId}/feedback`, {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'A Shopper', rating: 5, text: 'x'.repeat(281) }),
    });
    expect(rejected.response.status).toBe(400);
  });

  it('rejects a second feedback for the same purchase — one feedback per purchase', async () => {
    const purchaseId = await createPurchase('A Shopper');
    const first = await api(`/purchases/${purchaseId}/feedback`, {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'A Shopper', rating: 5 }),
    });
    expect(first.response.status).toBe(201);

    const second = await api(`/purchases/${purchaseId}/feedback`, {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'A Shopper', rating: 1 }),
    });
    expect(second.response.status).toBe(409);
  });

  // A separate SELECT-then-INSERT for the one-per-purchase check would be a
  // check-then-act race — see handleSellerFeedbackCreate's own comment and
  // reviews-auth.test.js's identically-shaped regression test for the
  // product-review case this mirrors.
  it('rejects a concurrent burst for the same purchase to exactly one feedback — regression test for a check-then-act race', async () => {
    const purchaseId = await createPurchase('A Shopper');
    const attempts = await Promise.all(
      Array.from({ length: 10 }, () => api(`/purchases/${purchaseId}/feedback`, {
        method: 'POST',
        body: JSON.stringify({ authorLabel: 'A Shopper', rating: 5 }),
      })),
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

    const purchaseA = await createPurchase('Shopper A', { sellerId });
    const purchaseB = await createPurchase('Shopper B', { sellerId });
    const otherPurchase = await createPurchase('Shopper C', { sellerId: otherSellerId });

    await api(`/purchases/${purchaseA}/feedback`, { method: 'POST', body: JSON.stringify({ authorLabel: 'Shopper A', rating: 5 }) });
    await api(`/purchases/${purchaseB}/feedback`, { method: 'POST', body: JSON.stringify({ authorLabel: 'Shopper B', rating: 3 }) });
    await api(`/purchases/${otherPurchase}/feedback`, { method: 'POST', body: JSON.stringify({ authorLabel: 'Shopper C', rating: 1 }) });

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
    const purchaseId = await createPurchase('A Notifying Shopper', { sellerId: seller.sellerId });

    const posted = await api(`/purchases/${purchaseId}/feedback`, {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'A Notifying Shopper', rating: 4 }),
    });
    expect(posted.response.status).toBe(201);

    const { results } = await env.DB.prepare(
      'SELECT message FROM notifications WHERE builder_id = ?',
    ).bind(sellerBuilderId).all();
    expect(results).toHaveLength(1);
    expect(results[0].message).toContain('A Notifying Shopper');
  });

  // A dangling seller_id (pointing at a seller row that's since been
  // deleted) has nobody to notify — must not throw trying to resolve a
  // notification target, same shape as reviews' own "seller-less template"
  // test.
  it('does not error posting feedback for a dangling seller_id — nobody to notify', async () => {
    const purchaseId = await createPurchase('A Shopper', { sellerId: `seller-dangling-${crypto.randomUUID()}` });
    const posted = await api(`/purchases/${purchaseId}/feedback`, {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'A Shopper', rating: 5 }),
    });
    expect(posted.response.status).toBe(201);
  });
});
