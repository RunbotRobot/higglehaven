import {
  applyD1Migrations, env, SELF,
} from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from './index.js';
import {
  api, extractSessionCookie, withSession, signup, signupBuilder, signupSeller, glbFile, signupAdmin,
  createGreenbeltLandletAs,
} from './test-helpers.js';

// Shared across every test that needs to act as an admin (world/land-
// candidate tooling — see requireAdmin in worker/index.js) — one admin
// account for the whole file rather than a fresh one per test, since
// admin status carries no per-test state of its own to isolate.
let adminSession;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const admin = await signupAdmin('shared-admin');
  adminSession = admin.session;
});

function createGreenbeltLandlet(landletId) {
  return createGreenbeltLandletAs(adminSession, landletId);
}

describe('Product reviews', () => {
  async function createTemplate(templateId) {
    const created = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId,
        name: `Reviewable product ${templateId}`,
        color: '#123456',
        dimensions: { width: 1, depth: 1, height: 1 },
      }),
    });
    expect(created.response.status).toBe(201);
    return templateId;
  }

  // #1113: eligibility is now a real purchases.buyer_builder_id foreign key
  // (migrations/0099), not a free-text buyer_label match — `buyer` is a
  // signupBuilder() account (or omitted, for a legacy/pre-#1113 purchase
  // with no buyer identity at all). instance_id/seller_id have no FK
  // constraints (migrations/0051's own "permanent receipt, not tied to a
  // live reference" design), so this can insert directly without a real
  // placed instance — a throwaway host builder created via plain POST
  // /api/builders (unrelated to review eligibility, just satisfies
  // purchases.builder_id's own FK) stands in for the landlet owner.
  async function createPurchase(templateId, buyer, { refunded = false } = {}) {
    // #1187: label is now unique case-insensitively, and this helper can be
    // called more than once for the same templateId within one test — a
    // random suffix keeps each throwaway host builder's own label from
    // colliding with an earlier call's, the same way its builder_id
    // already does via crypto.randomUUID() below.
    const host = (await api('/builders', { method: 'POST', body: JSON.stringify({ label: `Host for ${templateId} ${crypto.randomUUID()}` }) })).body.builder;
    await env.DB.prepare(`
      INSERT INTO purchases
        (purchase_id, instance_id, template_id, builder_id, buyer_label, buyer_builder_id,
         unit_price_cents, quantity, total_cents, commission_cents, builder_share_cents, platform_share_cents, refunded_at)
      VALUES (?, ?, ?, ?, ?, ?, 500, 1, 500, 10, 5, 5, ?)
    `).bind(`purchase-${crypto.randomUUID()}`, `instance-${crypto.randomUUID()}`, templateId, host.builderId,
      buyer ? buyer.builder.label : null, buyer ? buyer.builderId : null,
      refunded ? new Date().toISOString() : null).run();
  }

  it('rejects a review on a catalog template that does not exist', async () => {
    const rejected = await api('/catalog/template-does-not-exist/reviews', {
      method: 'POST',
      body: JSON.stringify({ rating: 5 }),
    });
    expect(rejected.response.status).toBe(404);
  });

  it('rejects an unauthenticated review on a real template', async () => {
    const templateId = await createTemplate('review-requires-session');
    const rejected = await api(`/catalog/${templateId}/reviews`, {
      method: 'POST',
      body: JSON.stringify({ rating: 5 }),
    });
    expect(rejected.response.status).toBe(401);
  });

  it('rejects a review from a shopper who never purchased the product', async () => {
    const templateId = await createTemplate('review-gate-unpurchased');
    const shopper = await signupBuilder('review-gate-unpurchased-shopper');
    const rejected = await api(`/catalog/${templateId}/reviews`, shopper.session({
      method: 'POST',
      body: JSON.stringify({ rating: 5 }),
    }));
    expect(rejected.response.status).toBe(400);
  });

  // A purchase from before migrations/0099 (or any other row with no
  // buyer_builder_id) has no real buyer identity to match a session
  // against — it can never back a review, unlike the old design's
  // anonymous-buyerLabel case, which this replaces.
  it('rejects a review backed only by a purchase with no buyer_builder_id', async () => {
    const templateId = await createTemplate('review-gate-no-buyer-id-purchase');
    await createPurchase(templateId, null);
    const shopper = await signupBuilder('review-gate-no-buyer-id-shopper');
    const rejected = await api(`/catalog/${templateId}/reviews`, shopper.session({
      method: 'POST',
      body: JSON.stringify({ rating: 5 }),
    }));
    expect(rejected.response.status).toBe(400);
  });

  it('accepts a review from the real buyer of a matching purchase', async () => {
    const templateId = await createTemplate('review-gate-matching-purchase');
    const shopper = await signupBuilder('review-gate-matching-shopper');
    await createPurchase(templateId, shopper);
    const accepted = await api(`/catalog/${templateId}/reviews`, shopper.session({
      method: 'POST',
      body: JSON.stringify({ rating: 5 }),
    }));
    expect(accepted.response.status).toBe(201);
    // authorLabel is derived server-side from the session, never accepted
    // from the request body.
    expect(accepted.body.review.authorLabel).toBe(shopper.builder.label);
    expect(accepted.body.review.purchaseId).toMatch(/^purchase-/);
  });

  // A different builder's purchase of the same product doesn't make the
  // caller eligible — eligibility is per-buyer, not per-template.
  it('rejects a review from a builder who did not make the matching purchase', async () => {
    const templateId = await createTemplate('review-gate-wrong-buyer');
    const buyer = await signupBuilder('review-gate-wrong-buyer-real');
    const stranger = await signupBuilder('review-gate-wrong-buyer-stranger');
    await createPurchase(templateId, buyer);
    const rejected = await api(`/catalog/${templateId}/reviews`, stranger.session({
      method: 'POST',
      body: JSON.stringify({ rating: 5 }),
    }));
    expect(rejected.response.status).toBe(400);
  });

  // Found during a broader backlog-exploration pass (#357): the eligibility
  // check matched any purchase under the buyer's label, refunded or not — a
  // shopper who'd already been made whole (and whose refund already clawed
  // back the seller/builder's commission) could still leave a "verified
  // purchase" review under that same refunded transaction.
  it('rejects a review backed only by a refunded purchase', async () => {
    const templateId = await createTemplate('review-gate-refunded-purchase');
    const shopper = await signupBuilder('review-gate-refunded-shopper');
    await createPurchase(templateId, shopper, { refunded: true });
    const rejected = await api(`/catalog/${templateId}/reviews`, shopper.session({
      method: 'POST',
      body: JSON.stringify({ rating: 5 }),
    }));
    expect(rejected.response.status).toBe(400);
  });

  it('rejects a second review attempt once the buyer\'s only purchase is already reviewed — one review per purchase', async () => {
    const templateId = await createTemplate('review-one-per-purchase');
    const shopper = await signupBuilder('review-one-per-purchase-shopper');
    await createPurchase(templateId, shopper);
    const first = await api(`/catalog/${templateId}/reviews`, shopper.session({
      method: 'POST',
      body: JSON.stringify({ rating: 5 }),
    }));
    expect(first.response.status).toBe(201);

    // #1113: unlike the old per-label design, the buyer now simply has no
    // *eligible* purchase left (the only one they have is already
    // reviewed) — a clean 400, not a 409, since there's nothing concrete
    // left to conflict with.
    const second = await api(`/catalog/${templateId}/reviews`, shopper.session({
      method: 'POST',
      body: JSON.stringify({ rating: 1, text: 'Actually terrible' }),
    }));
    expect(second.response.status).toBe(400);

    const listed = await api(`/catalog/${templateId}/reviews`);
    expect(listed.body.reviews).toHaveLength(1);
    expect(listed.body.averageRating).toBe(5);

    // Deleting the first review frees that same purchase up to review again.
    await api(`/catalog/${templateId}/reviews/${first.body.review.reviewId}`, { method: 'DELETE' });
    const third = await api(`/catalog/${templateId}/reviews`, shopper.session({
      method: 'POST',
      body: JSON.stringify({ rating: 2 }),
    }));
    expect(third.response.status).toBe(201);
  });

  it('rejects a concurrent burst against the same purchase to exactly one review — regression test for a check-then-act race', async () => {
    // The real atomicity guard is the INSERT's own WHERE NOT EXISTS against
    // purchase_id — without it, concurrent submits against the same
    // purchase could all pass a separate SELECT-then-INSERT eligibility
    // check before any INSERT committed, creating duplicate reviews (or
    // 500ing on the unique index's own constraint violation instead of a
    // clean error). Firing every request at once (rather than the
    // sequential test above, which an unfixed version would also pass) is
    // what actually exercises that race.
    //
    // Unlike the old per-label design, the losing attempts here aren't
    // guaranteed a single status code: the eligibility SELECT itself now
    // excludes an already-reviewed purchase, so a losing attempt gets 409
    // only if it reaches the INSERT with the same purchase_id before
    // losing that race too, and 400 ("no eligible purchase left") if its
    // own SELECT runs after the winner's INSERT already committed — both
    // are a correct rejection, not a bug, and which one happens depends on
    // scheduling. The one invariant this test actually guards is that
    // exactly one review is ever created, never more.
    const templateId = await createTemplate('review-burst-race');
    const shopper = await signupBuilder('review-burst-race-shopper');
    await createPurchase(templateId, shopper);

    const attempts = await Promise.all(
      Array.from({ length: 10 }, () => api(`/catalog/${templateId}/reviews`, shopper.session({
        method: 'POST',
        body: JSON.stringify({ rating: 5 }),
      }))),
    );
    const created = attempts.filter((a) => a.response.status === 201);
    const rejected = attempts.filter((a) => a.response.status === 400 || a.response.status === 409);
    expect(created).toHaveLength(1);
    expect(rejected).toHaveLength(9);

    const listed = await api(`/catalog/${templateId}/reviews`);
    expect(listed.body.reviews).toHaveLength(1);
  });

  // #1385: deterministic reproduction of the real race, the same
  // env.DB.prepare-interception idiom worker/land.test.js's own community-
  // sign flag-race test uses -- a refund fired (unawaited, relying on this
  // environment's same-connection statement ordering) the instant before
  // the real INSERT INTO product_reviews statement the handler itself
  // runs, landing in the exact window between its eligibility SELECT
  // (already read this purchase as eligible) and its INSERT. Exercises the
  // real handler end to end through the real HTTP endpoint, unlike a raw
  // SQL reproduction of the fix, which would pass regardless of whether
  // worker/index.js's own query actually includes the guard.
  it('does not let a review be inserted for a purchase refunded in the exact window between its eligibility check and its INSERT', async () => {
    const templateId = await createTemplate('review-refund-race');
    const shopper = await signupBuilder('review-refund-race-shopper');
    await createPurchase(templateId, shopper);
    const purchase = await env.DB.prepare(
      'SELECT purchase_id FROM purchases WHERE template_id = ? AND buyer_builder_id = ?',
    ).bind(templateId, shopper.builderId).first();

    const originalPrepare = env.DB.prepare.bind(env.DB);
    let armed = true;
    env.DB.prepare = (sql) => {
      if (armed && sql.includes('INSERT INTO product_reviews')) {
        armed = false;
        originalPrepare(`UPDATE purchases SET refunded_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE purchase_id = ?`)
          .bind(purchase.purchase_id).run();
      }
      return originalPrepare(sql);
    };
    let rejected;
    try {
      rejected = await api(`/catalog/${templateId}/reviews`, shopper.session({
        method: 'POST', body: JSON.stringify({ rating: 5 }),
      }));
    } finally {
      env.DB.prepare = originalPrepare;
    }
    expect(rejected.response.status).toBe(409);
    expect(rejected.body.error).toMatch(/refunded/i);

    const reviewRow = await env.DB.prepare('SELECT 1 FROM product_reviews WHERE purchase_id = ?')
      .bind(purchase.purchase_id).first();
    expect(reviewRow).toBeNull();
    const row = await env.DB.prepare('SELECT refunded_at FROM purchases WHERE purchase_id = ?')
      .bind(purchase.purchase_id).first();
    expect(row.refunded_at).not.toBeNull();
  });

  it('creates, lists (with an average), and moderates reviews on a catalog template — no opt-in required', async () => {
    const templateId = await createTemplate('reviewable-product');
    const shopperA = await signupBuilder('reviewable-product-shopper-a');
    const shopperB = await signupBuilder('reviewable-product-shopper-b');
    await createPurchase(templateId, shopperA);
    await createPurchase(templateId, shopperB);

    const emptyList = await api(`/catalog/${templateId}/reviews`);
    expect(emptyList.response.status).toBe(200);
    expect(emptyList.body.reviews).toEqual([]);
    expect(emptyList.body.averageRating).toBeNull();
    expect(emptyList.body.count).toBe(0);

    const missingRating = await api(`/catalog/${templateId}/reviews`, shopperA.session({
      method: 'POST',
      body: JSON.stringify({}),
    }));
    expect(missingRating.response.status).toBe(400);

    for (const badRating of [0, 6, 3.5, 'five']) {
      const rejected = await api(`/catalog/${templateId}/reviews`, shopperA.session({
        method: 'POST',
        body: JSON.stringify({ rating: badRating }),
      }));
      expect(rejected.response.status).toBe(400);
    }

    const tooLong = await api(`/catalog/${templateId}/reviews`, shopperA.session({
      method: 'POST',
      body: JSON.stringify({ rating: 4, text: 'x'.repeat(281) }),
    }));
    expect(tooLong.response.status).toBe(400);

    const firstReview = await api(`/catalog/${templateId}/reviews`, shopperA.session({
      method: 'POST',
      body: JSON.stringify({ rating: 5, text: 'Lovely product!' }),
    }));
    expect(firstReview.response.status).toBe(201);
    expect(firstReview.body.review).toMatchObject({
      templateId,
      authorLabel: shopperA.builder.label,
      rating: 5,
      text: 'Lovely product!',
    });
    expect(firstReview.body.review.reviewId).toMatch(/^review-/);

    // text is genuinely optional — a bare star rating is still a real review.
    const secondReview = await api(`/catalog/${templateId}/reviews`, shopperB.session({
      method: 'POST',
      body: JSON.stringify({ rating: 3 }),
    }));
    expect(secondReview.response.status).toBe(201);
    expect(secondReview.body.review.text).toBeNull();

    const listed = await api(`/catalog/${templateId}/reviews`);
    expect(listed.body.reviews).toHaveLength(2);
    expect(listed.body.count).toBe(2);
    expect(listed.body.averageRating).toBe(4); // (5 + 3) / 2

    const deleted = await api(`/catalog/${templateId}/reviews/${secondReview.body.review.reviewId}`, { method: 'DELETE' });
    expect(deleted.response.status).toBe(200);
    expect(deleted.body).toEqual({ deleted: true });

    const listedAfterDelete = await api(`/catalog/${templateId}/reviews`);
    expect(listedAfterDelete.body.reviews).toHaveLength(1);
    expect(listedAfterDelete.body.averageRating).toBe(5);

    const deleteMissing = await api(`/catalog/${templateId}/reviews/${secondReview.body.review.reviewId}`, { method: 'DELETE' });
    expect(deleteMissing.response.status).toBe(404);
  });

  it('computes averageRating/count over every review, not just the 200-row list page', async () => {
    const templateId = await createTemplate('reviews-beyond-list-cap');
    // 200 one-star reviews (the oldest, so they're the ones the list's own
    // LIMIT 200 would return) plus one five-star review newer than all of
    // them. If averageRating/count were derived from the returned list
    // (bugged behavior) rather than a separate unlimited aggregate, the
    // 201st review would never move either figure.
    const inserts = [];
    for (let i = 0; i < 200; i++) {
      inserts.push(env.DB.prepare(`
        INSERT INTO product_reviews (review_id, template_id, author_label, rating, created_at)
        VALUES (?, ?, ?, 1, ?)
      `).bind(`review-beyond-cap-${i}`, templateId, `Shopper ${i}`, `2020-01-01T00:00:${String(i).padStart(2, '0')}.000Z`));
    }
    inserts.push(env.DB.prepare(`
      INSERT INTO product_reviews (review_id, template_id, author_label, rating, created_at)
      VALUES (?, ?, ?, 5, '2020-01-02T00:00:00.000Z')
    `).bind('review-beyond-cap-201st', templateId, 'Newest Shopper'));
    await env.DB.batch(inserts);

    const listed = await api(`/catalog/${templateId}/reviews`);
    expect(listed.response.status).toBe(200);
    expect(listed.body.reviews).toHaveLength(200); // the list page itself does stay capped
    expect(listed.body.count).toBe(201);
    expect(listed.body.averageRating).toBeCloseTo((200 * 1 + 5) / 201);

    // #416: the 200-row window has to be the *newest* 200, not the oldest —
    // the just-submitted 201st (newest) review must actually be visible in
    // the capped list, not just reflected in count/averageRating.
    expect(listed.body.reviews.map((r) => r.reviewId)).toContain('review-beyond-cap-201st');
    expect(listed.body.reviews.map((r) => r.reviewId)).not.toContain('review-beyond-cap-0');
  });

  it('gates review moderation (DELETE) to the template\'s own seller, unlike an unowned template', async () => {
    const seller = await signupSeller('review-moderation-seller');
    const otherSeller = await signupSeller('review-moderation-other-seller');
    const shopper = await signupBuilder('review-moderation-shopper');
    const created = await api('/catalog', seller.session({
      method: 'POST',
      body: JSON.stringify({
        templateId: 'review-moderation-owned',
        name: 'Seller-owned reviewable product',
        color: '#123456',
        dimensions: { width: 1, depth: 1, height: 1 },
        sellerId: seller.sellerId,
      }),
    }));
    expect(created.response.status).toBe(201);
    const templateId = created.body.template.templateId;
    await createPurchase(templateId, shopper);
    const posted = await api(`/catalog/${templateId}/reviews`, shopper.session({
      method: 'POST',
      body: JSON.stringify({ rating: 5 }),
    }));
    expect(posted.response.status).toBe(201);
    const reviewId = posted.body.review.reviewId;

    const unauthenticated = await api(`/catalog/${templateId}/reviews/${reviewId}`, { method: 'DELETE' });
    expect(unauthenticated.response.status).toBe(401);

    const wrongSeller = await api(`/catalog/${templateId}/reviews/${reviewId}`, otherSeller.session({ method: 'DELETE' }));
    expect(wrongSeller.response.status).toBe(403);

    const listedStillThere = await api(`/catalog/${templateId}/reviews`);
    expect(listedStillThere.body.reviews).toHaveLength(1);

    const deleted = await api(`/catalog/${templateId}/reviews/${reviewId}`, seller.session({ method: 'DELETE' }));
    expect(deleted.response.status).toBe(200);
    expect(deleted.body).toEqual({ deleted: true });
  });

  // #1043: every other real "something happened that the other party
  // should passively learn about" event in this file/codebase fires a
  // notification (new auction bid, an auction selling, a sale, a friend
  // request) — a new review posted against a seller's own catalog template
  // was the one comparable event with no notification path at all. The
  // seller's own builder profile (always auto-provisioned, same account,
  // same user_id) is what receives it.
  it('notifies the template\'s own seller (via their builder profile) when a new review is posted', async () => {
    const seller = await signupSeller('review-notify-seller');
    const shopper = await signupBuilder('review-notify-shopper');
    const created = await api('/catalog', seller.session({
      method: 'POST',
      body: JSON.stringify({
        templateId: 'review-notify-template',
        name: 'Notify-worthy product',
        color: '#123456',
        dimensions: { width: 1, depth: 1, height: 1 },
        sellerId: seller.sellerId,
      }),
    }));
    expect(created.response.status).toBe(201);
    const templateId = created.body.template.templateId;
    const sellerBuilderId = (await api('/builders/me', seller.session())).body.builder.builderId;

    await createPurchase(templateId, shopper);
    const posted = await api(`/catalog/${templateId}/reviews`, shopper.session({
      method: 'POST',
      body: JSON.stringify({ rating: 4 }),
    }));
    expect(posted.response.status).toBe(201);

    const { results } = await env.DB.prepare(
      'SELECT message FROM notifications WHERE builder_id = ?',
    ).bind(sellerBuilderId).all();
    expect(results).toHaveLength(1);
    expect(results[0].message).toContain(shopper.builder.label);
    expect(results[0].message).toContain('Notify-worthy product');
  });

  // A review on a seller-less (orphaned or never-owned) template has nobody
  // to notify — must not throw trying to resolve a notification target.
  it('does not error posting a review on a seller-less template — nobody to notify', async () => {
    const templateId = await createTemplate('review-notify-no-seller');
    const shopper = await signupBuilder('review-notify-no-seller-shopper');
    await createPurchase(templateId, shopper);
    const posted = await api(`/catalog/${templateId}/reviews`, shopper.session({
      method: 'POST',
      body: JSON.stringify({ rating: 5 }),
    }));
    expect(posted.response.status).toBe(201);
  });

  // DELETE /api/sellers/:sellerId deliberately leaves a template's
  // seller_id dangling rather than cleaning it up — docs/API.md says
  // that's "the same as" a template with a null seller_id, which review
  // moderation and catalog PATCH/DELETE both already leave unrestricted.
  // Before this test's fix, the plain `if (template.seller_id)` truthiness
  // check treated that dangling id as still-owned, and since no live
  // session can ever match an id that no longer exists, moderation became
  // permanently blocked for everyone, including admins.
  it('unlocks review moderation, and catalog PATCH/DELETE, once the template\'s seller has since deleted their account', async () => {
    const seller = await signupSeller('review-moderation-deleted-seller');
    const shopper = await signupBuilder('review-moderation-deleted-seller-shopper');
    const created = await api('/catalog', seller.session({
      method: 'POST',
      body: JSON.stringify({
        templateId: 'review-moderation-deleted-seller-template',
        name: 'Product whose seller later deletes their account',
        color: '#123456',
        dimensions: { width: 1, depth: 1, height: 1 },
        sellerId: seller.sellerId,
      }),
    }));
    expect(created.response.status).toBe(201);
    const templateId = created.body.template.templateId;
    await createPurchase(templateId, shopper);
    const posted = await api(`/catalog/${templateId}/reviews`, shopper.session({
      method: 'POST',
      body: JSON.stringify({ rating: 5 }),
    }));
    expect(posted.response.status).toBe(201);
    const reviewId = posted.body.review.reviewId;

    const sellerDeleted = await api(`/sellers/${seller.sellerId}`, seller.session({ method: 'DELETE' }));
    expect(sellerDeleted.response.status).toBe(200);

    // A dangling seller_id now falls through to the same unrestricted path
    // a genuinely null seller_id already takes — no session required.
    const patched = await api(`/catalog/${templateId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Renamed after seller deletion' }),
    });
    expect(patched.response.status).toBe(200);
    expect(patched.body.template.name).toBe('Renamed after seller deletion');

    const reviewDeleted = await api(`/catalog/${templateId}/reviews/${reviewId}`, { method: 'DELETE' });
    expect(reviewDeleted.response.status).toBe(200);

    const templateDeleted = await api(`/catalog/${templateId}`, { method: 'DELETE' });
    expect(templateDeleted.response.status).toBe(200);
  });

  // Found via backlog audit (#361): PATCH on a seller-less template requires
  // no session (see the test above) and fires a real notification to every
  // builder hosting it (notifyBuildersOfDimensionChange) on every dimension
  // change, with no rate limit at all. Synthetic cf-connecting-ip per the
  // sign-post rate-limit test's own approach.
  it('rate-limits repeated unauthenticated PATCHes on a seller-less template', async () => {
    const templateId = await createTemplate('catalog-patch-rate-limit');
    const headers = { 'cf-connecting-ip': `test-${crypto.randomUUID()}` };
    for (let i = 0; i < 20; i++) {
      const attempt = await api(`/catalog/${templateId}`, {
        method: 'PATCH', headers, body: JSON.stringify({ dimensions: { width: 1 + i * 0.01, depth: 1, height: 1 } }),
      });
      expect(attempt.response.status).not.toBe(429);
    }
    const limited = await api(`/catalog/${templateId}`, {
      method: 'PATCH', headers, body: JSON.stringify({ dimensions: { width: 9, depth: 1, height: 1 } }),
    });
    expect(limited.response.status).toBe(429);
  });

  // #1329: the authenticated seller-owner branch above had no rate limit at
  // all -- PR #367's own reasoning ("the session requirement already bounds
  // it") never held up against this file's later convention that an
  // authenticated mutation with a real notification fan-out (here,
  // notifyBuildersOfDimensionChange) still needs its own limit regardless of
  // the session gate, same as this endpoint's own unauthenticated branch
  // just above.
  it('rate-limits repeated authenticated PATCHes on a seller-owned template', async () => {
    const seller = await signupSeller('catalog-patch-owner-rate-limit-seller');
    const created = await api('/catalog', seller.session({
      method: 'POST',
      body: JSON.stringify({
        templateId: 'catalog-patch-owner-rate-limit-template',
        name: 'Owned rate-limit product',
        color: '#123456',
        dimensions: { width: 1, depth: 1, height: 1 },
        sellerId: seller.sellerId,
      }),
    }));
    expect(created.response.status).toBe(201);
    const templateId = created.body.template.templateId;

    for (let i = 0; i < 20; i++) {
      const attempt = await api(`/catalog/${templateId}`, seller.session({
        method: 'PATCH', body: JSON.stringify({ dimensions: { width: 1 + i * 0.01, depth: 1, height: 1 } }),
      }));
      expect(attempt.response.status).not.toBe(429);
    }
    const limited = await api(`/catalog/${templateId}`, seller.session({
      method: 'PATCH', body: JSON.stringify({ dimensions: { width: 9, depth: 1, height: 1 } }),
    }));
    expect(limited.response.status).toBe(429);
  });

  // #520: DELETE's unowned/orphaned path had the identical missing-rate-limit
  // gap as PATCH above — a single unauthenticated DELETE (unlike PATCH,
  // consumed one-shot) needs a fresh template per attempt.
  it('rate-limits repeated unauthenticated DELETEs of seller-less templates', async () => {
    const headers = { 'cf-connecting-ip': `test-${crypto.randomUUID()}` };
    for (let i = 0; i < 20; i++) {
      const templateId = await createTemplate(`catalog-delete-rate-limit-${i}`);
      const attempt = await api(`/catalog/${templateId}`, { method: 'DELETE', headers });
      expect(attempt.response.status).not.toBe(429);
    }
    const templateId = await createTemplate('catalog-delete-rate-limit-final');
    const limited = await api(`/catalog/${templateId}`, { method: 'DELETE', headers });
    expect(limited.response.status).toBe(429);
  });

  // #1455: the authenticated seller-owner DELETE branch had no rate limit at
  // all -- #1329's own comment on the PATCH handler above mistakenly claimed
  // parity with "this same resource's own DELETE sibling, #990/#991," but
  // #990/#991 actually fixed product_reviews' own nested DELETE, a different
  // handler. This top-level DELETE never got the fix. Unlike the repeatable
  // authenticated-PATCH test above, DELETE consumes its target, so each
  // attempt needs its own fresh owned template.
  it('rate-limits repeated authenticated DELETEs of seller-owned templates', async () => {
    const seller = await signupSeller('catalog-delete-owner-rate-limit-seller');
    async function createOwnedTemplate(templateId) {
      const created = await api('/catalog', seller.session({
        method: 'POST',
        body: JSON.stringify({
          templateId,
          name: `Owned delete rate-limit product ${templateId}`,
          color: '#123456',
          dimensions: { width: 1, depth: 1, height: 1 },
          sellerId: seller.sellerId,
        }),
      }));
      expect(created.response.status).toBe(201);
      return templateId;
    }

    for (let i = 0; i < 20; i++) {
      const templateId = await createOwnedTemplate(`catalog-delete-owner-rate-limit-${i}`);
      const attempt = await api(`/catalog/${templateId}`, seller.session({ method: 'DELETE' }));
      expect(attempt.response.status).not.toBe(429);
    }
    const templateId = await createOwnedTemplate('catalog-delete-owner-rate-limit-final');
    const limited = await api(`/catalog/${templateId}`, seller.session({ method: 'DELETE' }));
    expect(limited.response.status).toBe(429);
  });

  it('rate-limits repeated unauthenticated batch DELETEs containing seller-less templates', async () => {
    const headers = { 'cf-connecting-ip': `test-${crypto.randomUUID()}` };
    for (let i = 0; i < 20; i++) {
      const templateId = await createTemplate(`catalog-batch-delete-rate-limit-${i}`);
      const attempt = await api('/catalog/batch', {
        method: 'DELETE', headers, body: JSON.stringify({ templateIds: [templateId] }),
      });
      expect(attempt.response.status).not.toBe(429);
    }
    const templateId = await createTemplate('catalog-batch-delete-rate-limit-final');
    const limited = await api('/catalog/batch', {
      method: 'DELETE', headers, body: JSON.stringify({ templateIds: [templateId] }),
    });
    expect(limited.response.status).toBe(429);
  });

  // #1457: the batch sibling's authenticated all-owned path had the
  // identical gap as the single-item DELETE's own owned path (#1455) --
  // checkRateLimit only fired when the batch contained an unowned
  // template, so a batch of entirely owned templateIds ran unthrottled.
  // Each attempt uses its own fresh owned template since DELETE consumes
  // its target.
  it('rate-limits repeated authenticated batch DELETEs of entirely seller-owned templates', async () => {
    const seller = await signupSeller('catalog-batch-delete-rl-seller');
    async function createOwnedTemplate(templateId) {
      const created = await api('/catalog', seller.session({
        method: 'POST',
        body: JSON.stringify({
          templateId,
          name: `Owned batch delete rate-limit product ${templateId}`,
          color: '#123456',
          dimensions: { width: 1, depth: 1, height: 1 },
          sellerId: seller.sellerId,
        }),
      }));
      expect(created.response.status).toBe(201);
      return templateId;
    }

    for (let i = 0; i < 20; i++) {
      const templateId = await createOwnedTemplate(`catalog-batch-delete-owner-rate-limit-${i}`);
      const attempt = await api('/catalog/batch', seller.session({
        method: 'DELETE', body: JSON.stringify({ templateIds: [templateId] }),
      }));
      expect(attempt.response.status).not.toBe(429);
    }
    const templateId = await createOwnedTemplate('catalog-batch-delete-owner-rate-limit-final');
    const limited = await api('/catalog/batch', seller.session({
      method: 'DELETE', body: JSON.stringify({ templateIds: [templateId] }),
    }));
    expect(limited.response.status).toBe(429);
  });

  // #1416: PUT /catalog/batch fires the identical notifyBuildersOfDimension-
  // ChangeBatch fan-out its single-item sibling (PATCH/PUT above) is rate-
  // limited to protect, on a seller-less template with no session required
  // -- but this batch endpoint had no rate limit at all, authenticated or
  // not. One seller-less template reused across every attempt (same
  // "consumed one-shot" distinction the single-item PATCH test above notes
  // for DELETE) with a different dimension each time.
  it('rate-limits repeated unauthenticated batch PUTs containing a seller-less template', async () => {
    const templateId = await createTemplate('catalog-batch-put-rate-limit');
    const headers = { 'cf-connecting-ip': `test-${crypto.randomUUID()}` };
    for (let i = 0; i < 20; i++) {
      const attempt = await api('/catalog/batch', {
        method: 'PUT', headers,
        body: JSON.stringify({ templates: [{
          templateId, name: 'Batch put rate limit', color: '#123456',
          dimensions: { width: 1 + i * 0.01, depth: 1, height: 1 },
        }] }),
      });
      expect(attempt.response.status).not.toBe(429);
    }
    const limited = await api('/catalog/batch', {
      method: 'PUT', headers,
      body: JSON.stringify({ templates: [{
        templateId, name: 'Batch put rate limit', color: '#123456',
        dimensions: { width: 9, depth: 1, height: 1 },
      }] }),
    });
    expect(limited.response.status).toBe(429);
  });

  it('rate-limits repeated authenticated batch PUTs on a seller-owned template', async () => {
    const seller = await signupSeller('catalog-batch-put-rl-seller');
    const created = await api('/catalog', seller.session({
      method: 'POST',
      body: JSON.stringify({
        templateId: 'catalog-batch-put-owner-rate-limit-template',
        name: 'Owned batch rate-limit product',
        color: '#123456',
        dimensions: { width: 1, depth: 1, height: 1 },
        sellerId: seller.sellerId,
      }),
    }));
    expect(created.response.status).toBe(201);
    const templateId = created.body.template.templateId;

    for (let i = 0; i < 20; i++) {
      const attempt = await api('/catalog/batch', seller.session({
        method: 'PUT',
        body: JSON.stringify({ templates: [{
          templateId, name: 'Owned batch rate-limit product', color: '#123456',
          dimensions: { width: 1 + i * 0.01, depth: 1, height: 1 }, sellerId: seller.sellerId,
        }] }),
      }));
      expect(attempt.response.status).not.toBe(429);
    }
    const limited = await api('/catalog/batch', seller.session({
      method: 'PUT',
      body: JSON.stringify({ templates: [{
        templateId, name: 'Owned batch rate-limit product', color: '#123456',
        dimensions: { width: 9, depth: 1, height: 1 }, sellerId: seller.sellerId,
      }] }),
    }));
    expect(limited.response.status).toBe(429);
  });

  // Found via backlog audit: review moderation (DELETE) has the identical
  // permissive-when-orphaned shape as catalog template DELETE above (#520)
  // — a seller-less template's reviews stay unrestricted, but until now had
  // no rate limit at all on that unauthenticated path either.
  it('rate-limits repeated unauthenticated review DELETEs on a seller-less template', async () => {
    const templateId = await createTemplate('review-delete-rate-limit');
    // A fresh shopper per iteration — PRODUCT_REVIEW_CREATE_RATE_LIMIT_MAX
    // is now keyed by builder_id (#1113), so reusing one session across 21
    // POSTs here would trip *that* unrelated limit before this test ever
    // reaches its own 21st DELETE. DELETE's own rate limit (keyed by
    // clientIp, since this unauthenticated path has no session) doesn't
    // care which buyer backs each review either way.
    const headers = { 'cf-connecting-ip': `test-${crypto.randomUUID()}` };
    for (let i = 0; i < 20; i++) {
      const shopper = await signupBuilder(`review-delete-rate-limit-shopper-${i}`);
      await createPurchase(templateId, shopper);
      const posted = await api(`/catalog/${templateId}/reviews`, shopper.session({
        method: 'POST',
        body: JSON.stringify({ rating: 5 }),
      }));
      const attempt = await api(`/catalog/${templateId}/reviews/${posted.body.review.reviewId}`, {
        method: 'DELETE', headers,
      });
      expect(attempt.response.status).not.toBe(429);
    }
    const finalShopper = await signupBuilder('review-delete-rate-limit-shopper-final');
    await createPurchase(templateId, finalShopper);
    const posted = await api(`/catalog/${templateId}/reviews`, finalShopper.session({
      method: 'POST',
      body: JSON.stringify({ rating: 5 }),
    }));
    const limited = await api(`/catalog/${templateId}/reviews/${posted.body.review.reviewId}`, {
      method: 'DELETE', headers,
    });
    expect(limited.response.status).toBe(429);
  });

  // #990: unlike the anonymous/orphaned-template path just above (#564),
  // the authenticated seller-owner branch (see "gates review moderation"
  // above) never had a rate limit at all -- a seller could delete every
  // review on their own product in an unthrottled loop.
  it('rate-limits repeated authenticated review DELETEs by the template\'s own seller', async () => {
    const seller = await signupSeller('review-delete-owner-rate-limit-seller');
    const created = await api('/catalog', seller.session({
      method: 'POST',
      body: JSON.stringify({
        templateId: 'review-delete-owner-rate-limit',
        name: 'Seller-owned rate-limit product',
        color: '#123456',
        dimensions: { width: 1, depth: 1, height: 1 },
        sellerId: seller.sellerId,
      }),
    }));
    const templateId = created.body.template.templateId;
    // A fresh shopper per iteration — same reasoning as the unauthenticated
    // DELETE rate-limit test above: reusing one buyer session across 21
    // POSTs would trip the unrelated per-builder CREATE rate limit first.
    for (let i = 0; i < 20; i++) {
      const shopper = await signupBuilder(`review-owner-rl-shopper-${i}`);
      await createPurchase(templateId, shopper);
      const posted = await api(`/catalog/${templateId}/reviews`, shopper.session({
        method: 'POST',
        body: JSON.stringify({ rating: 5 }),
      }));
      const attempt = await api(
        `/catalog/${templateId}/reviews/${posted.body.review.reviewId}`,
        seller.session({ method: 'DELETE' }),
      );
      expect(attempt.response.status).not.toBe(429);
    }
    const finalShopper = await signupBuilder('review-owner-rl-shopper-final');
    await createPurchase(templateId, finalShopper);
    const posted = await api(`/catalog/${templateId}/reviews`, finalShopper.session({
      method: 'POST',
      body: JSON.stringify({ rating: 5 }),
    }));
    const limited = await api(
      `/catalog/${templateId}/reviews/${posted.body.review.reviewId}`,
      seller.session({ method: 'DELETE' }),
    );
    expect(limited.response.status).toBe(429);
  }, 30000); // #1511: 20 iterations of signupBuilder+createPurchase+POST+
  // DELETE (~80 real HTTP/DB operations total), matching #1469's precedent
  // for a comparable request volume elsewhere in this shared-D1-per-file
  // suite -- reliably fast in isolation but has hit the 20s default under
  // CI load.

  // #804: review *creation* itself had no rate limit at all, unlike its own
  // sibling DELETE branch (tested just above) and every comparable write in
  // this file. #1113 moved this from clientIp-keyed to builder_id-keyed
  // (POST now requires a session) and moved it ahead of the purchase-
  // eligibility lookup, so the limit itself fires regardless of whether any
  // given attempt would otherwise succeed — no real purchases needed here,
  // just the same session making repeated attempts.
  it('rate-limits repeated review creations from the same builder', async () => {
    const templateId = await createTemplate('review-create-rate-limit');
    const shopper = await signupBuilder('review-create-rate-limit-shopper');
    for (let i = 0; i < 20; i++) {
      const attempt = await api(`/catalog/${templateId}/reviews`, shopper.session({
        method: 'POST',
        body: JSON.stringify({ rating: 5 }),
      }));
      expect(attempt.response.status).not.toBe(429);
    }
    const limited = await api(`/catalog/${templateId}/reviews`, shopper.session({
      method: 'POST',
      body: JSON.stringify({ rating: 5 }),
    }));
    expect(limited.response.status).toBe(429);
  });

  it('keeps reviews independent between two different catalog templates', async () => {
    const templateA = await createTemplate('reviewable-product-a');
    const templateB = await createTemplate('reviewable-product-b');
    const shopper = await signupBuilder('reviewable-product-ab-shopper');
    await createPurchase(templateA, shopper);
    await api(`/catalog/${templateA}/reviews`, shopper.session({
      method: 'POST',
      body: JSON.stringify({ rating: 5 }),
    }));

    const listA = await api(`/catalog/${templateA}/reviews`);
    const listB = await api(`/catalog/${templateB}/reviews`);
    expect(listA.body.reviews).toHaveLength(1);
    expect(listB.body.reviews).toEqual([]);
  });

  it('cascades review deletion when the catalog template itself is deleted', async () => {
    const templateId = await createTemplate('reviewable-product-to-delete');
    const shopper = await signupBuilder('reviewable-product-to-delete-shopper');
    await createPurchase(templateId, shopper);
    await api(`/catalog/${templateId}/reviews`, shopper.session({
      method: 'POST',
      body: JSON.stringify({ rating: 4 }),
    }));
    await api(`/catalog/${templateId}`, { method: 'DELETE' });

    const afterDelete = await api(`/catalog/${templateId}/reviews`);
    expect(afterDelete.response.status).toBe(404);
  });
});

describe('Authentication', () => {
  it('signs up, logs in, and logs out with a real session cookie', async () => {
    const email = `auth-basic-${crypto.randomUUID()}@example.com`;
    const signedUp = await signup(email, 'correct horse battery staple');
    expect(signedUp.response.status).toBe(201);
    expect(signedUp.body.user).toMatchObject({ email, emailVerified: false });
    expect(signedUp.body.user.userId).toMatch(/^user-/);
    // Test env never configures RESEND_API_KEY (see sendEmail's own
    // comment), so verification falls back to returning the link directly
    // rather than emailing it — this is what makes the flow testable here.
    expect(signedUp.body.verificationEmailSent).toBe(false);
    expect(signedUp.body.devVerifyUrl).toMatch(/\/\?verifyEmail=[0-9a-f]{64}$/);
    const signupSessionToken = extractSessionCookie(signedUp.response);
    expect(signupSessionToken).toBeTruthy();

    // Signup itself logs you in — no separate login needed to use /me.
    const meAfterSignup = await api('/auth/me', withSession(signupSessionToken));
    expect(meAfterSignup.response.status).toBe(200);
    expect(meAfterSignup.body.user.email).toBe(email);

    const loggedIn = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'correct horse battery staple' }),
    });
    expect(loggedIn.response.status).toBe(200);
    const loginSessionToken = extractSessionCookie(loggedIn.response);
    expect(loginSessionToken).toBeTruthy();
    expect(loginSessionToken).not.toBe(signupSessionToken); // a genuinely new session, not a reused one

    const loggedOut = await api('/auth/logout', withSession(loginSessionToken, { method: 'POST' }));
    expect(loggedOut.response.status).toBe(200);
    expect(loggedOut.body).toEqual({ loggedOut: true });

    // 200 + null, not a 401 — see handleMe's own comment on why "nobody's
    // logged in" is treated as ordinary, expected state for this endpoint.
    const meAfterLogout = await api('/auth/me', withSession(loginSessionToken));
    expect(meAfterLogout.response.status).toBe(200);
    expect(meAfterLogout.body.user).toBeNull();

    // The signup session is untouched — logging out one device doesn't
    // sign out others (migrations/0053's own comment on why sessions are
    // per-device rows, not a single column on users).
    const meStillSignedUp = await api('/auth/me', withSession(signupSessionToken));
    expect(meStillSignedUp.response.status).toBe(200);
  });

  // #1283: a network-level fetch rejection (DNS failure, connection reset,
  // timeout — distinct from the !response.ok path the "RESEND_API_KEY
  // never configured" tests above exercise) used to propagate straight out
  // of handleSignup uncaught, even though the users/builders rows had
  // already committed, leaving the account stuck with no session issued
  // and a future signup retry 409ing on the same email. Temporarily
  // configuring RESEND_API_KEY here (restored in `finally`, scoped to this
  // test only) is what makes sendEmail actually reach its fetch call
  // instead of short-circuiting the way every other test in this file
  // relies on.
  it('still returns a session when the verification email\'s fetch rejects outright', async () => {
    const originalFetch = globalThis.fetch;
    env.RESEND_API_KEY = 'test-resend-api-key';
    globalThis.fetch = async (input, ...rest) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url === 'https://api.resend.com/emails') throw new TypeError('network error');
      return originalFetch(input, ...rest);
    };
    try {
      const email = `auth-email-fetch-reject-${crypto.randomUUID()}@example.com`;
      const signedUp = await signup(email, 'correct horse battery staple');
      expect(signedUp.response.status).toBe(201);
      expect(signedUp.body.verificationEmailSent).toBe(false);
      // RESEND_API_KEY is configured here, so devVerifyUrl stays withheld
      // (#811's own reasoning) even though the send failed.
      expect(signedUp.body.devVerifyUrl).toBeUndefined();
      expect(extractSessionCookie(signedUp.response)).toBeTruthy();
    } finally {
      globalThis.fetch = originalFetch;
      env.RESEND_API_KEY = undefined;
    }
  });

  it('/auth/me without a session cookie is 200 with a null user, not a 401', async () => {
    const response = await api('/auth/me');
    expect(response.response.status).toBe(200);
    expect(response.body.user).toBeNull();
  });

  it('admin-bootstrap requires a session and the correct secret, and is reusable', async () => {
    const account = await signupBuilder('bootstrap-tester');
    expect(account.builder).toBeTruthy();

    const noSession = await api('/auth/admin-bootstrap', {
      method: 'POST',
      body: JSON.stringify({ secret: env.ADMIN_BOOTSTRAP_SECRET }),
    });
    expect(noSession.response.status).toBe(401);

    const wrongSecret = await api('/auth/admin-bootstrap', account.session({
      method: 'POST',
      body: JSON.stringify({ secret: 'not-the-real-secret' }),
    }));
    expect(wrongSecret.response.status).toBe(403);

    const meBeforeBootstrap = await api('/auth/me', account.session());
    expect(meBeforeBootstrap.body.user.isAdmin).toBe(false);

    const bootstrapped = await api('/auth/admin-bootstrap', account.session({
      method: 'POST',
      body: JSON.stringify({ secret: env.ADMIN_BOOTSTRAP_SECRET }),
    }));
    expect(bootstrapped.response.status).toBe(200);
    expect(bootstrapped.body.user.isAdmin).toBe(true);

    // Reusable, not one-time — calling it again while already an admin is
    // still a plain success, not a 409 or similar.
    const again = await api('/auth/admin-bootstrap', account.session({
      method: 'POST',
      body: JSON.stringify({ secret: env.ADMIN_BOOTSTRAP_SECRET }),
    }));
    expect(again.response.status).toBe(200);
    expect(again.body.user.isAdmin).toBe(true);
  });

  // #1074: admin-bootstrap is the OTHER of the two routes that grant admin
  // privilege (see grant-admin's own #814 test below) -- #814's audit-trail
  // effort never actually covered this one, leaving it the one privilege-
  // escalation path with no record anywhere of when it happened or which
  // account did it.
  it('admin-bootstrap leaves a record of which account bootstrapped itself into admin', async () => {
    const account = await signupBuilder('bootstrap-log-tester');
    const bootstrapped = await api('/auth/admin-bootstrap', account.session({
      method: 'POST',
      body: JSON.stringify({ secret: env.ADMIN_BOOTSTRAP_SECRET }),
    }));
    expect(bootstrapped.response.status).toBe(200);

    const logRow = await env.DB.prepare(
      'SELECT * FROM admin_action_log WHERE action_type = ? AND target_id = ?',
    ).bind('admin_bootstrap', bootstrapped.body.user.userId).first();
    expect(logRow.admin_user_id).toBe(bootstrapped.body.user.userId);
    expect(logRow.target_type).toBe('user');
  });

  // Found via backlog audit (#360): unlike every other secret-bearing auth
  // endpoint in this file (login lockout, signup/password-reset's
  // checkRateLimit), admin-bootstrap — the one endpoint that grants admin
  // privilege — had no rate limit at all, letting a logged-in account brute
  // force ADMIN_BOOTSTRAP_SECRET with no friction. Synthetic cf-connecting-ip
  // per the sign-post/purchase rate-limit tests' own approach, so this
  // test's bucket doesn't collide with the shared-admin bootstrap call in
  // beforeAll or the test above (both on the default 'unknown' IP bucket).
  it('rate-limits repeated admin-bootstrap attempts from the same client', async () => {
    const account = await signupBuilder('bootstrap-rate-limit-tester');
    const headers = { 'cf-connecting-ip': `test-${crypto.randomUUID()}` };
    for (let i = 0; i < 10; i++) {
      const attempt = await api('/auth/admin-bootstrap', account.session({
        method: 'POST', headers, body: JSON.stringify({ secret: 'guess-me' }),
      }));
      expect(attempt.response.status).toBe(403);
    }
    const limited = await api('/auth/admin-bootstrap', account.session({
      method: 'POST', headers, body: JSON.stringify({ secret: env.ADMIN_BOOTSTRAP_SECRET }),
    }));
    expect(limited.response.status).toBe(429);
  });

  it('grant-admin lets an existing admin promote another account by email, but nobody else', async () => {
    const admin = await signupBuilder('grant-admin-admin');
    await api('/auth/admin-bootstrap', admin.session({
      method: 'POST', body: JSON.stringify({ secret: env.ADMIN_BOOTSTRAP_SECRET }),
    }));

    const target = await signupBuilder('grant-admin-target');
    const meBefore = await api('/auth/me', target.session());
    expect(meBefore.body.user.isAdmin).toBe(false);

    const noSession = await api('/auth/grant-admin', {
      method: 'POST', body: JSON.stringify({ email: target.email }),
    });
    expect(noSession.response.status).toBe(401);

    const nonAdmin = await api('/auth/grant-admin', target.session({
      method: 'POST', body: JSON.stringify({ email: target.email }),
    }));
    expect(nonAdmin.response.status).toBe(403);

    const notFound = await api('/auth/grant-admin', admin.session({
      method: 'POST', body: JSON.stringify({ email: 'nobody-here@example.com' }),
    }));
    expect(notFound.response.status).toBe(404);

    const granted = await api('/auth/grant-admin', admin.session({
      method: 'POST', body: JSON.stringify({ email: target.email.toUpperCase() }),
    }));
    expect(granted.response.status).toBe(200);
    expect(granted.body.user.isAdmin).toBe(true);
    expect(granted.body.user.email).toBe(target.email);

    const meAfter = await api('/auth/me', target.session());
    expect(meAfter.body.user.isAdmin).toBe(true);

    // #814: grant-admin is privilege escalation — it must leave a record of
    // which admin granted it, not just that it happened.
    const meAdmin = await api('/auth/me', admin.session());
    const logRow = await env.DB.prepare(
      'SELECT * FROM admin_action_log WHERE action_type = ? AND target_id = ?',
    ).bind('grant_admin', granted.body.user.userId).first();
    expect(logRow.admin_user_id).toBe(meAdmin.body.user.userId);
    expect(logRow.target_type).toBe('user');
    expect(JSON.parse(logRow.detail_json)).toEqual({ granteeEmail: target.email });
  });

  it('lists admins for any admin session, but nobody else, without leaking non-admin fields', async () => {
    const admin = await signupBuilder('list-admins-admin');
    await api('/auth/admin-bootstrap', admin.session({
      method: 'POST', body: JSON.stringify({ secret: env.ADMIN_BOOTSTRAP_SECRET }),
    }));
    const adminUserId = (await api('/auth/me', admin.session())).body.user.userId;
    const nonAdmin = await signupBuilder('list-admins-nonadmin');
    const nonAdminUserId = (await api('/auth/me', nonAdmin.session())).body.user.userId;

    const noSession = await api('/auth/admins');
    expect(noSession.response.status).toBe(401);

    const asNonAdmin = await api('/auth/admins', nonAdmin.session());
    expect(asNonAdmin.response.status).toBe(403);

    const asAdmin = await api('/auth/admins', admin.session());
    expect(asAdmin.response.status).toBe(200);
    const listed = asAdmin.body.admins.find((a) => a.userId === adminUserId);
    expect(listed).toBeTruthy();
    expect(listed.email).toBe(admin.email);
    expect(Object.keys(listed).sort()).toEqual(['createdAt', 'email', 'userId', 'username']);
    expect(asAdmin.body.admins.some((a) => a.userId === nonAdminUserId)).toBe(false);
  });

  it('rejects signup with an already-registered email, case-insensitively', async () => {
    const email = `auth-dupe-${crypto.randomUUID()}@example.com`;
    await signup(email, 'first password here');
    const dupe = await signup(email.toUpperCase(), 'second password here');
    expect(dupe.response.status).toBe(409);
  });

  // Issue #200 (owner decision): "+tag" sub-addressing is a de facto
  // standard most major providers honor, not a Gmail-only quirk, so it's
  // stripped for every domain — one real inbox can't back unlimited
  // accounts by cycling through fresh tags.
  it('rejects a "+tag" variant of an already-registered email, regardless of domain', async () => {
    const base = crypto.randomUUID();
    const email = `auth-plus-${base}@example.com`;
    await signup(email, 'first password here');
    const dupe = await signup(`auth-plus-${base}+anything@example.com`, 'second password here');
    expect(dupe.response.status).toBe(409);
  });

  // Gmail's dot-insensitivity ("first.last" and "firstlast" are the same
  // inbox) is genuinely Gmail-specific — no other mainstream provider
  // folds dots this way — so this only applies to gmail.com/googlemail.com.
  it('rejects a dotted variant of an already-registered gmail.com email', async () => {
    const base = crypto.randomUUID().replace(/-/g, '');
    await signup(`auth.dots.${base}@gmail.com`, 'first password here');
    const dupe = await signup(`authdots${base}@gmail.com`, 'second password here');
    expect(dupe.response.status).toBe(409);
  });

  // The flip side of the above: dot-folding must NOT apply to a non-Gmail
  // domain, where two dotted variants are genuinely different addresses
  // (and, in practice, almost always different real inboxes) — a blanket
  // dot-fold would incorrectly block legitimate distinct signups.
  it('does NOT fold dots on a non-Gmail domain — dotted variants are distinct accounts', async () => {
    const base = crypto.randomUUID().replace(/-/g, '');
    const first = await signup(`auth.dots.${base}@example.com`, 'first password here');
    expect(first.response.status).toBe(201);
    const second = await signup(`authdots${base}@example.com`, 'second password here');
    expect(second.response.status).toBe(201);
  });

  it('an already-registered "+tag" account (created before #200) still logs in by its exact literal address', async () => {
    const base = crypto.randomUUID();
    const email = `auth-legacy-plus-${base}+test1@example.com`;
    await signup(email, 'a fine long password here');
    const loggedIn = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'a fine long password here' }),
    });
    expect(loggedIn.response.status).toBe(200);
  });

  it('accepts only one of two concurrent signups for "+tag" variants of the same email, not both', async () => {
    const base = crypto.randomUUID();
    // Fired together, not awaited one at a time — a read-then-insert
    // implementation could let both requests read "no existing account"
    // and both land as separate rows for what should collide as one
    // canonical email (#200, same race shape as #259's friendships fix).
    const [first, second] = await Promise.all([
      signup(`auth-plus-race-${base}+a@example.com`, 'first password here'),
      signup(`auth-plus-race-${base}+b@example.com`, 'second password here'),
    ]);
    expect([first.response.status, second.response.status].sort()).toEqual([201, 409]);
  });

  it('rate-limits repeated signup attempts against the same email', async () => {
    const email = `auth-ratelimit-signup-${crypto.randomUUID()}@example.com`;
    // Bucketed by client IP *and* target email (see "Rate limiting" in
    // docs/API.md) — a shared synthetic IP here is what makes repeated
    // attempts against the same email actually accumulate against one
    // bucket, since api()'s own default is a fresh random IP per call.
    const headers = { 'cf-connecting-ip': `test-${crypto.randomUUID()}` };
    // First succeeds; the next 4 hit the ordinary "already registered" 409
    // (still counted against the limit — checkRateLimit runs before that
    // check) — 5 total attempts, right at the limit.
    for (let i = 0; i < 5; i++) {
      const attempt = await api('/auth/signup', { method: 'POST', headers, body: JSON.stringify({ email, password: 'a fine long password', username: `user-${crypto.randomUUID().slice(0, 8)}` }) });
      expect(attempt.response.status).not.toBe(429);
    }
    const sixth = await api('/auth/signup', { method: 'POST', headers, body: JSON.stringify({ email, password: 'a fine long password', username: `user-${crypto.randomUUID().slice(0, 8)}` }) });
    expect(sixth.response.status).toBe(429);

    // A different email from the same (test-env) client isn't affected —
    // bucketed per-target, not just per-source.
    const otherEmail = `auth-ratelimit-signup-other-${crypto.randomUUID()}@example.com`;
    const otherAttempt = await signup(otherEmail, 'a fine long password');
    expect(otherAttempt.response.status).toBe(201);
  });

  it('rejects signup with a malformed email or too-short password', async () => {
    const badEmail = await signup('not-an-email', 'a fine long password');
    expect(badEmail.response.status).toBe(400);

    const shortPassword = await signup(`auth-short-${crypto.randomUUID()}@example.com`, 'short1');
    expect(shortPassword.response.status).toBe(400);
  });

  // #556 (docs/SPEC.md §6): registration requires age attestation, and a
  // fresh account starts at trust_tier 'none' until a credit card (or,
  // once #589 lands, government-ID verification) raises it.
  it('rejects signup without age attestation, and records the default trust tier', async () => {
    const unattested = await api('/auth/signup', {
      method: 'POST',
      body: JSON.stringify({
        email: `auth-noage-${crypto.randomUUID()}@example.com`,
        password: 'a fine long password',
        username: `user-${crypto.randomUUID().slice(0, 8)}`,
        ageAttested: false,
      }),
    });
    expect(unattested.response.status).toBe(400);

    const attested = await signup(`auth-age-${crypto.randomUUID()}@example.com`, 'a fine long password');
    expect(attested.response.status).toBe(201);
    expect(attested.body.user).toMatchObject({ ageAttested: true, trustTier: 'none', cardFunding: null });
  });

  // #556: now that assertVerified actually gates real activity on
  // trust_tier, card-setup-intent/confirm-card simulate success when
  // Stripe isn't configured (same silent fallback this file already uses
  // for real-money purchases/seller payouts) rather than 503ing — a
  // deployment with no Stripe keys at all still needs a way to clear the
  // gate. Still requires a real session either way.
  it('simulates card-setup-intent/confirm-card when Stripe is not configured in this test suite, still gated behind a session', async () => {
    const noSession = await api('/auth/card-setup-intent', { method: 'POST' });
    expect(noSession.response.status).toBe(401);

    const builder = await signupBuilder('card-setup-simulated');
    const setupIntent = await api('/auth/card-setup-intent', builder.session({ method: 'POST' }));
    expect(setupIntent.response.status).toBe(200);
    expect(setupIntent.body).toEqual({ clientSecret: null, publishableKey: null, simulated: true });

    const confirmNoSession = await api('/auth/confirm-card', { method: 'POST' });
    expect(confirmNoSession.response.status).toBe(401);

    const confirmed = await api('/auth/confirm-card', builder.session({ method: 'POST' }));
    expect(confirmed.response.status).toBe(200);
    expect(confirmed.body.user).toMatchObject({ trustTier: 'credit_card', cardFunding: 'credit' });
  });

  // #954: trust_tier is a one-way ratchet elsewhere in this file (see the
  // "already ID-verified" didit-verification-session test above) --
  // confirm-card firing again for an already-id_verified account (a stale
  // tab, a retried flow, a direct API call) must not regress it back down
  // to credit_card.
  it('does not downgrade an already ID-verified account back to credit_card on confirm-card', async () => {
    const builder = await signupBuilder('confirm-card-no-downgrade');
    await env.DB.prepare('UPDATE users SET trust_tier = \'id_verified\' WHERE email = ?').bind(builder.email).run();

    const confirmed = await api('/auth/confirm-card', builder.session({ method: 'POST' }));
    expect(confirmed.response.status).toBe(200);
    expect(confirmed.body.user).toMatchObject({ trustTier: 'id_verified', cardFunding: 'credit' });
  });

  // #948: both endpoints make a real outbound Stripe API call whenever
  // Stripe is configured, unlike every other authenticated mutation in
  // this file, which is always rate-limited. checkRateLimit is placed
  // ahead of the stripeConfigured check (same as #839's own precedent for
  // handlePurchaseFinalize), so it fires even along the simulated-success
  // path this suite always takes — every one of these 20 calls still
  // succeeds (simulated), the point is that the limiter is what eventually
  // returns 429, not Stripe config.
  it('rate-limits repeated card-setup-intent calls from the same session', async () => {
    const builder = await signupBuilder('card-setup-rate-limit');
    for (let i = 0; i < 20; i++) {
      const attempt = await api('/auth/card-setup-intent', builder.session({ method: 'POST' }));
      expect(attempt.response.status).toBe(200);
    }
    const limited = await api('/auth/card-setup-intent', builder.session({ method: 'POST' }));
    expect(limited.response.status).toBe(429);
  });

  it('rate-limits repeated confirm-card calls from the same session', async () => {
    const builder = await signupBuilder('confirm-card-rate-limit');
    for (let i = 0; i < 20; i++) {
      const attempt = await api('/auth/confirm-card', builder.session({ method: 'POST' }));
      expect(attempt.response.status).toBe(200);
    }
    const limited = await api('/auth/confirm-card', builder.session({ method: 'POST' }));
    expect(limited.response.status).toBe(429);
  });

  // #556, owner decision (Control Room, 2026-09-09): "force everyone
  // through the new gates, no grandfathering in" — assertVerified in
  // worker/index.js's requireSessionBuilder/requireSessionSeller applies
  // to every session, not just newly created ones.
  it('blocks builder actions behind age attestation + credit-card verification, not just a session', async () => {
    const email = `auth-unverified-${crypto.randomUUID()}@example.com`;
    const signedUp = await api('/auth/signup', {
      method: 'POST',
      body: JSON.stringify({
        email, password: 'a fine long password', username: `user-${crypto.randomUUID().slice(0, 8)}`, ageAttested: true,
      }),
    });
    expect(signedUp.response.status).toBe(201);
    const session = (options) => withSession(extractSessionCookie(signedUp.response), options);

    const me = await api('/builders/me', session());
    const builderId = me.body.builder.builderId;

    const blocked = await api(`/builders/${builderId}`, session({
      method: 'PATCH',
      body: JSON.stringify({ label: 'Should be blocked' }),
    }));
    expect(blocked.response.status).toBe(403);
    expect(blocked.body.verificationRequired).toBe(true);

    const confirmed = await api('/auth/confirm-card', session({ method: 'POST' }));
    expect(confirmed.response.status).toBe(200);

    const allowed = await api(`/builders/${builderId}`, session({
      method: 'PATCH',
      body: JSON.stringify({ label: 'Now allowed' }),
    }));
    expect(allowed.response.status).toBe(200);
  });

  // Covers an account created before #556 added age attestation at all —
  // migrations/0074 leaves every pre-existing row's age_attested_at NULL,
  // and there's no way back into the signup flow to set it.
  it('lets an existing session self-attest age after the fact, idempotently', async () => {
    const builder = await signupBuilder('preexisting-account');
    await env.DB.prepare(
      "UPDATE users SET age_attested_at = NULL WHERE user_id = (SELECT user_id FROM builders WHERE builder_id = ?)",
    ).bind(builder.builderId).run();

    const noSession = await api('/auth/age-attest', { method: 'POST', body: JSON.stringify({ ageAttested: true }) });
    expect(noSession.response.status).toBe(401);

    const declined = await api('/auth/age-attest', builder.session({
      method: 'POST', body: JSON.stringify({ ageAttested: false }),
    }));
    expect(declined.response.status).toBe(400);

    // Still blocked on age attestation even though the test-helper's own
    // signup() shortcut already stamped trust_tier — both halves of
    // assertVerified are required.
    const blocked = await api(`/builders/${builder.builderId}`, builder.session({
      method: 'PATCH', body: JSON.stringify({ label: 'Blocked' }),
    }));
    expect(blocked.response.status).toBe(403);

    const attested = await api('/auth/age-attest', builder.session({
      method: 'POST', body: JSON.stringify({ ageAttested: true }),
    }));
    expect(attested.response.status).toBe(200);
    expect(attested.body.user.ageAttested).toBe(true);

    const again = await api('/auth/age-attest', builder.session({
      method: 'POST', body: JSON.stringify({ ageAttested: true }),
    }));
    expect(again.response.status).toBe(200);

    const allowed = await api(`/builders/${builder.builderId}`, builder.session({
      method: 'PATCH', body: JSON.stringify({ label: 'Allowed' }),
    }));
    expect(allowed.response.status).toBe(200);
  });

  // #589 (sub-issue of #556): government-ID verification via Didit, the
  // higher trust tier. Same never-configured-in-tests shape as Stripe
  // above — DIDIT_API_KEY/DIDIT_WEBHOOK_SECRET are never set in this
  // suite, so every path that would make a real Didit call instead 503s
  // before attempting one.
  it('gates didit-verification-session behind a session, then 503s once past that since Didit is never configured in this test suite', async () => {
    const noSession = await api('/auth/didit-verification-session', { method: 'POST' });
    expect(noSession.response.status).toBe(401);

    const builder = await signupBuilder('didit-session-503');
    const notConfigured = await api('/auth/didit-verification-session', builder.session({ method: 'POST' }));
    expect(notConfigured.response.status).toBe(503);
  });

  it('rejects starting a new didit-verification-session for an already ID-verified account, even with Didit unconfigured', async () => {
    const builder = await signupBuilder('didit-already-verified');
    await env.DB.prepare('UPDATE users SET trust_tier = \'id_verified\' WHERE email = ?').bind(builder.email).run();
    const rejected = await api('/auth/didit-verification-session', builder.session({ method: 'POST' }));
    expect(rejected.response.status).toBe(400);
  });

  it('reports "none" for didit-verification-status with no session ever started, and "approved" once trust_tier is id_verified — without ever needing Didit configured', async () => {
    const builder = await signupBuilder('didit-status');
    const noSession = await api('/auth/didit-verification-status');
    expect(noSession.response.status).toBe(401);

    const none = await api('/auth/didit-verification-status', builder.session());
    expect(none.response.status).toBe(200);
    expect(none.body).toEqual({ status: 'none' });

    await env.DB.prepare('UPDATE users SET trust_tier = \'id_verified\' WHERE email = ?').bind(builder.email).run();
    const approved = await api('/auth/didit-verification-status', builder.session());
    expect(approved.response.status).toBe(200);
    expect(approved.body).toEqual({ status: 'approved' });
  });

  it('reports the recorded status for a processed (non-pending) didit_verification_sessions row without calling out to Didit', async () => {
    const builder = await signupBuilder('didit-status-declined');
    await env.DB.prepare(`
      INSERT INTO didit_verification_sessions (session_id, user_id, status, processed_at)
      VALUES (?, (SELECT user_id FROM users WHERE email = ?), 'declined', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `).bind(`sess-${crypto.randomUUID()}`, builder.email).run();
    const declined = await api('/auth/didit-verification-status', builder.session());
    expect(declined.response.status).toBe(200);
    expect(declined.body).toEqual({ status: 'declined' });
  });

  it('reports "pending" for a still-pending session when Didit is unconfigured, rather than attempting a reconciliation call', async () => {
    const builder = await signupBuilder('didit-status-pending');
    await env.DB.prepare(`
      INSERT INTO didit_verification_sessions (session_id, user_id, status)
      VALUES (?, (SELECT user_id FROM users WHERE email = ?), 'pending')
    `).bind(`sess-${crypto.randomUUID()}`, builder.email).run();
    const pending = await api('/auth/didit-verification-status', builder.session());
    expect(pending.response.status).toBe(200);
    expect(pending.body).toEqual({ status: 'pending' });
  });

  it('gates the didit-webhook endpoint behind a configured secret', async () => {
    const unconfigured = await api('/auth/didit-webhook', {
      method: 'POST',
      body: JSON.stringify({ session_id: 'sess_does_not_exist', status: 'Approved' }),
    });
    expect(unconfigured.response.status).toBe(503);
  });

  // #766: same never-configured-in-tests shape as the didit-webhook gate
  // just above — STRIPE_WEBHOOK_SECRET is never set in this suite (only in
  // worker/stripe-webhook.test.js's own isolated file), so this proves the
  // endpoint 503s before ever attempting signature verification.
  it('gates the stripe-webhook endpoint behind a configured secret', async () => {
    const unconfigured = await api('/auth/stripe-webhook', {
      method: 'POST',
      body: JSON.stringify({ type: 'account.updated', data: { object: { id: 'acct_does_not_exist' } } }),
    });
    expect(unconfigured.response.status).toBe(503);
  });

  it('normalizes email casing between signup and login', async () => {
    const email = `Auth-Case-${crypto.randomUUID()}@Example.com`;
    await signup(email, 'a fine long password');
    const loggedIn = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: email.toLowerCase(), password: 'a fine long password' }),
    });
    expect(loggedIn.response.status).toBe(200);
  });

  it('rejects login with the wrong password or an unknown email, identically', async () => {
    const email = `auth-wrongpw-${crypto.randomUUID()}@example.com`;
    await signup(email, 'the real password');

    const wrongPassword = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'not the real password' }),
    });
    const unknownEmail = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: `auth-nobody-${crypto.randomUUID()}@example.com`, password: 'anything' }),
    });
    expect(wrongPassword.response.status).toBe(401);
    expect(unknownEmail.response.status).toBe(401);
    // Same message either way — telling the two apart would let an
    // attacker enumerate which emails have accounts.
    expect(wrongPassword.body.error).toBe(unknownEmail.body.error);
  });

  // #771: an identical response body isn't enough on its own — before this
  // fix, an unknown email skipped verifyPassword's real 100k-iteration
  // PBKDF2 derivation entirely (a near-instant D1 row-miss), while a wrong
  // password on a real account always paid that cost, so response latency
  // alone let an attacker enumerate registered emails. Measures wall-clock
  // time in-process via SELF.fetch (no real network jitter to contend
  // with), averaged over several samples to smooth out scheduling noise,
  // with a generous ratio bound rather than a tight absolute one so this
  // doesn't flake on a slower CI runner.
  it('takes roughly as long to reject an unknown email as a wrong password, not just the same response body', async () => {
    const email = `auth-timing-${crypto.randomUUID()}@example.com`;
    await signup(email, 'the real password');

    async function timeLoginAttempt(body) {
      const start = performance.now();
      await api('/auth/login', { method: 'POST', body: JSON.stringify(body) });
      return performance.now() - start;
    }

    // Warm-up call, discarded — first WebCrypto/PBKDF2 invocation in a
    // fresh isolate can be slower than steady-state.
    await timeLoginAttempt({ email, password: 'not the real password' });

    const SAMPLES = 5;
    let wrongPasswordTotalMs = 0;
    let unknownEmailTotalMs = 0;
    for (let i = 0; i < SAMPLES; i += 1) {
      wrongPasswordTotalMs += await timeLoginAttempt({ email, password: 'not the real password' });
      unknownEmailTotalMs += await timeLoginAttempt({
        email: `auth-nobody-${crypto.randomUUID()}@example.com`, password: 'anything',
      });
    }
    const wrongPasswordAvgMs = wrongPasswordTotalMs / SAMPLES;
    const unknownEmailAvgMs = unknownEmailTotalMs / SAMPLES;
    // Pre-fix this ratio is roughly 10-50x (PBKDF2 vs. an instant row
    // miss); post-fix both pay the same cost. A 3x floor catches the
    // real bug with room for jitter.
    expect(unknownEmailAvgMs).toBeGreaterThan(wrongPasswordAvgMs / 3);
  });

  it('locks the account after repeated failed logins, even with the correct password', async () => {
    const email = `auth-lockout-${crypto.randomUUID()}@example.com`;
    const password = 'the real correct password';
    await signup(email, password);

    for (let i = 0; i < 5; i++) {
      const attempt = await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password: 'wrong every time' }),
      });
      expect(attempt.response.status).toBe(401);
    }

    const lockedOut = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    expect(lockedOut.response.status).toBe(423);
  });

  it('increments failed_login_attempts atomically in SQL, not from a stale application-level read', async () => {
    // The bug this guards against only shows up under real concurrency
    // (two requests both reading the same stale failed_login_attempts
    // before either writes back) -- this test pool's single-threaded
    // workerd runtime can't force that genuine interleaving, the same
    // limitation noted on the refund double-spend regression test above.
    // What's checked here instead: the atomic `failed_login_attempts + 1`
    // SQL expression (and its CASE-based lockout threshold) is correct on
    // its own terms, one attempt at a time, starting from a
    // pre-seeded non-zero count -- the exact expression that makes
    // concurrent requests safe, rather than the concurrency itself.
    const email = `auth-lockout-atomic-${crypto.randomUUID()}@example.com`;
    const password = 'the real correct password';
    const signedUp = await signup(email, password);
    await env.DB.prepare(
      'UPDATE users SET failed_login_attempts = 4 WHERE user_id = ?',
    ).bind(signedUp.body.user.userId).run();

    const fifthFailure = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'wrong' }),
    });
    expect(fifthFailure.response.status).toBe(401);

    const row = await env.DB.prepare(
      'SELECT failed_login_attempts, locked_until FROM users WHERE user_id = ?',
    ).bind(signedUp.body.user.userId).first();
    expect(row.failed_login_attempts).toBe(5);
    expect(row.locked_until).toBeTruthy();

    const lockedOut = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    expect(lockedOut.response.status).toBe(423);
  });

  // #833: unlike every sibling auth endpoint, login had no per-IP rate
  // limit at all — only the per-account lockout above, which does nothing
  // to stop spraying one password across many different emails from the
  // same IP. Bucketed by IP alone (not ip+email like signup/password-reset),
  // so a fresh email per attempt still hits the same shared bucket.
  it('rate-limits repeated login attempts from the same IP across different emails', async () => {
    const headers = { 'cf-connecting-ip': `test-${crypto.randomUUID()}` };
    for (let i = 0; i < 10; i++) {
      const attempt = await api('/auth/login', {
        method: 'POST',
        headers,
        body: JSON.stringify({ email: `login-rate-limit-${i}@example.com`, password: 'anything' }),
      });
      expect(attempt.response.status).not.toBe(429);
    }
    const limited = await api('/auth/login', {
      method: 'POST',
      headers,
      body: JSON.stringify({ email: 'login-rate-limit-final@example.com', password: 'anything' }),
    });
    expect(limited.response.status).toBe(429);
  });

  it('verifies email with a valid token, and rejects an invalid or reused one', async () => {
    const email = `auth-verify-${crypto.randomUUID()}@example.com`;
    const signedUp = await signup(email, 'a fine long password');
    const token = new URL(signedUp.body.devVerifyUrl, 'https://higglehaven.test').searchParams.get('verifyEmail');

    const badToken = await api('/auth/verify-email', { method: 'POST', body: JSON.stringify({ token: 'not-a-real-token' }) });
    expect(badToken.response.status).toBe(400);

    const verified = await api('/auth/verify-email', { method: 'POST', body: JSON.stringify({ token }) });
    expect(verified.response.status).toBe(200);
    expect(verified.body).toEqual({ verified: true });

    const sessionToken = extractSessionCookie(signedUp.response);
    const me = await api('/auth/me', withSession(sessionToken));
    expect(me.body.user.emailVerified).toBe(true);

    const reused = await api('/auth/verify-email', { method: 'POST', body: JSON.stringify({ token }) });
    expect(reused.response.status).toBe(400);
  });

  it('does not double-consume the same verify-email token under a concurrent race', async () => {
    const email = `auth-verify-race-${crypto.randomUUID()}@example.com`;
    const signedUp = await signup(email, 'a fine long password');
    const token = new URL(signedUp.body.devVerifyUrl, 'https://higglehaven.test').searchParams.get('verifyEmail');

    // Fired together, not awaited one at a time — a SELECT-then-UPDATE
    // implementation could let both requests read "not yet consumed" and
    // both report success, even though only one should ever win (#377).
    const [first, second] = await Promise.all([
      api('/auth/verify-email', { method: 'POST', body: JSON.stringify({ token }) }),
      api('/auth/verify-email', { method: 'POST', body: JSON.stringify({ token }) }),
    ]);
    expect([first.response.status, second.response.status].sort()).toEqual([200, 400]);
  });

  // #1323: unlike handleResendVerification (the token-issuing side, #363),
  // this consuming side had no rate limit at all — a repeatable,
  // unauthenticated, always-does-a-DB-read-per-call endpoint. Same
  // invalid-token-every-time shape as the login rate-limit test above,
  // since a distinct real token per attempt isn't needed to exercise the
  // bucket.
  it('rate-limits repeated verify-email attempts from the same IP', async () => {
    const headers = { 'cf-connecting-ip': `test-${crypto.randomUUID()}` };
    for (let i = 0; i < 20; i++) {
      const attempt = await api('/auth/verify-email', {
        method: 'POST',
        headers,
        body: JSON.stringify({ token: `not-a-real-token-${i}` }),
      });
      expect(attempt.response.status).not.toBe(429);
    }
    const limited = await api('/auth/verify-email', {
      method: 'POST',
      headers,
      body: JSON.stringify({ token: 'not-a-real-token-final' }),
    });
    expect(limited.response.status).toBe(429);
  });

  it('resets a forgotten password via a real token, and signs out every existing session', async () => {
    const email = `auth-reset-${crypto.randomUUID()}@example.com`;
    const oldPassword = 'the original password';
    const newPassword = 'a brand new password';
    const signedUp = await signup(email, oldPassword);
    const oldSessionToken = extractSessionCookie(signedUp.response);

    const requested = await api('/auth/request-password-reset', { method: 'POST', body: JSON.stringify({ email }) });
    expect(requested.response.status).toBe(200);
    expect(requested.body.requested).toBe(true);
    const token = new URL(requested.body.devResetUrl, 'https://higglehaven.test').searchParams.get('resetPassword');

    const badToken = await api('/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token: 'not-a-real-token', newPassword }),
    });
    expect(badToken.response.status).toBe(400);

    const reset = await api('/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, newPassword }) });
    expect(reset.response.status).toBe(200);
    expect(reset.body).toEqual({ reset: true });

    // The pre-reset session no longer works — resetting a password signs
    // every device out (see handleResetPassword's own comment).
    const meWithOldSession = await api('/auth/me', withSession(oldSessionToken));
    expect(meWithOldSession.response.status).toBe(200);
    expect(meWithOldSession.body.user).toBeNull();

    const loginWithOldPassword = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email, password: oldPassword }) });
    expect(loginWithOldPassword.response.status).toBe(401);

    const loginWithNewPassword = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email, password: newPassword }) });
    expect(loginWithNewPassword.response.status).toBe(200);

    // The token itself is single-use.
    const reusedToken = await api('/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, newPassword: 'yet another password' }) });
    expect(reusedToken.response.status).toBe(400);
  });

  it('does not double-consume the same reset-password token under a concurrent race', async () => {
    const email = `auth-reset-race-${crypto.randomUUID()}@example.com`;
    await signup(email, 'the original password');
    const requested = await api('/auth/request-password-reset', { method: 'POST', body: JSON.stringify({ email }) });
    const token = new URL(requested.body.devResetUrl, 'https://higglehaven.test').searchParams.get('resetPassword');

    // Same race shape as the verify-email test above (#377) — only one of
    // these two concurrent requests should ever actually reset the
    // password and sign every session out.
    const [first, second] = await Promise.all([
      api('/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, newPassword: 'password from request A' }) }),
      api('/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, newPassword: 'password from request B' }) }),
    ]);
    expect([first.response.status, second.response.status].sort()).toEqual([200, 400]);
  });

  it('#843: completing a reset invalidates any other outstanding reset link for the same account', async () => {
    const email = `auth-reset-sibling-${crypto.randomUUID()}@example.com`;
    await signup(email, 'the original password');

    // Two separate reset requests (e.g. "the first email didn't arrive"),
    // producing two distinct valid tokens for the same account.
    const requestedFirst = await api('/auth/request-password-reset', { method: 'POST', body: JSON.stringify({ email }) });
    const firstToken = new URL(requestedFirst.body.devResetUrl, 'https://higglehaven.test').searchParams.get('resetPassword');
    const requestedSecond = await api('/auth/request-password-reset', { method: 'POST', body: JSON.stringify({ email }) });
    const secondToken = new URL(requestedSecond.body.devResetUrl, 'https://higglehaven.test').searchParams.get('resetPassword');
    expect(firstToken).not.toBe(secondToken);

    // Completing the reset with the second (newer) link should invalidate
    // the first, still-unexpired one too — otherwise it could silently
    // undo this reset and re-hijack the account afterward.
    const reset = await api('/auth/reset-password', { method: 'POST', body: JSON.stringify({ token: secondToken, newPassword: 'a brand new password' }) });
    expect(reset.response.status).toBe(200);

    const reusedFirstToken = await api('/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token: firstToken, newPassword: 'attacker-chosen password' }),
    });
    expect(reusedFirstToken.response.status).toBe(400);
  });

  // #1323: same gap as verify-email's own rate limit just above, for the
  // password-reset token's consuming side.
  it('rate-limits repeated reset-password attempts from the same IP', async () => {
    const headers = { 'cf-connecting-ip': `test-${crypto.randomUUID()}` };
    for (let i = 0; i < 20; i++) {
      const attempt = await api('/auth/reset-password', {
        method: 'POST',
        headers,
        body: JSON.stringify({ token: `not-a-real-token-${i}`, newPassword: 'a fine long password' }),
      });
      expect(attempt.response.status).not.toBe(429);
    }
    const limited = await api('/auth/reset-password', {
      method: 'POST',
      headers,
      body: JSON.stringify({ token: 'not-a-real-token-final', newPassword: 'a fine long password' }),
    });
    expect(limited.response.status).toBe(429);
  });

  it('requesting a password reset for an unknown email still returns a generic success, with no dev link', async () => {
    const requested = await api('/auth/request-password-reset', {
      method: 'POST',
      body: JSON.stringify({ email: `auth-nobody-reset-${crypto.randomUUID()}@example.com` }),
    });
    expect(requested.response.status).toBe(200);
    expect(requested.body).toEqual({ requested: true });
    expect(requested.body.devResetUrl).toBeUndefined();
  });

  it('rate-limits repeated password-reset requests against the same email', async () => {
    const email = `auth-ratelimit-reset-${crypto.randomUUID()}@example.com`;
    await signup(email, 'a fine long password');
    // Same reasoning as the signup rate-limit test above — a shared
    // synthetic IP is what makes repeated attempts against this one email
    // actually accumulate against one bucket.
    const headers = { 'cf-connecting-ip': `test-${crypto.randomUUID()}` };
    for (let i = 0; i < 5; i++) {
      const attempt = await api('/auth/request-password-reset', { method: 'POST', headers, body: JSON.stringify({ email }) });
      expect(attempt.response.status).toBe(200);
    }
    const sixth = await api('/auth/request-password-reset', { method: 'POST', headers, body: JSON.stringify({ email }) });
    expect(sixth.response.status).toBe(429);
  });

  it('resends a verification email for the logged-in user, with a fresh token', async () => {
    const email = `auth-resend-${crypto.randomUUID()}@example.com`;
    const signedUp = await signup(email, 'a fine long password');
    const firstToken = new URL(signedUp.body.devVerifyUrl, 'https://higglehaven.test').searchParams.get('verifyEmail');
    const sessionToken = extractSessionCookie(signedUp.response);

    const unauthenticated = await api('/auth/resend-verification', { method: 'POST' });
    expect(unauthenticated.response.status).toBe(401);

    const resent = await api('/auth/resend-verification', withSession(sessionToken, { method: 'POST' }));
    expect(resent.response.status).toBe(200);
    const secondToken = new URL(resent.body.devVerifyUrl, 'https://higglehaven.test').searchParams.get('verifyEmail');
    expect(secondToken).not.toBe(firstToken);

    // The original token still works — resending issues an additional
    // valid token rather than invalidating the first one.
    const verifiedWithFirst = await api('/auth/verify-email', { method: 'POST', body: JSON.stringify({ token: firstToken }) });
    expect(verifiedWithFirst.response.status).toBe(200);

    const alreadyVerified = await api('/auth/resend-verification', withSession(sessionToken, { method: 'POST' }));
    expect(alreadyVerified.response.status).toBe(400);
  });

  // #363: previously had no rate limit at all — a logged-in user could loop
  // this endpoint to burn the operator's real Resend email quota.
  it('rate-limits repeated resend-verification requests for the same user', async () => {
    const email = `auth-ratelimit-resend-${crypto.randomUUID()}@example.com`;
    const signedUp = await signup(email, 'a fine long password');
    const sessionToken = extractSessionCookie(signedUp.response);

    for (let i = 0; i < 5; i++) {
      const attempt = await api('/auth/resend-verification', withSession(sessionToken, { method: 'POST' }));
      expect(attempt.response.status).toBe(200);
    }
    const sixth = await api('/auth/resend-verification', withSession(sessionToken, { method: 'POST' }));
    expect(sixth.response.status).toBe(429);
  });

  it('signup automatically provisions a linked builder profile', async () => {
    const email = `auth-builder-${crypto.randomUUID()}@example.com`;
    const signedUp = await signup(email, 'a fine long password', { username: 'Ada Builder' });
    const sessionToken = extractSessionCookie(signedUp.response);

    const myBuilder = await api('/builders/me', withSession(sessionToken));
    expect(myBuilder.response.status).toBe(200);
    expect(myBuilder.body.builder.label).toBe('Ada Builder');
    expect(myBuilder.body.builder.builderId).toMatch(/^builder-/);

    // Idempotent — the same profile every time, not a new one per call.
    const myBuilderAgain = await api('/builders/me', withSession(sessionToken));
    expect(myBuilderAgain.body.builder.builderId).toBe(myBuilder.body.builder.builderId);
  });

  it('rejects signup with a missing username, or one already taken (case-insensitively)', async () => {
    const noUsername = await api('/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ email: `auth-nouser-${crypto.randomUUID()}@example.com`, password: 'a fine long password' }),
    });
    expect(noUsername.response.status).toBe(400);

    const takenUsername = `taken-${crypto.randomUUID().slice(0, 8)}`;
    await signup(`auth-uname-a-${crypto.randomUUID()}@example.com`, 'a fine long password', { username: takenUsername });
    const dupe = await signup(
      `auth-uname-b-${crypto.randomUUID()}@example.com`,
      'a fine long password',
      { username: takenUsername.toUpperCase() },
    );
    expect(dupe.response.status).toBe(409);
  });

  it('/builders/me requires a session', async () => {
    const response = await api('/builders/me');
    expect(response.response.status).toBe(401);
  });

  it('lazily provisions a linked seller profile on first access, not at signup', async () => {
    const email = `auth-seller-${crypto.randomUUID()}@example.com`;
    const signedUp = await signup(email, 'a fine long password', { username: 'Ada Seller' });
    const sessionToken = extractSessionCookie(signedUp.response);

    const mySeller = await api('/sellers/me', withSession(sessionToken));
    expect(mySeller.response.status).toBe(200);
    expect(mySeller.body.seller.label).toBe('Ada Seller');
    expect(mySeller.body.seller.sellerId).toMatch(/^seller-/);

    const mySellerAgain = await api('/sellers/me', withSession(sessionToken));
    expect(mySellerAgain.body.seller.sellerId).toBe(mySeller.body.seller.sellerId);
  });

  it('/sellers/me requires a session', async () => {
    const response = await api('/sellers/me');
    expect(response.response.status).toBe(401);
  });
});
