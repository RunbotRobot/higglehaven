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
  api, signupBuilder, signupSeller, signupAdmin,
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

  // #1738 (owner confirmed, 2026-10-13): the rated seller can never
  // self-delete feedback about their own conduct, unlike product reviews'
  // own seller-moderation path -- admin-only removal is the sole
  // moderation route for the seller's side. #1975 (same thread): the
  // feedback's own author (the buyer who actually wrote it) is a
  // different person from the rated seller and gets their own
  // author-direct removal instead -- covered by the "Author self-edit/
  // delete (#1975)" describe block below, not here. Covers: 401 with no
  // session, 403 for a non-admin, non-author session (an ordinary
  // stranger and the purchase's own rated seller alike), 404 for a
  // purchase with no feedback, and a real admin delete logged to
  // admin_action_log.
  it('lets only an admin (or the feedback\'s own author) delete seller feedback, never the rated seller themself', async () => {
    const buyer = await signupBuilder('feedback-delete-buyer');
    const seller = await signupSeller('feedback-delete-seller');
    const stranger = await signupBuilder('feedback-delete-stranger');
    const purchaseId = await createPurchase(buyer, { sellerId: seller.sellerId });
    const posted = await api(`/purchases/${purchaseId}/feedback`, buyer.session({
      method: 'POST',
      body: JSON.stringify({ rating: 1, text: 'Abusive/policy-violating text goes here.' }),
    }));
    expect(posted.response.status).toBe(201);

    const unauthenticated = await api(`/purchases/${purchaseId}/feedback`, { method: 'DELETE' });
    expect(unauthenticated.response.status).toBe(401);

    const asTheRatedSeller = await api(`/purchases/${purchaseId}/feedback`, seller.session({ method: 'DELETE' }));
    expect(asTheRatedSeller.response.status).toBe(403);

    const asAnOrdinaryStranger = await api(`/purchases/${purchaseId}/feedback`, stranger.session({ method: 'DELETE' }));
    expect(asAnOrdinaryStranger.response.status).toBe(403);

    const admin = await signupAdmin('feedback-delete-admin');
    const missingPurchaseFeedback = await createPurchase(buyer);
    const notFound = await api(`/purchases/${missingPurchaseFeedback}/feedback`, admin.session({ method: 'DELETE' }));
    expect(notFound.response.status).toBe(404);

    const deleted = await api(`/purchases/${purchaseId}/feedback`, admin.session({ method: 'DELETE' }));
    expect(deleted.response.status).toBe(200);
    expect(deleted.body).toEqual({ deleted: true });

    const listedAfter = await api(`/sellers/${seller.sellerId}/feedback`);
    expect(listedAfter.body.feedback).toHaveLength(0);

    const adminUserId = (await api('/auth/me', admin.session())).body.user.userId;
    const logRow = await env.DB.prepare(
      'SELECT * FROM admin_action_log WHERE action_type = ? AND target_type = ?',
    ).bind('delete_seller_feedback', 'seller_feedback').first();
    expect(logRow).not.toBeNull();
    expect(logRow.admin_user_id).toBe(adminUserId);
  });

  // #2003: the existence check and the DELETE aren't atomic, so a second
  // concurrent delete attempt can lose the race -- its own DELETE affects
  // 0 rows, and must not write a second admin_action_log row claiming it
  // deleted something it didn't. Same race-regression shape as
  // reviews-auth.test.js's own "logs the admin delete-override exactly
  // once, not once per losing racer" test for the sibling product-review
  // handler: fire two concurrent admin DELETEs at the same feedback row
  // and assert exactly one log row results, whatever each attempt's own
  // status turns out to be.
  it('logs the admin delete exactly once, not once per losing racer, when two deletes race the same feedback', async () => {
    const buyer = await signupBuilder('feedback-delete-race-buyer');
    const seller = await signupSeller('feedback-delete-race-seller');
    const purchaseId = await createPurchase(buyer, { sellerId: seller.sellerId });
    const posted = await api(`/purchases/${purchaseId}/feedback`, buyer.session({
      method: 'POST',
      body: JSON.stringify({ rating: 1, text: 'Abusive/policy-violating text goes here.' }),
    }));
    expect(posted.response.status).toBe(201);

    const feedbackId = (await env.DB.prepare('SELECT feedback_id FROM seller_feedback WHERE purchase_id = ?').bind(purchaseId).first()).feedback_id;

    const admin = await signupAdmin('feedback-delete-race-admin');
    const attempts = await Promise.all(
      Array.from({ length: 2 }, () => api(`/purchases/${purchaseId}/feedback`, admin.session({ method: 'DELETE' }))),
    );
    for (const attempt of attempts) {
      expect([200, 404]).toContain(attempt.response.status);
    }
    const succeeded = attempts.filter((attempt) => attempt.response.status === 200);
    expect(succeeded.length).toBeGreaterThanOrEqual(1);
    for (const attempt of succeeded) {
      expect(attempt.body).toEqual({ deleted: true });
    }

    // Scoped by target_id (not just action_type/target_type), the same
    // reviews-auth.test.js's own race test scopes its own query -- the
    // admin_action_log table is shared across every test in this file, so
    // an unscoped count would also catch the earlier delete test's own row.
    const logRows = await env.DB.prepare(
      'SELECT * FROM admin_action_log WHERE action_type = ? AND target_id = ?',
    ).bind('delete_seller_feedback', feedbackId).all();
    expect(logRows.results).toHaveLength(1);
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

  // #1385: deterministic reproduction of the real race, same
  // env.DB.prepare-interception idiom as worker/land.test.js's own
  // community-sign flag-race test and reviews-auth.test.js's identically-
  // shaped regression test for the product-review case this mirrors — a
  // refund fired (unawaited) the instant before the real INSERT INTO
  // seller_feedback statement the handler runs, landing in the exact
  // window between the eager refunded_at check above it and the INSERT.
  it('does not let feedback be inserted for a purchase refunded in the exact window between its eligibility check and its INSERT', async () => {
    const buyer = await signupBuilder('feedback-refund-race-buyer');
    const purchaseId = await createPurchase(buyer);

    const originalPrepare = env.DB.prepare.bind(env.DB);
    let armed = true;
    env.DB.prepare = (sql) => {
      if (armed && sql.includes('INSERT INTO seller_feedback')) {
        armed = false;
        originalPrepare(`UPDATE purchases SET refunded_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE purchase_id = ?`)
          .bind(purchaseId).run();
      }
      return originalPrepare(sql);
    };
    let rejected;
    try {
      rejected = await api(`/purchases/${purchaseId}/feedback`, buyer.session({
        method: 'POST', body: JSON.stringify({ rating: 5 }),
      }));
    } finally {
      env.DB.prepare = originalPrepare;
    }
    expect(rejected.response.status).toBe(409);
    expect(rejected.body.error).toMatch(/refunded/i);

    const feedbackRow = await env.DB.prepare('SELECT 1 FROM seller_feedback WHERE purchase_id = ?')
      .bind(purchaseId).first();
    expect(feedbackRow).toBeNull();
    const row = await env.DB.prepare('SELECT refunded_at FROM purchases WHERE purchase_id = ?')
      .bind(purchaseId).first();
    expect(row.refunded_at).not.toBeNull();
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

  describe('Author self-edit/delete (#1975)', () => {
    async function postFeedback(purchaseId, buyer, { rating = 4, text = 'Pretty good.' } = {}) {
      const posted = await api(`/purchases/${purchaseId}/feedback`, buyer.session({
        method: 'POST', body: JSON.stringify({ rating, text }),
      }));
      expect(posted.response.status).toBe(201);
      return posted.body.feedback.feedbackId;
    }

    it('lets the feedback\'s own author (the buyer) edit it directly, with no admin involvement', async () => {
      const buyer = await signupBuilder('feedback-author-edit-buyer');
      const seller = await signupSeller('feedback-author-edit-seller');
      const purchaseId = await createPurchase(buyer, { sellerId: seller.sellerId });
      await postFeedback(purchaseId, buyer);

      const edited = await api(`/purchases/${purchaseId}/feedback`, buyer.session({
        method: 'PATCH', body: JSON.stringify({ rating: 2, text: 'Changed my mind.' }),
      }));
      expect(edited.response.status).toBe(200);
      expect(edited.body.feedback).toMatchObject({ rating: 2, text: 'Changed my mind.' });

      const listed = await api(`/sellers/${seller.sellerId}/feedback`);
      expect(listed.body.feedback[0]).toMatchObject({ rating: 2, text: 'Changed my mind.' });
    });

    // #1738: the rated seller never gets to edit feedback about themselves
    // either -- there's no moderation equivalent for PATCH the way DELETE
    // has one, the same reasoning product_reviews'/calendar_events' own
    // PATCH already settled, just with an extra "including the rated
    // seller" case specific to this resource's own #1738 restriction.
    it('rejects an edit from anyone other than the feedback\'s own author, including the rated seller', async () => {
      const buyer = await signupBuilder('feedback-edit-cross-account-buyer');
      const seller = await signupSeller('feedback-edit-cross-account-seller');
      const stranger = await signupBuilder('feedback-edit-cross-account-stranger');
      const purchaseId = await createPurchase(buyer, { sellerId: seller.sellerId });
      await postFeedback(purchaseId, buyer);

      const unauthenticated = await api(`/purchases/${purchaseId}/feedback`, {
        method: 'PATCH', body: JSON.stringify({ rating: 1 }),
      });
      expect(unauthenticated.response.status).toBe(401);

      const wrongAccount = await api(`/purchases/${purchaseId}/feedback`, stranger.session({
        method: 'PATCH', body: JSON.stringify({ rating: 1 }),
      }));
      expect(wrongAccount.response.status).toBe(403);

      const asTheRatedSeller = await api(`/purchases/${purchaseId}/feedback`, seller.session({
        method: 'PATCH', body: JSON.stringify({ rating: 1 }),
      }));
      expect(asTheRatedSeller.response.status).toBe(403);

      const unchanged = await api(`/sellers/${seller.sellerId}/feedback`);
      expect(unchanged.body.feedback[0].rating).toBe(4);
    });

    it('keeps an omitted field as-is on edit, but clears text when explicitly set empty', async () => {
      const buyer = await signupBuilder('feedback-edit-partial-buyer');
      const purchaseId = await createPurchase(buyer);
      await postFeedback(purchaseId, buyer, { rating: 3, text: 'Original text.' });

      const ratingOnly = await api(`/purchases/${purchaseId}/feedback`, buyer.session({
        method: 'PATCH', body: JSON.stringify({ rating: 5 }),
      }));
      expect(ratingOnly.response.status).toBe(200);
      expect(ratingOnly.body.feedback).toMatchObject({ rating: 5, text: 'Original text.' });

      const clearText = await api(`/purchases/${purchaseId}/feedback`, buyer.session({
        method: 'PATCH', body: JSON.stringify({ text: '' }),
      }));
      expect(clearText.response.status).toBe(200);
      expect(clearText.body.feedback).toMatchObject({ rating: 5, text: null });
    });

    it('rejects an edit with an out-of-range rating', async () => {
      const buyer = await signupBuilder('feedback-edit-bad-rating-buyer');
      const purchaseId = await createPurchase(buyer);
      await postFeedback(purchaseId, buyer);

      const rejected = await api(`/purchases/${purchaseId}/feedback`, buyer.session({
        method: 'PATCH', body: JSON.stringify({ rating: 6 }),
      }));
      expect(rejected.response.status).toBe(400);
    });

    it('rejects an edit with text over the 280 character cap', async () => {
      const buyer = await signupBuilder('feedback-edit-too-long-buyer');
      const purchaseId = await createPurchase(buyer);
      await postFeedback(purchaseId, buyer);

      const rejected = await api(`/purchases/${purchaseId}/feedback`, buyer.session({
        method: 'PATCH', body: JSON.stringify({ text: 'x'.repeat(281) }),
      }));
      expect(rejected.response.status).toBe(400);
    });

    it('lets the feedback\'s own author (the buyer) delete it directly, with no admin involvement', async () => {
      const buyer = await signupBuilder('feedback-author-delete-buyer');
      const seller = await signupSeller('feedback-author-delete-seller');
      const purchaseId = await createPurchase(buyer, { sellerId: seller.sellerId });
      await postFeedback(purchaseId, buyer);

      const deleted = await api(`/purchases/${purchaseId}/feedback`, buyer.session({ method: 'DELETE' }));
      expect(deleted.response.status).toBe(200);
      expect(deleted.body).toEqual({ deleted: true });

      const listed = await api(`/sellers/${seller.sellerId}/feedback`);
      expect(listed.body.feedback).toHaveLength(0);
    });

    // A purchase with no buyer_builder_id (legacy/pre-#1123 row, or the
    // buyer's account since self-deleted -- ON DELETE SET NULL) has nobody
    // on record to own it -- the author-direct branches must never match
    // it, falling straight through to the existing admin-only path exactly
    // as before (same "legacy row" shape reviews-auth.test.js's own
    // equivalent test covers for product_reviews).
    it('never lets feedback on a purchase with no recorded buyer_builder_id be claimed as anyone\'s own', async () => {
      const seller = await signupSeller('feedback-legacy-no-buyer-seller');
      const shopper = await signupBuilder('feedback-legacy-no-buyer-shopper');
      const purchaseId = await createPurchase(null, { sellerId: seller.sellerId });
      const feedbackId = `seller-feedback-legacy-${crypto.randomUUID()}`;
      await env.DB.prepare(`
        INSERT INTO seller_feedback (feedback_id, purchase_id, seller_id, author_label, rating, text)
        VALUES (?, ?, ?, 'Legacy Reviewer', 3, 'Pre-#1975 feedback.')
      `).bind(feedbackId, purchaseId, seller.sellerId).run();

      const editRejected = await api(`/purchases/${purchaseId}/feedback`, shopper.session({
        method: 'PATCH', body: JSON.stringify({ rating: 1 }),
      }));
      expect(editRejected.response.status).toBe(403);

      const deleteRejectedByShopper = await api(`/purchases/${purchaseId}/feedback`, shopper.session({ method: 'DELETE' }));
      expect(deleteRejectedByShopper.response.status).toBe(403);

      const admin = await signupAdmin('feedback-legacy-no-buyer-admin');
      const deletedByAdmin = await api(`/purchases/${purchaseId}/feedback`, admin.session({ method: 'DELETE' }));
      expect(deletedByAdmin.response.status).toBe(200);
    });

    it('rate-limits repeated feedback edits from the same account', async () => {
      const buyer = await signupBuilder('feedback-edit-rate-limit-buyer');
      const purchaseId = await createPurchase(buyer);
      await postFeedback(purchaseId, buyer);

      for (let i = 0; i < 20; i++) {
        const attempt = await api(`/purchases/${purchaseId}/feedback`, buyer.session({
          method: 'PATCH', body: JSON.stringify({ rating: (i % 5) + 1 }),
        }));
        expect(attempt.response.status).not.toBe(429);
      }
      const limited = await api(`/purchases/${purchaseId}/feedback`, buyer.session({
        method: 'PATCH', body: JSON.stringify({ rating: 1 }),
      }));
      expect(limited.response.status).toBe(429);
    });

    // #1975: "Maybe we should keep a record of the original content
    // internally in case of disputes" -- every author-initiated edit/
    // delete should snapshot the pre-change row into
    // user_content_edit_history (migrations/0129) first.
    it('snapshots the pre-edit feedback into user_content_edit_history before applying an author edit', async () => {
      const buyer = await signupBuilder('feedback-history-edit-buyer');
      const purchaseId = await createPurchase(buyer);
      const feedbackId = await postFeedback(purchaseId, buyer, { rating: 4, text: 'Before the edit.' });
      const buyerUserId = (await api('/auth/me', buyer.session())).body.user.userId;

      const edited = await api(`/purchases/${purchaseId}/feedback`, buyer.session({
        method: 'PATCH', body: JSON.stringify({ rating: 1, text: 'After the edit.' }),
      }));
      expect(edited.response.status).toBe(200);

      const history = await env.DB.prepare(
        'SELECT * FROM user_content_edit_history WHERE source_table = ? AND source_id = ?',
      ).bind('seller_feedback', feedbackId).all();
      expect(history.results).toHaveLength(1);
      expect(history.results[0]).toMatchObject({ action: 'edit', actor_user_id: buyerUserId });
      const snapshot = JSON.parse(history.results[0].snapshot_json);
      expect(snapshot).toMatchObject({ feedback_id: feedbackId, rating: 4, text: 'Before the edit.' });
    });

    it('snapshots the pre-delete feedback into user_content_edit_history before an author delete', async () => {
      const buyer = await signupBuilder('feedback-history-delete-buyer');
      const purchaseId = await createPurchase(buyer);
      const feedbackId = await postFeedback(purchaseId, buyer, { rating: 5, text: 'About to be deleted.' });
      const buyerUserId = (await api('/auth/me', buyer.session())).body.user.userId;

      const deleted = await api(`/purchases/${purchaseId}/feedback`, buyer.session({ method: 'DELETE' }));
      expect(deleted.response.status).toBe(200);

      const history = await env.DB.prepare(
        'SELECT * FROM user_content_edit_history WHERE source_table = ? AND source_id = ?',
      ).bind('seller_feedback', feedbackId).all();
      expect(history.results).toHaveLength(1);
      expect(history.results[0]).toMatchObject({ action: 'delete', actor_user_id: buyerUserId });
      const snapshot = JSON.parse(history.results[0].snapshot_json);
      expect(snapshot).toMatchObject({ feedback_id: feedbackId, rating: 5, text: 'About to be deleted.' });
    });

    // #2122: a lost concurrency race (another request deletes the feedback
    // in the real gap between the eager read and this handler's own
    // UPDATE/DELETE) must not leave a false snapshot behind for an edit/
    // delete that never actually took effect -- the request itself still
    // 409s either way.
    it('does not snapshot to user_content_edit_history when an author edit loses a concurrency race', async () => {
      const buyer = await signupBuilder('feedback-history-edit-lost-race-buyer');
      const purchaseId = await createPurchase(buyer);
      const feedbackId = await postFeedback(purchaseId, buyer, { rating: 4, text: 'Before the race.' });

      const originalPrepare = env.DB.prepare.bind(env.DB);
      let armed = true;
      env.DB.prepare = (sql) => {
        if (armed && sql.includes('UPDATE seller_feedback SET rating')) {
          armed = false;
          originalPrepare('DELETE FROM seller_feedback WHERE purchase_id = ?').bind(purchaseId).run();
        }
        return originalPrepare(sql);
      };
      let edited;
      try {
        edited = await api(`/purchases/${purchaseId}/feedback`, buyer.session({
          method: 'PATCH', body: JSON.stringify({ rating: 1, text: 'After the race.' }),
        }));
      } finally {
        env.DB.prepare = originalPrepare;
      }
      expect(edited.response.status).toBe(409);

      const history = await env.DB.prepare(
        'SELECT * FROM user_content_edit_history WHERE source_table = ? AND source_id = ?',
      ).bind('seller_feedback', feedbackId).all();
      expect(history.results).toHaveLength(0);
    });

    it('does not snapshot to user_content_edit_history when an author delete loses a concurrency race', async () => {
      const buyer = await signupBuilder('feedback-history-delete-lost-race-buyer');
      const purchaseId = await createPurchase(buyer);
      const feedbackId = await postFeedback(purchaseId, buyer, { rating: 5, text: 'Already gone.' });

      const originalPrepare = env.DB.prepare.bind(env.DB);
      let armed = true;
      env.DB.prepare = (sql) => {
        if (armed && sql.includes('DELETE FROM seller_feedback WHERE purchase_id = ? AND EXISTS')) {
          armed = false;
          originalPrepare('DELETE FROM seller_feedback WHERE purchase_id = ?').bind(purchaseId).run();
        }
        return originalPrepare(sql);
      };
      let deleted;
      try {
        deleted = await api(`/purchases/${purchaseId}/feedback`, buyer.session({ method: 'DELETE' }));
      } finally {
        env.DB.prepare = originalPrepare;
      }
      expect(deleted.response.status).toBe(409);

      const history = await env.DB.prepare(
        'SELECT * FROM user_content_edit_history WHERE source_table = ? AND source_id = ?',
      ).bind('seller_feedback', feedbackId).all();
      expect(history.results).toHaveLength(0);
    });

    // #2364: unlike the "race before the UPDATE" tests above, this one
    // needs the concurrent DELETE to land strictly *after* the UPDATE
    // commits but before this handler's own re-SELECT -- the exact gap
    // #2354 found and fixed for sign_posts/calendar_events' identical
    // shape. Wraps the UPDATE statement's own run() (rather than racing
    // prepare() itself) so the DELETE only ever fires once the UPDATE has
    // genuinely already matched a row.
    it('never crashes with a raw 500 when its own re-fetch loses a race to a concurrent delete', async () => {
      const buyer = await signupBuilder('feedback-refetch-delete-race-buyer');
      const purchaseId = await createPurchase(buyer);
      await postFeedback(purchaseId, buyer, { rating: 4, text: 'Before the race.' });

      const originalPrepare = env.DB.prepare.bind(env.DB);
      env.DB.prepare = (sql) => {
        const stmt = originalPrepare(sql);
        if (sql.includes('UPDATE seller_feedback SET rating')) {
          const originalBind = stmt.bind.bind(stmt);
          stmt.bind = (...args) => {
            const bound = originalBind(...args);
            const originalRun = bound.run.bind(bound);
            bound.run = async () => {
              const result = await originalRun();
              await originalPrepare('DELETE FROM seller_feedback WHERE purchase_id = ?').bind(purchaseId).run();
              return result;
            };
            return bound;
          };
        }
        return stmt;
      };
      let edited;
      try {
        edited = await api(`/purchases/${purchaseId}/feedback`, buyer.session({
          method: 'PATCH', body: JSON.stringify({ rating: 1, text: 'After the race.' }),
        }));
      } finally {
        env.DB.prepare = originalPrepare;
      }
      // The real bug was an uncaught TypeError (raw 500) when the re-SELECT
      // after an already-successful UPDATE found the row already gone.
      expect(edited.response.status).toBe(404);
    });

    // Moderation deletes (admin override) are not the user editing/
    // deleting their own content -- the owner's own framing was
    // specifically about self-service, so these must not write to the
    // history table. There's no seller-moderation equivalent to check here
    // (unlike product_reviews' own version of this test) since #1738
    // confirmed the rated seller has no self-service removal path at all.
    it('does not snapshot to user_content_edit_history on an admin moderation delete', async () => {
      const buyer = await signupBuilder('feedback-history-moderation-buyer');
      const seller = await signupSeller('feedback-history-moderation-seller');
      const purchaseId = await createPurchase(buyer, { sellerId: seller.sellerId });
      const feedbackId = await postFeedback(purchaseId, buyer);

      const admin = await signupAdmin('feedback-history-moderation-admin');
      const deletedByAdmin = await api(`/purchases/${purchaseId}/feedback`, admin.session({ method: 'DELETE' }));
      expect(deletedByAdmin.response.status).toBe(200);

      const history = await env.DB.prepare(
        'SELECT * FROM user_content_edit_history WHERE source_table = ? AND source_id = ?',
      ).bind('seller_feedback', feedbackId).all();
      expect(history.results).toHaveLength(0);
    });
  });
});
