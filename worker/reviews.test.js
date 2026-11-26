// #4520: this file and worker/auth.test.js used to be one file, worker/reviews-auth.test.js (126
// tests, ~650 s). A single worker test file shares one D1 instance (see vitest.config.js's testTimeout
// comment, #385), and in that one big file every request got slower as the file went on: the same
// rate-limit test took 89 ms on its own, about 0.6 s alone with the tests around it, and 15 s late in
// the whole file, so the explicit per-test timeouts (#978, #2157, #2198, #2208) were being bumped again and
// again and still failed under load. Split at the describe boundary (nothing else changed: the tests,
// helpers and timeouts are byte for byte what they were), each half runs on a fresh D1 instance.
// The product-review tests are here; the authentication tests are in worker/auth.test.js.
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
    // #2388: the anonymous/orphaned-template delete path now requires a
    // removal category too.
    await api(`/catalog/${templateId}/reviews/${first.body.review.reviewId}`, {
      method: 'DELETE', body: JSON.stringify({ category: 'other' }),
    });
    const third = await api(`/catalog/${templateId}/reviews`, shopper.session({
      method: 'POST',
      body: JSON.stringify({ rating: 2 }),
    }));
    expect(third.response.status).toBe(201);
  });

  // #2422: same "network blip, then a retry with the same key" protection
  // bundles/sign-posts/calendar-events/direct-messages already have --
  // without it, a retry hits the eligibility check a successful first
  // attempt already consumed (the purchase is no longer eligible once
  // reviewed), either 400ing on a request that actually already
  // succeeded, or -- the worse case tested just below -- silently
  // creating a second, distinct review against a different eligible
  // purchase.
  it('does not create a duplicate review when the same idempotencyKey is retried', async () => {
    const templateId = await createTemplate('review-idempotency');
    const shopper = await signupBuilder('review-idempotency-shopper');
    await createPurchase(templateId, shopper);

    const first = await api(`/catalog/${templateId}/reviews`, shopper.session({
      method: 'POST', body: JSON.stringify({ rating: 5, text: 'Great!', idempotencyKey: 'retry-test-key' }),
    }));
    expect(first.response.status).toBe(201);

    const retried = await api(`/catalog/${templateId}/reviews`, shopper.session({
      method: 'POST', body: JSON.stringify({ rating: 5, text: 'Great!', idempotencyKey: 'retry-test-key' }),
    }));
    expect(retried.response.status).toBe(200);
    expect(retried.body.review.reviewId).toBe(first.body.review.reviewId);

    const listed = await api(`/catalog/${templateId}/reviews`);
    expect(listed.body.reviews).toHaveLength(1);
  });

  // The worse failure mode a bare eligibility-order fix wouldn't catch: a
  // shopper with TWO unreviewed purchases of the same product retries
  // their first review submission -- without idempotency dedup, the
  // eligibility SELECT would simply pick the second purchase instead of
  // returning the first review, silently creating an unintended second
  // review nobody asked for.
  it('returns the original review on retry rather than reviewing a second eligible purchase', async () => {
    const templateId = await createTemplate('review-idempotency-second-purchase');
    const shopper = await signupBuilder('review-idem-2nd-purchase-shopper');
    await createPurchase(templateId, shopper);
    await createPurchase(templateId, shopper);

    const first = await api(`/catalog/${templateId}/reviews`, shopper.session({
      method: 'POST', body: JSON.stringify({ rating: 4, text: 'Solid.', idempotencyKey: 'retry-second-purchase-key' }),
    }));
    expect(first.response.status).toBe(201);

    const retried = await api(`/catalog/${templateId}/reviews`, shopper.session({
      method: 'POST', body: JSON.stringify({ rating: 4, text: 'Solid.', idempotencyKey: 'retry-second-purchase-key' }),
    }));
    expect(retried.response.status).toBe(200);
    expect(retried.body.review.reviewId).toBe(first.body.review.reviewId);

    const listed = await api(`/catalog/${templateId}/reviews`);
    expect(listed.body.reviews).toHaveLength(1);
  });

  // A genuinely different second submission (different content, even
  // under the same stale key) must still go through normally -- this
  // isn't a dedup-everything guard, only same-key-same-content retries,
  // same convention bundles' own idempotency key test (#1873) establishes.
  it('treats a same-key resubmit with different content as a genuinely new review attempt', async () => {
    const templateId = await createTemplate('review-idempotency-content-mismatch');
    const shopper = await signupBuilder('review-idem-content-mismatch-shopper');
    await createPurchase(templateId, shopper);
    await createPurchase(templateId, shopper);

    const first = await api(`/catalog/${templateId}/reviews`, shopper.session({
      method: 'POST', body: JSON.stringify({ rating: 5, text: 'First take.', idempotencyKey: 'mismatch-key' }),
    }));
    expect(first.response.status).toBe(201);

    const second = await api(`/catalog/${templateId}/reviews`, shopper.session({
      method: 'POST', body: JSON.stringify({ rating: 1, text: 'Changed my mind.', idempotencyKey: 'mismatch-key' }),
    }));
    expect(second.response.status).toBe(201);
    expect(second.body.review.reviewId).not.toBe(first.body.review.reviewId);

    const listed = await api(`/catalog/${templateId}/reviews`);
    expect(listed.body.reviews).toHaveLength(2);
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

    // #2388: the anonymous/orphaned-template delete path now requires a
    // removal category too.
    const deleted = await api(`/catalog/${templateId}/reviews/${secondReview.body.review.reviewId}`, {
      method: 'DELETE', body: JSON.stringify({ category: 'other' }),
    });
    expect(deleted.response.status).toBe(200);
    expect(deleted.body).toEqual({ deleted: true });

    const listedAfterDelete = await api(`/catalog/${templateId}/reviews`);
    expect(listedAfterDelete.body.reviews).toHaveLength(1);
    expect(listedAfterDelete.body.averageRating).toBe(5);

    const deleteMissing = await api(`/catalog/${templateId}/reviews/${secondReview.body.review.reviewId}`, {
      method: 'DELETE', body: JSON.stringify({ category: 'other' }),
    });
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
        priceCents: 500,
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

    // #2388: the seller-moderation delete now requires a removal category.
    const missingCategory = await api(`/catalog/${templateId}/reviews/${reviewId}`, seller.session({ method: 'DELETE' }));
    expect(missingCategory.response.status).toBe(415);

    const deleted = await api(`/catalog/${templateId}/reviews/${reviewId}`, seller.session({
      method: 'DELETE', body: JSON.stringify({ category: 'spam' }),
    }));
    expect(deleted.response.status).toBe(200);
    expect(deleted.body).toEqual({ deleted: true });

    const snapshot = await env.DB.prepare(
      'SELECT * FROM moderation_removal_snapshots WHERE source_table = ? AND source_id = ?',
    ).bind('product_reviews', reviewId).first();
    expect(snapshot).not.toBeNull();
    expect(snapshot.removed_category).toBe('spam');
  });

  // #1712 (owner confirmed): an admin can remove any review outright --
  // harassment, doxxing, other policy violations -- even though the
  // template's own seller is reachable and active, unlike the dangling-
  // seller admin fallback mark-shipped/refund already have. Logged via
  // admin_action_log, same accountability convention as those.
  it('lets an admin delete any review outright, even when the template has a reachable owning seller', async () => {
    const seller = await signupSeller('review-admin-override-seller');
    const shopper = await signupBuilder('review-admin-override-shopper');
    const created = await api('/catalog', seller.session({
      method: 'POST',
      body: JSON.stringify({
        templateId: 'review-admin-override-owned',
        name: 'Admin-moderatable reviewable product',
        color: '#123456',
        dimensions: { width: 1, depth: 1, height: 1 },
        sellerId: seller.sellerId,
        priceCents: 500,
      }),
    }));
    expect(created.response.status).toBe(201);
    const templateId = created.body.template.templateId;
    await createPurchase(templateId, shopper);
    const posted = await api(`/catalog/${templateId}/reviews`, shopper.session({
      method: 'POST',
      body: JSON.stringify({ rating: 1, text: 'Abusive/policy-violating text goes here.' }),
    }));
    expect(posted.response.status).toBe(201);
    const reviewId = posted.body.review.reviewId;

    const asAdmin = await api(`/catalog/${templateId}/reviews/${reviewId}`, adminSession({
      method: 'DELETE', body: JSON.stringify({ category: 'harassment' }),
    }));
    expect(asAdmin.response.status).toBe(200);
    expect(asAdmin.body).toEqual({ deleted: true });

    const listedAfter = await api(`/catalog/${templateId}/reviews`);
    expect(listedAfter.body.reviews).toHaveLength(0);

    const adminUserId = (await api('/auth/me', adminSession())).body.user.userId;
    const logRow = await env.DB.prepare(
      'SELECT * FROM admin_action_log WHERE action_type = ? AND target_id = ?',
    ).bind('delete_review_override', reviewId).first();
    expect(logRow).not.toBeNull();
    expect(logRow.admin_user_id).toBe(adminUserId);
    expect(logRow.target_type).toBe('product_review');
  });

  // #1971: a concurrent delete can win the race against the admin's own
  // DELETE before it runs (another admin's click, or the owning seller's
  // own moderation path) — the loser's DELETE affects 0 rows, and must not
  // write an admin_action_log row claiming it deleted something it didn't.
  // Firing two concurrent admin DELETEs at the same review exercises this
  // directly: exactly one of them actually removes the row, so exactly one
  // admin_action_log row should ever exist for it, never two. The losing
  // attempt's own status depends on interleaving and isn't itself the bug:
  // if both existence-checks run before either DELETE, both see the row and
  // both return 200 (the loser's DELETE just affects 0 rows); if the
  // winner's full cycle finishes first, the loser's own existence check
  // finds nothing and 404s instead. Either is a correct response — the one
  // invariant this test actually guards is the log row count.
  it('logs the admin delete-override exactly once, not once per losing racer, when two deletes race the same review', async () => {
    const seller = await signupSeller('review-admin-race-seller');
    const shopper = await signupBuilder('review-admin-race-shopper');
    const created = await api('/catalog', seller.session({
      method: 'POST',
      body: JSON.stringify({
        templateId: 'review-admin-race-owned',
        name: 'Race-moderatable reviewable product',
        color: '#123456',
        dimensions: { width: 1, depth: 1, height: 1 },
        sellerId: seller.sellerId,
        priceCents: 500,
      }),
    }));
    expect(created.response.status).toBe(201);
    const templateId = created.body.template.templateId;
    await createPurchase(templateId, shopper);
    const posted = await api(`/catalog/${templateId}/reviews`, shopper.session({
      method: 'POST',
      body: JSON.stringify({ rating: 1, text: 'Abusive/policy-violating text goes here.' }),
    }));
    expect(posted.response.status).toBe(201);
    const reviewId = posted.body.review.reviewId;

    const attempts = await Promise.all(
      Array.from({ length: 2 }, () => api(`/catalog/${templateId}/reviews/${reviewId}`, adminSession({
        method: 'DELETE', body: JSON.stringify({ category: 'harassment' }),
      }))),
    );
    for (const attempt of attempts) {
      expect([200, 404]).toContain(attempt.response.status);
    }
    const succeeded = attempts.filter((attempt) => attempt.response.status === 200);
    expect(succeeded.length).toBeGreaterThanOrEqual(1);
    for (const attempt of succeeded) {
      expect(attempt.body).toEqual({ deleted: true });
    }

    const logRows = await env.DB.prepare(
      'SELECT * FROM admin_action_log WHERE action_type = ? AND target_id = ?',
    ).bind('delete_review_override', reviewId).all();
    expect(logRows.results).toHaveLength(1);
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
        priceCents: 500,
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
        priceCents: 500,
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

    // #2388: the (now-anonymous, dangling-seller) delete path still requires
    // a removal category.
    const reviewDeleted = await api(`/catalog/${templateId}/reviews/${reviewId}`, {
      method: 'DELETE', body: JSON.stringify({ category: 'other' }),
    });
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
        priceCents: 500,
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
          priceCents: 500,
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
          priceCents: 500,
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
        priceCents: 500,
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

  // #2075: PUT /catalog/batch used to run assertUploadedModelExists (up to
  // 100 real R2 bucket.head() calls) before checkRateLimit, so an
  // already-rate-limited caller still paid that full cost on every rejected
  // call. Proven here the same way the two tests above exhaust the limit,
  // then the one-past-the-limit request also carries a modelUrl that would
  // fail assertUploadedModelExists (a /uploads/models/ path nothing ever
  // uploaded to) -- if the rate limit is genuinely checked first, this still
  // 429s; if assertUploadedModelExists ran first again, it would 400 instead.
  it('checks the rate limit before assertUploadedModelExists on an already-limited batch PUT', async () => {
    const templateId = await createTemplate('catalog-batch-put-rate-limit-ordering');
    const headers = { 'cf-connecting-ip': `test-${crypto.randomUUID()}` };
    for (let i = 0; i < 20; i++) {
      const attempt = await api('/catalog/batch', {
        method: 'PUT', headers,
        body: JSON.stringify({ templates: [{
          templateId, name: 'Batch put rate limit ordering', color: '#123456',
          dimensions: { width: 1 + i * 0.01, depth: 1, height: 1 },
        }] }),
      });
      expect(attempt.response.status).not.toBe(429);
    }
    const limited = await api('/catalog/batch', {
      method: 'PUT', headers,
      body: JSON.stringify({ templates: [{
        templateId, name: 'Batch put rate limit ordering', color: '#123456',
        dimensions: { width: 9, depth: 1, height: 1 },
        modelUrl: `/uploads/models/nonexistent-${crypto.randomUUID()}.glb`,
      }] }),
    });
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
  }, 90000); // #4520: 20s -> 90s, see the note after #1511 below. #2097: same 20-iteration signupBuilder+createPurchase+POST+
  // DELETE shape (~80 real HTTP/DB operations total) as the authenticated
  // DELETE rate-limit test just below (#1511) -- this file has grown
  // enough since then that this test now hits the same 20s default too.

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
        priceCents: 500,
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
  }, 90000); // #4520: ~21 real signups (PBKDF2) is genuine work: ~15 s alone, 28-30 s with the machine at 2x load (this test timed out at 30.4 s, its old 30 s limit, in 2 of 10 loaded runs); 90s keeps a 6x margin, same reasoning as the unsuspend test's own bump. #1511: 20 iterations of signupBuilder+createPurchase+POST+
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
  }, 60000); // #4520: ~2.6x margin at 20s under load (7.6 s with the machine at 2x), same reasoning as the DELETE tests above

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

  // #3776: a review needs a purchase, and a product with a purchase is delisted
  // by a seller's delete, never hard-deleted, so its reviews (and the order that
  // names it) survive. (The reviews' ON DELETE CASCADE still covers a template
  // row removed some other way, but no API path does that to a bought product.)
  it('keeps a bought product\'s reviews when its seller deletes it, because it is delisted not deleted (#3776)', async () => {
    const templateId = await createTemplate('reviewable-product-to-delete');
    const shopper = await signupBuilder('reviewable-product-to-delete-shopper');
    await createPurchase(templateId, shopper);
    await api(`/catalog/${templateId}/reviews`, shopper.session({
      method: 'POST',
      body: JSON.stringify({ rating: 4 }),
    }));
    const deleted = await api(`/catalog/${templateId}`, { method: 'DELETE' });
    expect(deleted.body).toEqual({ deleted: true, delisted: true });

    const afterDelete = await api(`/catalog/${templateId}/reviews`);
    expect(afterDelete.response.status).toBe(200);
    expect(afterDelete.body.reviews.length).toBe(1);
  });

  // #1975 (owner decision): a review now records who actually wrote it
  // (user_id, migrations/0130), the same sign_posts.user_id pattern
  // (#1830) -- POST's own response/GET listing should surface it.
  it('records the posting session\'s own userId on a new review', async () => {
    const templateId = await createTemplate('review-userid-recorded');
    const shopper = await signupBuilder('review-userid-recorded-shopper');
    await createPurchase(templateId, shopper);
    const posted = await api(`/catalog/${templateId}/reviews`, shopper.session({
      method: 'POST',
      body: JSON.stringify({ rating: 5 }),
    }));
    expect(posted.response.status).toBe(201);
    const shopperUserId = (await env.DB.prepare('SELECT user_id FROM builders WHERE builder_id = ?')
      .bind(shopper.builderId).first()).user_id;
    expect(posted.body.review.userId).toBe(shopperUserId);

    const listed = await api(`/catalog/${templateId}/reviews`);
    expect(listed.body.reviews[0].userId).toBe(shopperUserId);
  });

  describe('Author self-edit/delete (#1975)', () => {
    async function postReview(templateId, shopper, { rating = 4, text = 'Pretty good.' } = {}) {
      const posted = await api(`/catalog/${templateId}/reviews`, shopper.session({
        method: 'POST', body: JSON.stringify({ rating, text }),
      }));
      expect(posted.response.status).toBe(201);
      return posted.body.review.reviewId;
    }

    it('lets the review\'s own author edit it directly, with no seller/admin involvement', async () => {
      const templateId = await createTemplate('review-author-edit');
      const shopper = await signupBuilder('review-author-edit-shopper');
      await createPurchase(templateId, shopper);
      const reviewId = await postReview(templateId, shopper);

      const edited = await api(`/catalog/${templateId}/reviews/${reviewId}`, shopper.session({
        method: 'PATCH', body: JSON.stringify({ rating: 2, text: 'Changed my mind.' }),
      }));
      expect(edited.response.status).toBe(200);
      expect(edited.body.review).toMatchObject({ rating: 2, text: 'Changed my mind.' });

      const listed = await api(`/catalog/${templateId}/reviews`);
      expect(listed.body.reviews[0]).toMatchObject({ rating: 2, text: 'Changed my mind.' });
    });

    it('rejects an edit from anyone other than the review\'s own author', async () => {
      const templateId = await createTemplate('review-edit-cross-account');
      const shopper = await signupBuilder('review-edit-cross-account-shopper');
      const stranger = await signupBuilder('review-edit-cross-account-stranger');
      await createPurchase(templateId, shopper);
      const reviewId = await postReview(templateId, shopper);

      const unauthenticated = await api(`/catalog/${templateId}/reviews/${reviewId}`, {
        method: 'PATCH', body: JSON.stringify({ rating: 1 }),
      });
      expect(unauthenticated.response.status).toBe(401);

      const wrongAccount = await api(`/catalog/${templateId}/reviews/${reviewId}`, stranger.session({
        method: 'PATCH', body: JSON.stringify({ rating: 1 }),
      }));
      expect(wrongAccount.response.status).toBe(403);

      const unchanged = await api(`/catalog/${templateId}/reviews`);
      expect(unchanged.body.reviews[0].rating).toBe(4);
    });

    // Omitting a field keeps its existing value; an explicitly empty
    // string for `text` clears it -- the same distinction bundles' own
    // PATCH (COALESCE-based) makes, resolved in application code here.
    it('keeps an omitted field as-is on edit, but clears text when explicitly set empty', async () => {
      const templateId = await createTemplate('review-edit-partial');
      const shopper = await signupBuilder('review-edit-partial-shopper');
      await createPurchase(templateId, shopper);
      const reviewId = await postReview(templateId, shopper, { rating: 3, text: 'Original text.' });

      const ratingOnly = await api(`/catalog/${templateId}/reviews/${reviewId}`, shopper.session({
        method: 'PATCH', body: JSON.stringify({ rating: 5 }),
      }));
      expect(ratingOnly.response.status).toBe(200);
      expect(ratingOnly.body.review).toMatchObject({ rating: 5, text: 'Original text.' });

      const clearText = await api(`/catalog/${templateId}/reviews/${reviewId}`, shopper.session({
        method: 'PATCH', body: JSON.stringify({ text: '' }),
      }));
      expect(clearText.response.status).toBe(200);
      expect(clearText.body.review).toMatchObject({ rating: 5, text: null });
    });

    it('rejects an edit with an out-of-range rating', async () => {
      const templateId = await createTemplate('review-edit-bad-rating');
      const shopper = await signupBuilder('review-edit-bad-rating-shopper');
      await createPurchase(templateId, shopper);
      const reviewId = await postReview(templateId, shopper);

      const rejected = await api(`/catalog/${templateId}/reviews/${reviewId}`, shopper.session({
        method: 'PATCH', body: JSON.stringify({ rating: 6 }),
      }));
      expect(rejected.response.status).toBe(400);
    });

    it('lets the review\'s own author delete it directly, with no seller/admin involvement', async () => {
      // A seller-owned template, not createTemplate's own unowned one --
      // an unowned template's DELETE is deliberately wide open to anyone
      // (moderation has no real owner to gate behind), which would make
      // the "wrong account" assertion below pass for an unrelated reason.
      const seller = await signupSeller('review-author-delete-seller');
      const shopper = await signupBuilder('review-author-delete-shopper');
      const stranger = await signupBuilder('review-author-delete-stranger');
      const created = await api('/catalog', seller.session({
        method: 'POST',
        body: JSON.stringify({
          templateId: 'review-author-delete-owned',
          name: 'Author-delete reviewable product',
          color: '#123456',
          dimensions: { width: 1, depth: 1, height: 1 },
          sellerId: seller.sellerId,
          priceCents: 500,
        }),
      }));
      expect(created.response.status).toBe(201);
      const templateId = created.body.template.templateId;
      await createPurchase(templateId, shopper);
      const reviewId = await postReview(templateId, shopper);

      const wrongAccount = await api(`/catalog/${templateId}/reviews/${reviewId}`, stranger.session({ method: 'DELETE' }));
      expect(wrongAccount.response.status).toBe(403);

      const deleted = await api(`/catalog/${templateId}/reviews/${reviewId}`, shopper.session({ method: 'DELETE' }));
      expect(deleted.response.status).toBe(200);
      expect(deleted.body).toEqual({ deleted: true });

      const listed = await api(`/catalog/${templateId}/reviews`);
      expect(listed.body.reviews).toHaveLength(0);
    });

    // A pre-#1975 review (user_id IS NULL, seeded directly like
    // createPurchase's own "legacy purchase" rows) has nobody on record to
    // own it -- the author-direct branches must never match it, falling
    // straight through to the existing moderation paths exactly as before.
    it('never lets a legacy review with no recorded author be claimed as anyone\'s own', async () => {
      const seller = await signupSeller('review-legacy-no-userid-seller');
      const shopper = await signupBuilder('review-legacy-no-userid-shopper');
      const created = await api('/catalog', seller.session({
        method: 'POST',
        body: JSON.stringify({
          templateId: 'review-legacy-no-userid-owned',
          name: 'Legacy-review product',
          color: '#123456',
          dimensions: { width: 1, depth: 1, height: 1 },
          sellerId: seller.sellerId,
          priceCents: 500,
        }),
      }));
      expect(created.response.status).toBe(201);
      const templateId = created.body.template.templateId;
      const reviewId = 'review-legacy-no-userid';
      await env.DB.prepare(`
        INSERT INTO product_reviews (review_id, template_id, author_label, rating, text, user_id)
        VALUES (?, ?, 'Legacy Reviewer', 3, 'Pre-#1975 review.', NULL)
      `).bind(reviewId, templateId).run();

      const editRejected = await api(`/catalog/${templateId}/reviews/${reviewId}`, shopper.session({
        method: 'PATCH', body: JSON.stringify({ rating: 1 }),
      }));
      expect(editRejected.response.status).toBe(403);

      const deleteRejectedByShopper = await api(`/catalog/${templateId}/reviews/${reviewId}`, shopper.session({ method: 'DELETE' }));
      expect(deleteRejectedByShopper.response.status).toBe(403);

      const deletedBySeller = await api(`/catalog/${templateId}/reviews/${reviewId}`, seller.session({
        method: 'DELETE', body: JSON.stringify({ category: 'other' }),
      }));
      expect(deletedBySeller.response.status).toBe(200);
    });

    it('rate-limits repeated review edits from the same account', async () => {
      const templateId = await createTemplate('review-edit-rate-limit');
      const shopper = await signupBuilder('review-edit-rate-limit-shopper');
      await createPurchase(templateId, shopper);
      const reviewId = await postReview(templateId, shopper);

      for (let i = 0; i < 20; i++) {
        const attempt = await api(`/catalog/${templateId}/reviews/${reviewId}`, shopper.session({
          method: 'PATCH', body: JSON.stringify({ rating: (i % 5) + 1 }),
        }));
        expect(attempt.response.status).not.toBe(429);
      }
      const limited = await api(`/catalog/${templateId}/reviews/${reviewId}`, shopper.session({
        method: 'PATCH', body: JSON.stringify({ rating: 1 }),
      }));
      expect(limited.response.status).toBe(429);
    }, 60000); // #4520: ~2x margin at 20s under load (10.3 s with the machine at 2x), same reasoning as the DELETE tests above

    // #1975: "Maybe we should keep a record of the original content
    // internally in case of disputes" -- every author-initiated edit/
    // delete should snapshot the pre-change row into
    // user_content_edit_history (migrations/0129) first.
    it('snapshots the pre-edit review into user_content_edit_history before applying an author edit', async () => {
      const templateId = await createTemplate('review-history-edit');
      const shopper = await signupBuilder('review-history-edit-shopper');
      await createPurchase(templateId, shopper);
      const reviewId = await postReview(templateId, shopper, { rating: 4, text: 'Before the edit.' });
      const shopperUserId = (await env.DB.prepare('SELECT user_id FROM builders WHERE builder_id = ?')
        .bind(shopper.builderId).first()).user_id;

      const edited = await api(`/catalog/${templateId}/reviews/${reviewId}`, shopper.session({
        method: 'PATCH', body: JSON.stringify({ rating: 1, text: 'After the edit.' }),
      }));
      expect(edited.response.status).toBe(200);

      const history = await env.DB.prepare(
        'SELECT * FROM user_content_edit_history WHERE source_table = ? AND source_id = ?',
      ).bind('product_reviews', reviewId).all();
      expect(history.results).toHaveLength(1);
      expect(history.results[0]).toMatchObject({ action: 'edit', actor_user_id: shopperUserId });
      const snapshot = JSON.parse(history.results[0].snapshot_json);
      expect(snapshot).toMatchObject({ review_id: reviewId, rating: 4, text: 'Before the edit.' });
    });

    it('snapshots the pre-delete review into user_content_edit_history before an author delete', async () => {
      const templateId = await createTemplate('review-history-delete');
      const shopper = await signupBuilder('review-history-delete-shopper');
      await createPurchase(templateId, shopper);
      const reviewId = await postReview(templateId, shopper, { rating: 5, text: 'About to be deleted.' });
      const shopperUserId = (await env.DB.prepare('SELECT user_id FROM builders WHERE builder_id = ?')
        .bind(shopper.builderId).first()).user_id;

      const deleted = await api(`/catalog/${templateId}/reviews/${reviewId}`, shopper.session({ method: 'DELETE' }));
      expect(deleted.response.status).toBe(200);

      const history = await env.DB.prepare(
        'SELECT * FROM user_content_edit_history WHERE source_table = ? AND source_id = ?',
      ).bind('product_reviews', reviewId).all();
      expect(history.results).toHaveLength(1);
      expect(history.results[0]).toMatchObject({ action: 'delete', actor_user_id: shopperUserId });
      const snapshot = JSON.parse(history.results[0].snapshot_json);
      expect(snapshot).toMatchObject({ review_id: reviewId, rating: 5, text: 'About to be deleted.' });
    });

    // #2122: a lost concurrency race (another request deletes the row in
    // the real gap between the eager read and this handler's own
    // UPDATE/DELETE -- same injection technique as the calendar-events
    // ownership-race test above) must not leave a false snapshot behind for
    // an edit/delete that never actually took effect -- the request itself
    // still 409s either way.
    it('does not snapshot to user_content_edit_history when an author edit loses a concurrency race', async () => {
      const templateId = await createTemplate('review-history-edit-lost-race');
      const shopper = await signupBuilder('review-history-edit-lost-race-shopper');
      await createPurchase(templateId, shopper);
      const reviewId = await postReview(templateId, shopper, { rating: 4, text: 'Before the race.' });

      const originalPrepare = env.DB.prepare.bind(env.DB);
      let armed = true;
      env.DB.prepare = (sql) => {
        if (armed && sql.includes('UPDATE product_reviews SET rating')) {
          armed = false;
          originalPrepare('DELETE FROM product_reviews WHERE review_id = ?').bind(reviewId).run();
        }
        return originalPrepare(sql);
      };
      let edited;
      try {
        edited = await api(`/catalog/${templateId}/reviews/${reviewId}`, shopper.session({
          method: 'PATCH', body: JSON.stringify({ rating: 1, text: 'After the race.' }),
        }));
      } finally {
        env.DB.prepare = originalPrepare;
      }
      expect(edited.response.status).toBe(409);

      const history = await env.DB.prepare(
        'SELECT * FROM user_content_edit_history WHERE source_table = ? AND source_id = ?',
      ).bind('product_reviews', reviewId).all();
      expect(history.results).toHaveLength(0);
    });

    it('does not snapshot to user_content_edit_history when an author delete loses a concurrency race', async () => {
      const templateId = await createTemplate('review-history-delete-lost-race');
      const shopper = await signupBuilder('review-history-delete-lost-race-shopper');
      await createPurchase(templateId, shopper);
      const reviewId = await postReview(templateId, shopper, { rating: 5, text: 'Already gone.' });

      const originalPrepare = env.DB.prepare.bind(env.DB);
      let armed = true;
      env.DB.prepare = (sql) => {
        if (armed && sql.includes('DELETE FROM product_reviews WHERE review_id = ? AND user_id = ?')) {
          armed = false;
          // The admin/orphaned-template DELETE shares no WHERE-clause text
          // with this author-only one, so this only ever fires once for the
          // author branch under test, simulating a second tab winning the
          // race first.
          originalPrepare('DELETE FROM product_reviews WHERE review_id = ?').bind(reviewId).run();
        }
        return originalPrepare(sql);
      };
      let deleted;
      try {
        deleted = await api(`/catalog/${templateId}/reviews/${reviewId}`, shopper.session({ method: 'DELETE' }));
      } finally {
        env.DB.prepare = originalPrepare;
      }
      expect(deleted.response.status).toBe(409);

      const history = await env.DB.prepare(
        'SELECT * FROM user_content_edit_history WHERE source_table = ? AND source_id = ?',
      ).bind('product_reviews', reviewId).all();
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
      const templateId = await createTemplate('review-refetch-delete-race');
      const shopper = await signupBuilder('review-refetch-delete-race-shopper');
      await createPurchase(templateId, shopper);
      const reviewId = await postReview(templateId, shopper, { rating: 4, text: 'Before the race.' });

      const originalPrepare = env.DB.prepare.bind(env.DB);
      env.DB.prepare = (sql) => {
        const stmt = originalPrepare(sql);
        if (sql === 'UPDATE product_reviews SET rating = ?, text = ? WHERE review_id = ? AND user_id = ?') {
          const originalBind = stmt.bind.bind(stmt);
          stmt.bind = (...args) => {
            const bound = originalBind(...args);
            const originalRun = bound.run.bind(bound);
            bound.run = async () => {
              const result = await originalRun();
              await originalPrepare('DELETE FROM product_reviews WHERE review_id = ?').bind(reviewId).run();
              return result;
            };
            return bound;
          };
        }
        return stmt;
      };
      let edited;
      try {
        edited = await api(`/catalog/${templateId}/reviews/${reviewId}`, shopper.session({
          method: 'PATCH', body: JSON.stringify({ rating: 1, text: 'After the race.' }),
        }));
      } finally {
        env.DB.prepare = originalPrepare;
      }
      // The real bug was an uncaught TypeError (raw 500) when the re-SELECT
      // after an already-successful UPDATE found the row already gone.
      expect(edited.response.status).toBe(404);
    });

    // #2429: same re-SELECT race #2364 fixed above for this handler's own
    // PATCH, never applied to this POST/create branch -- a concurrent
    // admin delete landing between the guarded INSERT committing and this
    // handler's own re-SELECT running used to crash with a raw 500 instead
    // of a clean 404. Wraps the INSERT statement's own run() (rather than
    // racing prepare() itself) so the DELETE only ever fires once the
    // INSERT has genuinely already landed.
    it('never crashes with a raw 500 when its own POST re-fetch loses a race to a concurrent delete', async () => {
      const templateId = await createTemplate('review-post-refetch-delete-race');
      const shopper = await signupBuilder('review-post-refetch-delete-race-shopper');
      await createPurchase(templateId, shopper);

      const originalPrepare = env.DB.prepare.bind(env.DB);
      env.DB.prepare = (sql) => {
        const stmt = originalPrepare(sql);
        if (sql.includes('INSERT INTO product_reviews')) {
          const originalBind = stmt.bind.bind(stmt);
          stmt.bind = (...args) => {
            const bound = originalBind(...args);
            const originalRun = bound.run.bind(bound);
            bound.run = async () => {
              const result = await originalRun();
              await originalPrepare('DELETE FROM product_reviews WHERE template_id = ?').bind(templateId).run();
              return result;
            };
            return bound;
          };
        }
        return stmt;
      };
      let posted;
      try {
        posted = await api(`/catalog/${templateId}/reviews`, shopper.session({
          method: 'POST', body: JSON.stringify({ rating: 4, text: 'Raced out from under me.' }),
        }));
      } finally {
        env.DB.prepare = originalPrepare;
      }
      // The real bug was an uncaught TypeError (raw 500) when the re-SELECT
      // after an already-successful INSERT found the row already gone.
      expect(posted.response.status).toBe(404);
    });

    // Moderation deletes (admin override, seller) are not the user editing/
    // deleting their own content -- the owner's own framing was specifically
    // about self-service, so these must not write to the history table.
    // #2388: same asymmetry the calendar-events/sign-posts moderation tests
    // close -- a seller/admin moderation delete now writes to
    // moderation_removal_snapshots instead (never user_content_edit_history).
    it('does not snapshot to user_content_edit_history on a seller or admin moderation delete', async () => {
      const seller = await signupSeller('review-history-moderation-seller');
      const shopper = await signupBuilder('review-history-moderation-shopper');
      const created = await api('/catalog', seller.session({
        method: 'POST',
        body: JSON.stringify({
          templateId: 'review-history-moderation-owned',
          name: 'Moderation-only reviewable product',
          color: '#123456',
          dimensions: { width: 1, depth: 1, height: 1 },
          sellerId: seller.sellerId,
          priceCents: 500,
        }),
      }));
      expect(created.response.status).toBe(201);
      const templateId = created.body.template.templateId;
      await createPurchase(templateId, shopper);
      const reviewId = await postReview(templateId, shopper);

      const deletedBySeller = await api(`/catalog/${templateId}/reviews/${reviewId}`, seller.session({
        method: 'DELETE', body: JSON.stringify({ category: 'spam' }),
      }));
      expect(deletedBySeller.response.status).toBe(200);

      const history = await env.DB.prepare(
        'SELECT * FROM user_content_edit_history WHERE source_table = ? AND source_id = ?',
      ).bind('product_reviews', reviewId).all();
      expect(history.results).toHaveLength(0);

      const snapshot = await env.DB.prepare(
        'SELECT * FROM moderation_removal_snapshots WHERE source_table = ? AND source_id = ?',
      ).bind('product_reviews', reviewId).first();
      expect(snapshot).not.toBeNull();
      expect(snapshot.removed_category).toBe('spam');
    });
  });
});
