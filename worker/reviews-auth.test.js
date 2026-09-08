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

  // Standard marketplace practice: only someone who actually bought the
  // product can review it (see worker/index.js's own comment on the POST
  // handler). There's no real account system to check purchase history
  // against, so eligibility is matched the same way a purchase's own
  // buyerLabel already is elsewhere — a case-insensitive free-text label.
  // instance_id/seller_id have no FK constraints (migrations/0051's own
  // "permanent receipt, not tied to a live reference" design), so this can
  // insert directly without a real placed instance — only builder_id needs
  // a real row to satisfy its FK.
  async function createPurchase(templateId, buyerLabel, { refunded = false } = {}) {
    const builder = (await api('/builders', { method: 'POST', body: JSON.stringify({ label: `Purchaser for ${templateId}` }) })).body.builder;
    await env.DB.prepare(`
      INSERT INTO purchases
        (purchase_id, instance_id, template_id, builder_id, buyer_label,
         unit_price_cents, quantity, total_cents, commission_cents, builder_share_cents, platform_share_cents, refunded_at)
      VALUES (?, ?, ?, ?, ?, 500, 1, 500, 10, 5, 5, ?)
    `).bind(`purchase-${crypto.randomUUID()}`, `instance-${crypto.randomUUID()}`, templateId, builder.builderId, buyerLabel,
      refunded ? new Date().toISOString() : null).run();
  }

  it('rejects a review on a catalog template that does not exist', async () => {
    const rejected = await api('/catalog/template-does-not-exist/reviews', {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'A Shopper', rating: 5 }),
    });
    expect(rejected.response.status).toBe(404);
  });

  // Found via backlog audit (#337): authorLabel had no length cap at all.
  it('rejects a review authorLabel over the length cap', async () => {
    const templateId = await createTemplate('review-author-label-too-long');
    const rejected = await api(`/catalog/${templateId}/reviews`, {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'x'.repeat(101), rating: 5 }),
    });
    expect(rejected.response.status).toBe(400);
  });

  it('rejects a review from a shopper who never purchased the product', async () => {
    const templateId = await createTemplate('review-gate-unpurchased');
    const rejected = await api(`/catalog/${templateId}/reviews`, {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'Never Bought It', rating: 5 }),
    });
    expect(rejected.response.status).toBe(400);
  });

  it('rejects a review backed only by an anonymous (blank buyerLabel) purchase', async () => {
    const templateId = await createTemplate('review-gate-anonymous-purchase');
    await createPurchase(templateId, null);
    const rejected = await api(`/catalog/${templateId}/reviews`, {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'Someone', rating: 5 }),
    });
    expect(rejected.response.status).toBe(400);
  });

  it('accepts a review whose authorLabel matches a real purchase\'s buyerLabel, case-insensitively', async () => {
    const templateId = await createTemplate('review-gate-matching-purchase');
    await createPurchase(templateId, 'A Shopper');
    const accepted = await api(`/catalog/${templateId}/reviews`, {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'a shopper', rating: 5 }),
    });
    expect(accepted.response.status).toBe(201);
  });

  // Found during a broader backlog-exploration pass (#357): the eligibility
  // check matched any purchase under the buyer's label, refunded or not — a
  // shopper who'd already been made whole (and whose refund already clawed
  // back the seller/builder's commission) could still leave a "verified
  // purchase" review under that same refunded transaction.
  it('rejects a review backed only by a refunded purchase', async () => {
    const templateId = await createTemplate('review-gate-refunded-purchase');
    await createPurchase(templateId, 'Refunded Shopper', { refunded: true });
    const rejected = await api(`/catalog/${templateId}/reviews`, {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'Refunded Shopper', rating: 5 }),
    });
    expect(rejected.response.status).toBe(400);
  });

  it('rejects a second review from the same purchaser label, case-insensitively — one review per purchase', async () => {
    const templateId = await createTemplate('review-one-per-purchaser');
    await createPurchase(templateId, 'A Shopper');
    const first = await api(`/catalog/${templateId}/reviews`, {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'A Shopper', rating: 5 }),
    });
    expect(first.response.status).toBe(201);

    // Same label, different case — still the same reviewer.
    const second = await api(`/catalog/${templateId}/reviews`, {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'a shopper', rating: 1, text: 'Actually terrible' }),
    });
    expect(second.response.status).toBe(409);
    expect(second.body).toEqual({ error: 'This purchaser has already reviewed this product' });

    const listed = await api(`/catalog/${templateId}/reviews`);
    expect(listed.body.reviews).toHaveLength(1);
    expect(listed.body.averageRating).toBe(5);

    // Deleting the first review frees the label up to review again.
    await api(`/catalog/${templateId}/reviews/${first.body.review.reviewId}`, { method: 'DELETE' });
    const third = await api(`/catalog/${templateId}/reviews`, {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'A Shopper', rating: 2 }),
    });
    expect(third.response.status).toBe(201);
  });

  it('rejects a concurrent burst of the same purchaser label to exactly one review — regression test for a check-then-act race', async () => {
    // A separate SELECT-then-INSERT for the one-review-per-purchaser check
    // would be a check-then-act race: concurrent submits under the same
    // label could all read "no existing review" before any INSERT
    // committed. Firing every request at once (rather than the sequential
    // test above, which an unfixed version would also pass) is what
    // actually exercises that race — and an unfixed version wouldn't just
    // let duplicates through, it would 500 on the unique index's own
    // constraint violation instead of the clean 409 this guards.
    const templateId = await createTemplate('review-burst-race');
    await createPurchase(templateId, 'A Shopper');

    const attempts = await Promise.all(
      Array.from({ length: 10 }, () => api(`/catalog/${templateId}/reviews`, {
        method: 'POST',
        body: JSON.stringify({ authorLabel: 'A Shopper', rating: 5 }),
      })),
    );
    const created = attempts.filter((a) => a.response.status === 201);
    const conflicted = attempts.filter((a) => a.response.status === 409);
    expect(created).toHaveLength(1);
    expect(conflicted).toHaveLength(9);

    const listed = await api(`/catalog/${templateId}/reviews`);
    expect(listed.body.reviews).toHaveLength(1);
  });

  it('creates, lists (with an average), and moderates reviews on a catalog template — no opt-in required', async () => {
    const templateId = await createTemplate('reviewable-product');
    await createPurchase(templateId, 'A Shopper');
    await createPurchase(templateId, 'Another Shopper');

    const emptyList = await api(`/catalog/${templateId}/reviews`);
    expect(emptyList.response.status).toBe(200);
    expect(emptyList.body.reviews).toEqual([]);
    expect(emptyList.body.averageRating).toBeNull();
    expect(emptyList.body.count).toBe(0);

    const missingRating = await api(`/catalog/${templateId}/reviews`, {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'A Shopper' }),
    });
    expect(missingRating.response.status).toBe(400);

    for (const badRating of [0, 6, 3.5, 'five']) {
      const rejected = await api(`/catalog/${templateId}/reviews`, {
        method: 'POST',
        body: JSON.stringify({ authorLabel: 'A Shopper', rating: badRating }),
      });
      expect(rejected.response.status).toBe(400);
    }

    const tooLong = await api(`/catalog/${templateId}/reviews`, {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'A Shopper', rating: 4, text: 'x'.repeat(281) }),
    });
    expect(tooLong.response.status).toBe(400);

    const firstReview = await api(`/catalog/${templateId}/reviews`, {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'A Shopper', rating: 5, text: 'Lovely product!' }),
    });
    expect(firstReview.response.status).toBe(201);
    expect(firstReview.body.review).toMatchObject({
      templateId,
      authorLabel: 'A Shopper',
      rating: 5,
      text: 'Lovely product!',
    });
    expect(firstReview.body.review.reviewId).toMatch(/^review-/);

    // text is genuinely optional — a bare star rating is still a real review.
    const secondReview = await api(`/catalog/${templateId}/reviews`, {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'Another Shopper', rating: 3 }),
    });
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
    await createPurchase(templateId, 'A Shopper');
    const posted = await api(`/catalog/${templateId}/reviews`, {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'A Shopper', rating: 5 }),
    });
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
    await createPurchase(templateId, 'A Shopper');
    const posted = await api(`/catalog/${templateId}/reviews`, {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'A Shopper', rating: 5 }),
    });
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

  // Found via backlog audit (#520): DELETE on a seller-less template — both
  // single-item and batch — required no session (worker-api.test.js already
  // confirms an unauthenticated single DELETE on an unowned template
  // succeeds) and had no rate limit at all, unlike its PATCH sibling above.
  // Same synthetic cf-connecting-ip approach as the PATCH test.
  it('rate-limits repeated unauthenticated DELETEs on seller-less templates', async () => {
    const headers = { 'cf-connecting-ip': `test-${crypto.randomUUID()}` };
    for (let i = 0; i < 20; i++) {
      const templateId = await createTemplate(`catalog-delete-rate-limit-${i}`);
      const attempt = await api(`/catalog/${templateId}`, { method: 'DELETE', headers });
      expect(attempt.response.status).not.toBe(429);
    }
    const extraTemplateId = await createTemplate('catalog-delete-rate-limit-extra');
    const limited = await api(`/catalog/${extraTemplateId}`, { method: 'DELETE', headers });
    expect(limited.response.status).toBe(429);
  });

  it('rate-limits repeated unauthenticated batch DELETEs on seller-less templates', async () => {
    const headers = { 'cf-connecting-ip': `test-${crypto.randomUUID()}` };
    for (let i = 0; i < 20; i++) {
      const templateId = await createTemplate(`catalog-batch-delete-rate-limit-${i}`);
      const attempt = await api('/catalog/batch', {
        method: 'DELETE', headers, body: JSON.stringify({ templateIds: [templateId] }),
      });
      expect(attempt.response.status).not.toBe(429);
    }
    const extraTemplateId = await createTemplate('catalog-batch-delete-rate-limit-extra');
    const limited = await api('/catalog/batch', {
      method: 'DELETE', headers, body: JSON.stringify({ templateIds: [extraTemplateId] }),
    });
    expect(limited.response.status).toBe(429);
  });

  it('keeps reviews independent between two different catalog templates', async () => {
    const templateA = await createTemplate('reviewable-product-a');
    const templateB = await createTemplate('reviewable-product-b');
    await createPurchase(templateA, 'A Shopper');
    await api(`/catalog/${templateA}/reviews`, {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'A Shopper', rating: 5 }),
    });

    const listA = await api(`/catalog/${templateA}/reviews`);
    const listB = await api(`/catalog/${templateB}/reviews`);
    expect(listA.body.reviews).toHaveLength(1);
    expect(listB.body.reviews).toEqual([]);
  });

  it('cascades review deletion when the catalog template itself is deleted', async () => {
    const templateId = await createTemplate('reviewable-product-to-delete');
    await createPurchase(templateId, 'A Shopper');
    await api(`/catalog/${templateId}/reviews`, {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'A Shopper', rating: 4 }),
    });
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
