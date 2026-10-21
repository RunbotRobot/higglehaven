import {
  applyD1Migrations, env, SELF,
} from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  refundIdempotencyKey, resolveFinalizeBuilderId, claimPurchasesForPayout,
} from './index.js';
import {
  api, signupBuilder, signupSeller, signupAdmin,
} from './test-helpers.js';

let adminSession;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const admin = await signupAdmin('shared-admin');
  adminSession = admin.session;
});

describe('Simulated purchases', () => {
  async function createGreenbeltLandletWithArea(landletId, areaM2) {
    return api('/landlets', adminSession({
      method: 'POST',
      body: JSON.stringify({ landletId, name: `Test ${landletId}`, areaM2, status: 'greenbelt' }),
    }));
  }

  async function claim(landletId, builder) {
    return api(`/landlets/${landletId}/claim`, builder.session({ method: 'POST' }));
  }

  async function createTemplate(templateId, { priceCents, metadata } = {}) {
    const created = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId,
        name: `Purchasable product ${templateId}`,
        color: '#123456',
        dimensions: { width: 1, depth: 1, height: 1 },
        priceCents,
        metadata,
      }),
    });
    expect(created.response.status).toBe(201);
    return templateId;
  }

  // Placing the instance requires the hosting landlet's owning builder's
  // session now (see requireOwnedLandlet) — the purchase/refund endpoints
  // being tested here stay unauthenticated themselves (no shopper account
  // exists, and these templates never set a sellerId), so only this setup
  // step needs a session.
  async function placeInstance(instanceId, landletId, templateId, builder) {
    const placed = await api('/instances', builder.session({
      method: 'POST',
      body: JSON.stringify({ instanceId, landletId, templateId, x: 0, y: 0 }),
    }));
    expect(placed.response.status).toBe(201);
    return instanceId;
  }

  async function builderRow(builderId) {
    return env.DB.prepare('SELECT * FROM builders WHERE builder_id = ?').bind(builderId).first();
  }

  // #683: catalog_templates.category is freeform text with no allowlist,
  // and neither the placement (batch-create) nor purchase code paths
  // filter by it — an "avatar"-category template (the product type #679
  // introduces for sellable custom avatars) should place and purchase
  // exactly like any other product, with zero special-casing needed.
  it('places and purchases an avatar-category template with no special-casing (#683)', async () => {
    const seller = await signupAdmin('avatar-category-seller');
    await createGreenbeltLandletWithArea('avatar-category-landlet', 1000);
    await claim('avatar-category-landlet', seller);

    const created = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'avatar-category-template',
        name: 'Sellable Avatar',
        category: 'avatar',
        color: '#654321',
        dimensions: { width: 1, depth: 1, height: 2 },
        priceCents: 500,
      }),
    });
    expect(created.response.status).toBe(201);
    expect(created.body.template.category).toBe('avatar');

    await placeInstance('avatar-category-instance', 'avatar-category-landlet', 'avatar-category-template', seller);

    // Lists normally alongside any other placed instance — nothing filters
    // an "avatar" category out of the same query a builder's own world view
    // uses to render everything sitting on their landlet.
    const listed = await api('/instances?landletId=avatar-category-landlet', seller.session());
    expect(listed.response.status).toBe(200);
    expect(listed.body.instances.map((i) => i.instanceId)).toContain('avatar-category-instance');

    const purchased = await api('/instances/avatar-category-instance/purchase', seller.session({ method: 'POST' }));
    expect(purchased.response.status).toBe(201);
    expect(purchased.body.purchase).toMatchObject({ unitPriceCents: 500, totalCents: 500 });
  });

  it('404s purchasing an instance that does not exist', async () => {
    const account = await signupBuilder('purchase-missing-account');
    const rejected = await api('/instances/purchase-missing-instance/purchase', account.session({ method: 'POST' }));
    expect(rejected.response.status).toBe(404);
  });

  // #877: the frontend (purchaseInstance in src/api.js) always sends a
  // stable idempotencyKey it keeps reusing until a purchase finalizes —
  // exactly the "network blip, then a retry with the same key" scenario
  // handlePurchaseFinalize's own idempotency check already handles for the
  // real-money path. This confirms the simulated path (the default for a
  // product whose seller hasn't connected Stripe) now handles it too.
  it('does not double-credit the builder when the same idempotencyKey is retried', async () => {
    const seller = await signupAdmin('purchase-idempotency-seller');
    await createGreenbeltLandletWithArea('purchase-idempotency-landlet', 1000);
    await claim('purchase-idempotency-landlet', seller);
    await createTemplate('purchase-idempotency-template', { priceCents: 750 });
    await placeInstance('purchase-idempotency-instance', 'purchase-idempotency-landlet', 'purchase-idempotency-template', seller);

    const first = await api('/instances/purchase-idempotency-instance/purchase', seller.session({
      method: 'POST', body: JSON.stringify({ idempotencyKey: 'retry-test-key' }),
    }));
    expect(first.response.status).toBe(201);

    const retried = await api('/instances/purchase-idempotency-instance/purchase', seller.session({
      method: 'POST', body: JSON.stringify({ idempotencyKey: 'retry-test-key' }),
    }));
    expect(retried.response.status).toBe(200);
    expect(retried.body.purchase.purchaseId).toBe(first.body.purchase.purchaseId);

    const builderShareCents = first.body.purchase.builderShareCents;
    const after = await builderRow(seller.builderId);
    expect(after.higgles_balance_cents).toBe(builderShareCents);
    const purchaseCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM purchases WHERE instance_id = ?')
      .bind('purchase-idempotency-instance').first();
    expect(purchaseCount.n).toBe(1);

    // A different idempotencyKey (or none at all) is a genuinely separate
    // purchase, still credited normally — this isn't a dedup-everything
    // guard, only same-key retries.
    const separate = await api('/instances/purchase-idempotency-instance/purchase', seller.session({ method: 'POST' }));
    expect(separate.response.status).toBe(201);
    expect(separate.body.purchase.purchaseId).not.toBe(first.body.purchase.purchaseId);
    const afterSeparate = await builderRow(seller.builderId);
    expect(afterSeparate.higgles_balance_cents).toBe(builderShareCents * 2);
  });

  // #974: purchaseIdempotencyKey used to be a pure function of instanceId +
  // the client-supplied rawKey, with no buyer component at all -- a stale
  // localStorage-cached key surviving a cancelled checkout, then reused by a
  // second account on the same browser (localStorage is keyed only by
  // instanceId, never the logged-in account), collided on one shared
  // purchase row instead of two separate ones.
  it('does not let two different buyers collide on the same client-supplied idempotencyKey', async () => {
    const seller = await signupBuilder('purchase-idempotency-cross-buyer-seller');
    await createGreenbeltLandletWithArea('purchase-idempotency-cross-buyer-landlet', 1000);
    await claim('purchase-idempotency-cross-buyer-landlet', seller);
    await createTemplate('purchase-idempotency-cross-buyer-template', { priceCents: 750 });
    await placeInstance(
      'purchase-idempotency-cross-buyer-instance', 'purchase-idempotency-cross-buyer-landlet',
      'purchase-idempotency-cross-buyer-template', seller,
    );

    const buyerA = await signupAdmin('purchase-idempotency-cross-buyer-a');
    const buyerB = await signupAdmin('purchase-idempotency-cross-buyer-b');
    const sharedKey = 'shared-stale-key';

    const purchasedByA = await api('/instances/purchase-idempotency-cross-buyer-instance/purchase', buyerA.session({
      method: 'POST', body: JSON.stringify({ idempotencyKey: sharedKey }),
    }));
    expect(purchasedByA.response.status).toBe(201);

    const purchasedByB = await api('/instances/purchase-idempotency-cross-buyer-instance/purchase', buyerB.session({
      method: 'POST', body: JSON.stringify({ idempotencyKey: sharedKey }),
    }));
    expect(purchasedByB.response.status).toBe(201);
    expect(purchasedByB.body.purchase.purchaseId).not.toBe(purchasedByA.body.purchase.purchaseId);
    expect(purchasedByB.body.purchase.buyerLabel).not.toBe(purchasedByA.body.purchase.buyerLabel);

    const purchaseCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM purchases WHERE instance_id = ?')
      .bind('purchase-idempotency-cross-buyer-instance').first();
    expect(purchaseCount.n).toBe(2);

    // A's own retry of the same shared key must still find only A's own
    // purchase, never B's.
    const retriedByA = await api('/instances/purchase-idempotency-cross-buyer-instance/purchase', buyerA.session({
      method: 'POST', body: JSON.stringify({ idempotencyKey: sharedKey }),
    }));
    expect(retriedByA.response.status).toBe(200);
    expect(retriedByA.body.purchase.purchaseId).toBe(purchasedByA.body.purchase.purchaseId);
  });

  // #1903: the client caches its idempotencyKey in localStorage for up to
  // 30 minutes and only clears it once a purchase finalizes client-side —
  // a resubmit of the same key after a lost response can legitimately carry
  // a different quantity (e.g. the buyer changed the quantity selector).
  // That must be treated as a genuinely new purchase, not silently
  // collapsed onto the stale row.
  it('treats a same-key resubmit with a different quantity as a genuinely new purchase', async () => {
    const seller = await signupAdmin('purchase-idempotency-mismatch-seller');
    await createGreenbeltLandletWithArea('purchase-idempotency-mismatch-landlet', 1000);
    await claim('purchase-idempotency-mismatch-landlet', seller);
    await createTemplate('purchase-idempotency-mismatch-template', { priceCents: 750 });
    await placeInstance(
      'purchase-idempotency-mismatch-instance', 'purchase-idempotency-mismatch-landlet',
      'purchase-idempotency-mismatch-template', seller,
    );

    const first = await api('/instances/purchase-idempotency-mismatch-instance/purchase', seller.session({
      method: 'POST', body: JSON.stringify({ idempotencyKey: 'mismatch-test-key', quantity: 1 }),
    }));
    expect(first.response.status).toBe(201);
    expect(first.body.purchase.quantity).toBe(1);

    const resubmittedWithDifferentQuantity = await api(
      '/instances/purchase-idempotency-mismatch-instance/purchase', seller.session({
        method: 'POST', body: JSON.stringify({ idempotencyKey: 'mismatch-test-key', quantity: 5 }),
      }),
    );
    expect(resubmittedWithDifferentQuantity.response.status).toBe(201);
    expect(resubmittedWithDifferentQuantity.body.purchase.quantity).toBe(5);
    expect(resubmittedWithDifferentQuantity.body.purchase.purchaseId).not.toBe(first.body.purchase.purchaseId);

    const purchaseCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM purchases WHERE instance_id = ?')
      .bind('purchase-idempotency-mismatch-instance').first();
    expect(purchaseCount.n).toBe(2);
    const after = await builderRow(seller.builderId);
    expect(after.higgles_balance_cents).toBe(first.body.purchase.builderShareCents + resubmittedWithDifferentQuantity.body.purchase.builderShareCents);

    // The original, unedited retry (same key, same quantity) must still
    // dedup onto the first row -- this isn't a regression to "no dedup at
    // all", only to "dedup requires matching content".
    const unmodifiedRetry = await api('/instances/purchase-idempotency-mismatch-instance/purchase', seller.session({
      method: 'POST', body: JSON.stringify({ idempotencyKey: 'mismatch-test-key', quantity: 1 }),
    }));
    expect(unmodifiedRetry.response.status).toBe(200);
    expect(unmodifiedRetry.body.purchase.purchaseId).toBe(first.body.purchase.purchaseId);
  });

  it('400s purchasing an unpriced product', async () => {
    const seller = await signupBuilder('purchase-unpriced-seller');
    await createGreenbeltLandletWithArea('purchase-unpriced-landlet', 1000);
    await claim('purchase-unpriced-landlet', seller);
    await createTemplate('purchase-unpriced-template');
    await placeInstance('purchase-unpriced-instance', 'purchase-unpriced-landlet', 'purchase-unpriced-template', seller);

    const rejected = await api('/instances/purchase-unpriced-instance/purchase', seller.session({ method: 'POST' }));
    expect(rejected.response.status).toBe(400);
  });

  it('400s purchasing an instance on an unclaimed lándlet', async () => {
    const account = await signupBuilder('purchase-unclaimed-account');
    await createGreenbeltLandletWithArea('purchase-unclaimed-landlet', 1000);
    await createTemplate('purchase-unclaimed-template', { priceCents: 500 });
    // Placing an instance through the API now always requires owning the
    // landlet it sits on — impossible here on purpose, since this test
    // needs the instance to sit on a genuinely *unclaimed* landlet. Insert
    // the row directly, the same test-only escape hatch used elsewhere in
    // this file for state the HTTP API can no longer produce directly.
    await env.DB.prepare(`
      INSERT INTO placed_instances (instance_id, landlet_id, template_id, x_m, y_m, z_m, rotation_x_rad, rotation_y_rad, rotation_z_rad, scale)
      VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, 1)
    `).bind('purchase-unclaimed-instance', 'purchase-unclaimed-landlet', 'purchase-unclaimed-template').run();

    const rejected = await api('/instances/purchase-unclaimed-instance/purchase', account.session({ method: 'POST' }));
    expect(rejected.response.status).toBe(400);
  });

  it('reads quantity and buyerLabel from the request body, defaulting to 1 and the session builder\'s own label', async () => {
    const seller = await signupAdmin('purchase-body-seller');
    await createGreenbeltLandletWithArea('purchase-body-landlet', 1000);
    await claim('purchase-body-landlet', seller);
    await createTemplate('purchase-body-template', { priceCents: 1000 });
    await placeInstance('purchase-body-instance', 'purchase-body-landlet', 'purchase-body-template', seller);

    // No body at all — should default rather than 415/400. #761: buyerLabel
    // defaults to the session's own resolved builder label, not null/
    // anonymous — the in-world "Simulate Purchase" button (the only real
    // buy path this app ships) never sends an explicit buyerLabel at all,
    // so an anonymous default here meant no real purchase could ever back
    // a product review (the review-eligibility check requires an exact
    // buyer_label match).
    const defaulted = await api('/instances/purchase-body-instance/purchase', seller.session({ method: 'POST' }));
    expect(defaulted.response.status).toBe(201);
    expect(defaulted.body.purchase).toMatchObject({
      quantity: 1, buyerLabel: seller.builder.label, unitPriceCents: 1000, totalCents: 1000,
    });

    const withBody = await api('/instances/purchase-body-instance/purchase', seller.session({
      method: 'POST',
      body: JSON.stringify({ quantity: 3, buyerLabel: 'A Shopper' }),
    }));
    expect(withBody.response.status).toBe(201);
    expect(withBody.body.purchase).toMatchObject({ quantity: 3, buyerLabel: 'A Shopper', unitPriceCents: 1000, totalCents: 3000 });

    const badQuantity = await api('/instances/purchase-body-instance/purchase', seller.session({
      method: 'POST',
      body: JSON.stringify({ quantity: 0 }),
    }));
    expect(badQuantity.response.status).toBe(400);

    // Found via backlog audit (#337): buyerLabel had no length cap at all.
    const badBuyerLabel = await api('/instances/purchase-body-instance/purchase', seller.session({
      method: 'POST',
      body: JSON.stringify({ buyerLabel: 'x'.repeat(101) }),
    }));
    expect(badBuyerLabel.response.status).toBe(400);
  });

  // #1112: unlike buyerLabel (free text, always just the session builder's
  // own label here since both requests above omit/override it), this is the
  // session's actual resolved builder_id -- a real foreign key, distinct
  // from the purchase's own top-level builderId (the host who earns
  // commission; the seller and the buyer are the same builder in this test,
  // so asserting both separately matters).
  it('stores the session builder as buyerBuilderId on a simulated purchase', async () => {
    const seller = await signupBuilder('purchase-buyer-id-seller');
    const buyer = await signupAdmin('purchase-buyer-id-buyer');
    await createGreenbeltLandletWithArea('purchase-buyer-id-landlet', 1000);
    await claim('purchase-buyer-id-landlet', seller);
    await createTemplate('purchase-buyer-id-template', { priceCents: 1000 });
    await placeInstance('purchase-buyer-id-instance', 'purchase-buyer-id-landlet', 'purchase-buyer-id-template', seller);

    const purchased = await api('/instances/purchase-buyer-id-instance/purchase', buyer.session({ method: 'POST' }));
    expect(purchased.response.status).toBe(201);
    expect(purchased.body.purchase.builderId).toBe(seller.builderId);
    expect(purchased.body.purchase.buyerBuilderId).toBe(buyer.builderId);

    const row = await env.DB.prepare('SELECT buyer_builder_id FROM purchases WHERE purchase_id = ?')
      .bind(purchased.body.purchase.purchaseId).first();
    expect(row.buyer_builder_id).toBe(buyer.builderId);
  });

  // #761/#1113: the in-world "Simulate Purchase" button (src/main.js) — the
  // only real purchase path this app ships — never sends an explicit
  // buyerLabel at all. #761 fixed that path leaving buyer_label NULL
  // (defaulting it to the session's own label instead); #1113 later moved
  // review eligibility off buyer_label entirely onto the real
  // buyer_builder_id this purchase also carries. This reproduces the real
  // button's exact path — a purchase POST with no buyerLabel in the body —
  // then confirms the same buyer can review it under their own session,
  // with no explicit purchaseId/authorLabel needed from the client either.
  it('lets a real buyer review the product after a purchase made with no explicit buyerLabel (#761/#1113)', async () => {
    const buyer = await signupAdmin('review-eligibility-buyer');
    await createGreenbeltLandletWithArea('review-eligibility-landlet', 1000);
    await claim('review-eligibility-landlet', buyer);
    await createTemplate('review-eligibility-template', { priceCents: 500 });
    await placeInstance('review-eligibility-instance', 'review-eligibility-landlet', 'review-eligibility-template', buyer);

    const purchased = await api('/instances/review-eligibility-instance/purchase', buyer.session({ method: 'POST' }));
    expect(purchased.response.status).toBe(201);
    expect(purchased.body.purchase.buyerLabel).toBe(buyer.builder.label);
    expect(purchased.body.purchase.buyerBuilderId).toBe(buyer.builderId);

    const reviewed = await api('/catalog/review-eligibility-template/reviews', buyer.session({
      method: 'POST',
      body: JSON.stringify({ rating: 5 }),
    }));
    expect(reviewed.response.status).toBe(201);
    expect(reviewed.body.review.authorLabel).toBe(buyer.builder.label);
    expect(reviewed.body.review.purchaseId).toBe(purchased.body.purchase.purchaseId);
  });

  it('rejects an absurd quantity rather than crediting an unbounded higgles amount', async () => {
    // This endpoint is deliberately unauthenticated (see docs/API.md's
    // "Simulated purchases"), so quantity is one of two guards (alongside
    // the rate limit below) against one request minting an arbitrary
    // higgles credit.
    const seller = await signupAdmin('purchase-quantity-cap-seller');
    await createGreenbeltLandletWithArea('purchase-quantity-cap-landlet', 1000);
    await claim('purchase-quantity-cap-landlet', seller);
    await createTemplate('purchase-quantity-cap-template', { priceCents: 1000 });
    await placeInstance('purchase-quantity-cap-instance', 'purchase-quantity-cap-landlet', 'purchase-quantity-cap-template', seller);

    const tooMany = await api('/instances/purchase-quantity-cap-instance/purchase', seller.session({
      method: 'POST',
      body: JSON.stringify({ quantity: 1001 }),
    }));
    expect(tooMany.response.status).toBe(400);
    expect(tooMany.body).toEqual({ error: 'quantity must be 1000 or fewer' });

    const atCap = await api('/instances/purchase-quantity-cap-instance/purchase', seller.session({
      method: 'POST',
      body: JSON.stringify({ quantity: 1000 }),
    }));
    expect(atCap.response.status).toBe(201);
    expect(atCap.body.purchase.quantity).toBe(1000);
  });

  it('rejects a total price that exceeds MAX_MONEY_CENTS even when quantity and priceCents each pass their own cap (#521)', async () => {
    const seller = await signupAdmin('purchase-total-cap-seller');
    await createGreenbeltLandletWithArea('purchase-total-cap-landlet', 1000);
    await claim('purchase-total-cap-landlet', seller);
    // 100_000_000 is MAX_MONEY_CENTS itself — individually valid for priceCents.
    await createTemplate('purchase-total-cap-template', { priceCents: 100_000_000 });
    await placeInstance('purchase-total-cap-instance', 'purchase-total-cap-landlet', 'purchase-total-cap-template', seller);

    // quantity 2 is well within PURCHASE_MAX_QUANTITY (1000), but combined
    // with the price above it produces a totalCents twice MAX_MONEY_CENTS.
    const tooMuch = await api('/instances/purchase-total-cap-instance/purchase', seller.session({
      method: 'POST',
      body: JSON.stringify({ quantity: 2 }),
    }));
    expect(tooMuch.response.status).toBe(400);
    expect(tooMuch.body).toEqual({ error: 'total price must be 100000000 cents or fewer' });

    const atCap = await api('/instances/purchase-total-cap-instance/purchase', seller.session({
      method: 'POST',
      body: JSON.stringify({ quantity: 1 }),
    }));
    expect(atCap.response.status).toBe(201);
    expect(atCap.body.purchase.totalCents).toBe(100_000_000);
  });

  it('rate-limits repeated purchases from the same client', async () => {
    // Unauthenticated on purpose (no shopper account exists to check
    // against), but a successful call credits a real builder balance and
    // earnings ledger entry, so it gets the same per-client throttle as
    // signup/password-reset/model-upload. A synthetic cf-connecting-ip
    // keeps this test's bucket from colliding with every other purchase
    // test in this file, which otherwise all share the same "unknown" IP
    // bucket (mirrors the model-upload rate-limit test's own approach).
    const seller = await signupAdmin('purchase-rate-limit-seller');
    await createGreenbeltLandletWithArea('purchase-rate-limit-landlet', 1000);
    await claim('purchase-rate-limit-landlet', seller);
    await createTemplate('purchase-rate-limit-template', { priceCents: 1000 });
    await placeInstance('purchase-rate-limit-instance', 'purchase-rate-limit-landlet', 'purchase-rate-limit-template', seller);

    const headers = { 'cf-connecting-ip': `test-${crypto.randomUUID()}` };
    for (let i = 0; i < 30; i++) {
      const attempt = await api('/instances/purchase-rate-limit-instance/purchase', seller.session({ method: 'POST', headers }));
      expect(attempt.response.status).not.toBe(429);
    }
    const limited = await api('/instances/purchase-rate-limit-instance/purchase', seller.session({ method: 'POST', headers }));
    expect(limited.response.status).toBe(429);
  }, 45000); // matches the sibling burst-race test below — 30 sequential
  // round trips reliably finishes in under a second in isolation, but a
  // long-running CI worker (this whole file, 300+ tests, one process) can
  // occasionally push it past 20s on nothing but scheduling contention,
  // not a real regression — this pre-existing flake has now blocked two
  // separate unrelated PRs' CI runs this session for exactly that reason.

  it('rate-limits a concurrent burst to exactly the max, not more — regression test for checkRateLimit\'s check-then-act race', async () => {
    // checkRateLimit used to run a separate SELECT COUNT(*) then INSERT;
    // concurrent requests sharing a bucket could all read the same
    // under-the-limit count before any of their inserts committed, letting
    // a burst blow past the limit. Firing every request at once (rather
    // than the sequential loop above, which an unfixed version would also
    // have passed) is what actually exercises that race.
    const seller = await signupAdmin('purchase-rate-limit-burst-seller');
    await createGreenbeltLandletWithArea('purchase-rate-limit-burst-landlet', 1000);
    await claim('purchase-rate-limit-burst-landlet', seller);
    await createTemplate('purchase-rate-limit-burst-template', { priceCents: 1000 });
    await placeInstance('purchase-rate-limit-burst-instance', 'purchase-rate-limit-burst-landlet', 'purchase-rate-limit-burst-template', seller);

    const headers = { 'cf-connecting-ip': `test-${crypto.randomUUID()}` };
    const attempts = await Promise.all(
      Array.from({ length: 40 }, () => api('/instances/purchase-rate-limit-burst-instance/purchase', seller.session({ method: 'POST', headers }))),
    );
    const succeeded = attempts.filter((a) => a.response.status !== 429);
    const limited = attempts.filter((a) => a.response.status === 429);
    expect(succeeded).toHaveLength(30);
    expect(limited).toHaveLength(10);
  }, 45000);

  it('computes the 2% commission with a 50/50 split, crediting the builder\'s balance and earnings ledger', async () => {
    const seller = await signupAdmin('purchase-commission-seller');
    await createGreenbeltLandletWithArea('purchase-commission-landlet', 1000);
    await claim('purchase-commission-landlet', seller);
    await createTemplate('purchase-commission-template', { priceCents: 10000 }); // $100
    await placeInstance('purchase-commission-instance', 'purchase-commission-landlet', 'purchase-commission-template', seller);

    const before = await builderRow(seller.builderId);
    const purchased = await api('/instances/purchase-commission-instance/purchase', seller.session({ method: 'POST' }));
    expect(purchased.response.status).toBe(201);
    // $100 * 2% = $2 commission, split 50/50 = $1 (100 cents) to the builder.
    expect(purchased.body.purchase).toMatchObject({
      totalCents: 10000, commissionCents: 200, builderShareCents: 100, platformShareCents: 100,
    });

    const after = await builderRow(seller.builderId);
    expect(after.higgles_balance_cents - before.higgles_balance_cents).toBe(100);

    const { results } = await env.DB.prepare(
      'SELECT * FROM higgles_earnings_events WHERE builder_id = ?',
    ).bind(seller.builderId).all();
    expect(results).toHaveLength(1);
    expect(results[0].amount_cents).toBe(100);
  });

  it('applies the 0.5% floor on a low-commission product, without ever pushing the platform share negative', async () => {
    const seller = await signupAdmin('purchase-floor-seller');
    await createGreenbeltLandletWithArea('purchase-floor-landlet', 1000);
    await claim('purchase-floor-landlet', seller);
    await createTemplate('purchase-floor-template', { priceCents: 100000 }); // $1000
    await placeInstance('purchase-floor-instance', 'purchase-floor-landlet', 'purchase-floor-template', seller);

    // $1000 * 2% = $20 commission; 50% of that is $10 (1000 cents), but the
    // 0.5% floor on the $1000 total is $5 (500 cents) — the 50% split
    // already clears the floor here, so this exercises the non-floor branch
    // with a large total to confirm rounding stays exact.
    const purchased = await api('/instances/purchase-floor-instance/purchase', seller.session({ method: 'POST' }));
    expect(purchased.body.purchase).toMatchObject({
      totalCents: 100000, commissionCents: 2000, builderShareCents: 1000, platformShareCents: 1000,
    });
  });

  // #2439: priceCents 0 is distinct from the unpriced (null) case tested
  // above — computePurchaseAmounts only rejects a null price, so a free
  // listing reaches the write path with totalCents/builderShareCents both
  // 0. Crediting a $0 commission is a no-op, but
  // higgles_earnings_events.amount_cents has its own CHECK (amount_cents >
  // 0) (migration 0093), so unconditionally inserting that zero-amount row
  // used to turn this otherwise-clean purchase into an uncaught "CHECK
  // constraint failed", surfacing as a generic 400 via databaseHttpError
  // instead of the 201 a free sale should return.
  it('completes a purchase of a free (priceCents 0) product without hitting higgles_earnings_events\' zero-amount CHECK constraint', async () => {
    const seller = await signupAdmin('purchase-free-seller');
    await createGreenbeltLandletWithArea('purchase-free-landlet', 1000);
    await claim('purchase-free-landlet', seller);
    await createTemplate('purchase-free-template', { priceCents: 0 });
    await placeInstance('purchase-free-instance', 'purchase-free-landlet', 'purchase-free-template', seller);

    const before = await builderRow(seller.builderId);
    const purchased = await api('/instances/purchase-free-instance/purchase', seller.session({ method: 'POST' }));
    expect(purchased.response.status).toBe(201);
    expect(purchased.body.purchase).toMatchObject({
      totalCents: 0, commissionCents: 0, builderShareCents: 0, platformShareCents: 0,
    });

    const after = await builderRow(seller.builderId);
    expect(after.higgles_balance_cents).toBe(before.higgles_balance_cents);

    const { results } = await env.DB.prepare(
      'SELECT * FROM higgles_earnings_events WHERE builder_id = ?',
    ).bind(seller.builderId).all();
    expect(results).toHaveLength(0);
  });

  it('lists a builder\'s purchase history via GET /api/purchases', async () => {
    const seller = await signupAdmin('purchase-list-seller');
    await createGreenbeltLandletWithArea('purchase-list-landlet', 1000);
    await claim('purchase-list-landlet', seller);
    await createTemplate('purchase-list-template', { priceCents: 500 });
    await placeInstance('purchase-list-instance', 'purchase-list-landlet', 'purchase-list-template', seller);

    await api('/instances/purchase-list-instance/purchase', seller.session({ method: 'POST' }));
    await api('/instances/purchase-list-instance/purchase', seller.session({ method: 'POST' }));

    const missingBuilderId = await api('/purchases');
    expect(missingBuilderId.response.status).toBe(400);

    const unauthenticatedList = await api(`/purchases?builderId=${seller.builderId}`);
    expect(unauthenticatedList.response.status).toBe(401);

    const list = await api(`/purchases?builderId=${seller.builderId}`, seller.session());
    expect(list.response.status).toBe(200);
    expect(list.body.purchases).toHaveLength(2);
    expect(list.body.purchases[0]).toMatchObject({ templateId: 'purchase-list-template', builderId: seller.builderId });

    // The same history, filtered by product instead of by hosting builder —
    // what the Seller modal's own "Sales" panel uses (a seller sees every
    // sale of their product, regardless of which builder's lándlet hosted
    // the instance that sold).
    const byTemplate = await api('/purchases?templateId=purchase-list-template');
    expect(byTemplate.response.status).toBe(200);
    expect(byTemplate.body.purchases).toHaveLength(2);
  });

  // The list above is capped at 100 rows with no pagination — reading a
  // seller's own "N sales" summary straight off that capped list's own
  // .length (the Seller modal's Sales panel, before this fix) silently
  // undercounts once a product has passed 100 sales. totalCount is a
  // dedicated, uncapped COUNT instead (same fix already applied to
  // notifications' unread badge — see 'reports the true unread count past
  // the notifications list's own 100-row cap' above).
  it('reports the true purchase count past the purchases list\'s own 100-row cap, by both builderId and templateId', async () => {
    const seller = await signupBuilder('purchase-count-seller');
    await createTemplate('purchase-count-template', { priceCents: 500 });
    const statements = Array.from({ length: 105 }, (_, i) =>
      env.DB.prepare(`
        INSERT INTO purchases
          (purchase_id, instance_id, template_id, builder_id, unit_price_cents, quantity,
           total_cents, commission_cents, builder_share_cents, platform_share_cents)
        VALUES (?, 'purchase-count-instance', 'purchase-count-template', ?, 500, 1, 500, 10, 5, 5)
      `).bind(`purchase-count-${i}`, seller.builderId));
    await env.DB.batch(statements);

    const byBuilder = await api(`/purchases?builderId=${seller.builderId}`, seller.session());
    expect(byBuilder.body.purchases).toHaveLength(100);
    expect(byBuilder.body.totalCount).toBe(105);

    const byTemplate = await api('/purchases?templateId=purchase-count-template');
    expect(byTemplate.body.purchases).toHaveLength(100);
    expect(byTemplate.body.totalCount).toBe(105);
  });

  it('rejects a malformed JSON purchase body cleanly instead of a raw parse error', async () => {
    const seller = await signupBuilder('purchase-malformed-seller');
    await createGreenbeltLandletWithArea('purchase-malformed-landlet', 1000);
    await claim('purchase-malformed-landlet', seller);
    await createTemplate('purchase-malformed-template', { priceCents: 500 });
    await placeInstance('purchase-malformed-instance', 'purchase-malformed-landlet', 'purchase-malformed-template', seller);

    const rejected = await SELF.fetch('https://higglehaven.test/api/instances/purchase-malformed-instance/purchase', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `hh_session=${seller.sessionToken}` },
      body: '{not json',
    });
    expect(rejected.status).toBe(400);
  });

  it('404s refunding a purchase that does not exist', async () => {
    const rejected = await api('/purchases/purchase-does-not-exist/refund', { method: 'POST' });
    expect(rejected.response.status).toBe(404);
  });

  it('refunds a purchase, clawing back exactly the builder\'s commission share (not the full total)', async () => {
    const seller = await signupAdmin('purchase-refund-seller');
    await createGreenbeltLandletWithArea('purchase-refund-landlet', 1000);
    await claim('purchase-refund-landlet', seller);
    await createTemplate('purchase-refund-template', { priceCents: 10000 }); // $100
    await placeInstance('purchase-refund-instance', 'purchase-refund-landlet', 'purchase-refund-template', seller);

    const purchased = await api('/instances/purchase-refund-instance/purchase', seller.session({ method: 'POST' }));
    const { purchaseId, builderShareCents } = purchased.body.purchase;
    expect(builderShareCents).toBe(100); // 2% of $100 = $2 commission, 50% = $1

    const before = await builderRow(seller.builderId);
    // This template has no sellerId (createTemplate's own default), so the
    // refund falls to the admin fallback rather than seller ownership —
    // see the "requires admin" test below for that path in isolation.
    const refunded = await api(`/purchases/${purchaseId}/refund`, adminSession({ method: 'POST' }));
    expect(refunded.response.status).toBe(200);
    expect(refunded.body.purchase.refundedAt).not.toBeNull();
    const after = await builderRow(seller.builderId);
    expect(before.higgles_balance_cents - after.higgles_balance_cents).toBe(builderShareCents);

    // #813/#817: this refund only went through via the ownerless-fallback
    // admin branch (no live seller to own it) — that must leave a record
    // of which admin acted, same as every other sensitive admin-only
    // mutation this tracking issue covers.
    const adminUserId = (await api('/auth/me', adminSession())).body.user.userId;
    const logRow = await env.DB.prepare(
      'SELECT * FROM admin_action_log WHERE action_type = ? AND target_id = ?',
    ).bind('refund_override', purchaseId).first();
    expect(logRow.admin_user_id).toBe(adminUserId);
    expect(logRow.target_type).toBe('purchase');

    // Refunding twice is rejected — the clawback already happened once.
    // This is also the observable contract #192's fix protects under real
    // concurrency (two requests racing on a stale refunded_at read): this
    // test pool's single-threaded workerd runtime can't force genuine
    // interleaving between the guard read and the guard write, so this
    // sequential case is what's actually exercisable here — the fix
    // itself (an atomic `WHERE refunded_at IS NULL` + meta.changes check,
    // not batched with the balance mutation) mirrors handleAuctionBids's
    // already-proven-safe conditional-insert pattern in this same file.
    const secondRefund = await api(`/purchases/${purchaseId}/refund`, adminSession({ method: 'POST' }));
    expect(secondRefund.response.status).toBe(409);
    const afterSecondAttempt = await builderRow(seller.builderId);
    expect(afterSecondAttempt.higgles_balance_cents).toBe(after.higgles_balance_cents);
  });

  it('keeps a purchase record (with a nulled builderId) after the hosting builder deletes their account, and still allows a refund', async () => {
    const seller = await signupAdmin('purchase-builder-deleted-seller');
    await createGreenbeltLandletWithArea('purchase-builder-deleted-landlet', 1000);
    await claim('purchase-builder-deleted-landlet', seller);
    await createTemplate('purchase-builder-deleted-template', { priceCents: 4000 });
    await placeInstance('purchase-builder-deleted-instance', 'purchase-builder-deleted-landlet', 'purchase-builder-deleted-template', seller);

    const purchased = await api('/instances/purchase-builder-deleted-instance/purchase', seller.session({ method: 'POST' }));
    const { purchaseId } = purchased.body.purchase;

    // migrations/0051's own header comment states purchases are "a
    // permanent historical receipt" — this is the case that used to
    // violate that: an unrelated action (the hosting builder deleting
    // their own account) used to cascade-delete this row outright
    // (migrations/0062 switched builder_id to SET NULL instead).
    const deleted = await api(`/builders/${seller.builderId}`, seller.session({ method: 'DELETE' }));
    expect(deleted.response.status).toBe(200);

    const listing = await api(`/purchases?templateId=purchase-builder-deleted-template`);
    expect(listing.response.status).toBe(200);
    expect(listing.body.purchases).toContainEqual(expect.objectContaining({ purchaseId, builderId: null }));

    // No seller on this template, so the admin fallback applies (same as
    // the "no seller" refund test below) — and the null builderId must
    // not crash the balance-clawback/notification step.
    const refunded = await api(`/purchases/${purchaseId}/refund`, adminSession({ method: 'POST' }));
    expect(refunded.response.status).toBe(200);
    expect(refunded.body.purchase.refundedAt).not.toBeNull();
  });

  // #803: migrations/0079's own comment says higgles_redemptions is "a
  // permanent record of each real-money cash-out... mirroring the 'keep
  // the record, drop the live reference' reasoning purchases' own
  // stripe_payout_id/paid_out_at columns already use" -- but unlike
  // purchases.builder_id (fixed by migrations/0062, tested just above),
  // this table's builder_id was still ON DELETE CASCADE until #803. A row
  // is only ever inserted after real Stripe transfers/payouts calls
  // succeed, so losing it on self-delete erases a real payout's only
  // record. Inserted directly (mirroring this file's own approach for
  // purchases above) rather than driving a full Stripe Connect
  // onboarding + redeem flow, which isn't this test's own concern.
  it('keeps a higgles_redemptions record (with a nulled builderId) after the builder deletes their account', async () => {
    const builder = await signupBuilder('redemption-builder-deleted');
    const redemptionId = `redemption-${crypto.randomUUID()}`;
    await env.DB.prepare(`
      INSERT INTO higgles_redemptions (redemption_id, builder_id, amount_cents, stripe_transfer_id, stripe_payout_id)
      VALUES (?, ?, 500000, ?, ?)
    `).bind(redemptionId, builder.builderId, `tr_${crypto.randomUUID()}`, `po_${crypto.randomUUID()}`).run();

    const deleted = await api(`/builders/${builder.builderId}`, builder.session({ method: 'DELETE' }));
    expect(deleted.response.status).toBe(200);

    const row = await env.DB.prepare('SELECT * FROM higgles_redemptions WHERE redemption_id = ?').bind(redemptionId).first();
    expect(row).not.toBeNull();
    expect(row.builder_id).toBeNull();
    expect(row.amount_cents).toBe(500000);
  });

  it('rejects refunding a purchase with no seller without an admin session', async () => {
    const seller = await signupAdmin('purchase-refund-no-seller-auth-seller');
    await createGreenbeltLandletWithArea('purchase-refund-no-seller-auth-landlet', 1000);
    await claim('purchase-refund-no-seller-auth-landlet', seller);
    await createTemplate('purchase-refund-no-seller-auth-template', { priceCents: 5000 });
    await placeInstance('purchase-refund-no-seller-auth-instance', 'purchase-refund-no-seller-auth-landlet', 'purchase-refund-no-seller-auth-template', seller);

    const purchased = await api('/instances/purchase-refund-no-seller-auth-instance/purchase', seller.session({ method: 'POST' }));
    const { purchaseId } = purchased.body.purchase;

    const noSession = await api(`/purchases/${purchaseId}/refund`, { method: 'POST' });
    expect(noSession.response.status).toBe(401);

    // A real, logged-in, non-admin session isn't enough either — this
    // isn't "any authenticated user," it's specifically admin.
    const nonAdmin = await signupBuilder('purchase-refund-no-seller-auth-nonadmin');
    const wrongSession = await api(`/purchases/${purchaseId}/refund`, nonAdmin.session({ method: 'POST' }));
    expect(wrongSession.response.status).toBe(403);

    const asAdmin = await api(`/purchases/${purchaseId}/refund`, adminSession({ method: 'POST' }));
    expect(asAdmin.response.status).toBe(200);
    expect(asAdmin.body.purchase.refundedAt).not.toBeNull();
  });

  it('lets the product\'s own seller refund a purchase, and rejects a different seller', async () => {
    const owningSeller = await signupSeller('purchase-refund-owner-seller');
    const otherSeller = await signupSeller('purchase-refund-other-seller');
    const builder = await signupAdmin('purchase-refund-owner-builder');
    await createGreenbeltLandletWithArea('purchase-refund-owner-landlet', 1000);
    await claim('purchase-refund-owner-landlet', builder);
    const created = await api('/catalog', owningSeller.session({
      method: 'POST',
      body: JSON.stringify({
        templateId: 'purchase-refund-owner-template',
        name: 'Seller-owned refund product',
        color: '#123456',
        dimensions: { width: 1, depth: 1, height: 1 },
        priceCents: 3000,
        sellerId: owningSeller.sellerId,
      }),
    }));
    expect(created.response.status).toBe(201);
    await placeInstance('purchase-refund-owner-instance', 'purchase-refund-owner-landlet', 'purchase-refund-owner-template', builder);

    const purchased = await api('/instances/purchase-refund-owner-instance/purchase', builder.session({ method: 'POST' }));
    const { purchaseId } = purchased.body.purchase;

    const wrongSeller = await api(`/purchases/${purchaseId}/refund`, otherSeller.session({ method: 'POST' }));
    expect(wrongSeller.response.status).toBe(403);

    const refunded = await api(`/purchases/${purchaseId}/refund`, owningSeller.session({ method: 'POST' }));
    expect(refunded.response.status).toBe(200);
    expect(refunded.body.purchase.refundedAt).not.toBeNull();

    // #813/#817: only the ownerless-fallback admin branch logs an
    // accountability entry — an ordinary seller-initiated refund (this one)
    // never touches admin_action_log at all, since no admin acted.
    const logRow = await env.DB.prepare(
      'SELECT * FROM admin_action_log WHERE action_type = ? AND target_id = ?',
    ).bind('refund_override', purchaseId).first();
    expect(logRow).toBeNull();
  });

  // DELETE /api/sellers/:sellerId deliberately leaves catalog_templates
  // (and therefore purchases) pointing at the now-deleted seller_id rather
  // than cleaning it up — docs/API.md says that's "the same as" a template
  // that already has a null seller_id. Before this test's fix, the refund
  // gate's plain `if (purchase.seller_id)` truthiness check treated that
  // dangling id as still-owned, so no session (not even admin) could ever
  // match it — the purchase became permanently un-refundable.
  it('falls back to admin refunding a purchase once the product\'s seller has since deleted their account', async () => {
    const seller = await signupSeller('purchase-refund-deleted-seller');
    const builder = await signupAdmin('purchase-refund-deleted-seller-builder');
    await createGreenbeltLandletWithArea('purchase-refund-deleted-seller-landlet', 1000);
    await claim('purchase-refund-deleted-seller-landlet', builder);
    const created = await api('/catalog', seller.session({
      method: 'POST',
      body: JSON.stringify({
        templateId: 'purchase-refund-deleted-seller-template',
        name: 'Product whose seller later deletes their account',
        color: '#123456',
        dimensions: { width: 1, depth: 1, height: 1 },
        priceCents: 2500,
        sellerId: seller.sellerId,
      }),
    }));
    expect(created.response.status).toBe(201);
    await placeInstance('purchase-refund-deleted-seller-instance', 'purchase-refund-deleted-seller-landlet', 'purchase-refund-deleted-seller-template', builder);

    const purchased = await api('/instances/purchase-refund-deleted-seller-instance/purchase', builder.session({ method: 'POST' }));
    const { purchaseId } = purchased.body.purchase;

    const sellerDeleted = await api(`/sellers/${seller.sellerId}`, seller.session({ method: 'DELETE' }));
    expect(sellerDeleted.response.status).toBe(200);

    const nonAdmin = await signupBuilder('purchase-refund-deleted-seller-nonadmin');
    const wrongSession = await api(`/purchases/${purchaseId}/refund`, nonAdmin.session({ method: 'POST' }));
    expect(wrongSession.response.status).toBe(403);

    const asAdmin = await api(`/purchases/${purchaseId}/refund`, adminSession({ method: 'POST' }));
    expect(asAdmin.response.status).toBe(200);
    expect(asAdmin.body.purchase.refundedAt).not.toBeNull();
  });

  it('lets the product\'s own seller list its sales via GET /purchases?templateId=, and rejects a different seller', async () => {
    const owningSeller = await signupSeller('purchase-list-owner-seller');
    const otherSeller = await signupSeller('purchase-list-other-seller');
    const builder = await signupAdmin('purchase-list-owner-builder');
    await createGreenbeltLandletWithArea('purchase-list-owner-landlet', 1000);
    await claim('purchase-list-owner-landlet', builder);
    const created = await api('/catalog', owningSeller.session({
      method: 'POST',
      body: JSON.stringify({
        templateId: 'purchase-list-owner-template',
        name: 'Seller-owned listing product',
        color: '#654321',
        dimensions: { width: 1, depth: 1, height: 1 },
        priceCents: 1500,
        sellerId: owningSeller.sellerId,
      }),
    }));
    expect(created.response.status).toBe(201);
    await placeInstance('purchase-list-owner-instance', 'purchase-list-owner-landlet', 'purchase-list-owner-template', builder);
    const purchased = await api('/instances/purchase-list-owner-instance/purchase', builder.session({ method: 'POST' }));

    const noSession = await api('/purchases?templateId=purchase-list-owner-template');
    expect(noSession.response.status).toBe(401);

    const wrongSeller = await api('/purchases?templateId=purchase-list-owner-template', otherSeller.session());
    expect(wrongSeller.response.status).toBe(403);

    const listed = await api('/purchases?templateId=purchase-list-owner-template', owningSeller.session());
    expect(listed.response.status).toBe(200);
    expect(listed.body.purchases).toContainEqual(
      expect.objectContaining({ purchaseId: purchased.body.purchase.purchaseId }),
    );
  });

  // #940: same dangling-seller_id class as the refund fix above -- this
  // endpoint's plain `if (template.seller_id)` truthiness check treated a
  // dangling id as still-owned, so no session (not even admin) could ever
  // match it once the seller self-deleted, permanently locking out this
  // product's sales-history view.
  it('falls back to admin listing a product\'s sales once its seller has since deleted their account', async () => {
    const seller = await signupSeller('purchase-list-deleted-seller');
    const builder = await signupAdmin('purchase-list-deleted-seller-builder');
    await createGreenbeltLandletWithArea('purchase-list-deleted-seller-landlet', 1000);
    await claim('purchase-list-deleted-seller-landlet', builder);
    const created = await api('/catalog', seller.session({
      method: 'POST',
      body: JSON.stringify({
        templateId: 'purchase-list-deleted-seller-template',
        name: 'Product whose seller later deletes their account',
        color: '#123456',
        dimensions: { width: 1, depth: 1, height: 1 },
        priceCents: 1500,
        sellerId: seller.sellerId,
      }),
    }));
    expect(created.response.status).toBe(201);
    await placeInstance('purchase-list-deleted-seller-instance', 'purchase-list-deleted-seller-landlet', 'purchase-list-deleted-seller-template', builder);
    const purchased = await api('/instances/purchase-list-deleted-seller-instance/purchase', builder.session({ method: 'POST' }));

    const sellerDeleted = await api(`/sellers/${seller.sellerId}`, seller.session({ method: 'DELETE' }));
    expect(sellerDeleted.response.status).toBe(200);

    const nonAdmin = await signupBuilder('purchase-list-deleted-seller-nonadmin');
    const wrongSession = await api('/purchases?templateId=purchase-list-deleted-seller-template', nonAdmin.session());
    expect(wrongSession.response.status).toBe(403);

    const asAdmin = await api('/purchases?templateId=purchase-list-deleted-seller-template', adminSession());
    expect(asAdmin.response.status).toBe(200);
    expect(asAdmin.body.purchases).toContainEqual(
      expect.objectContaining({ purchaseId: purchased.body.purchase.purchaseId }),
    );
  });

  // Owner (Control Room, 2026-09-10, on #651): a refund must never be
  // blocked just because a builder already redeemed their commission —
  // "a shopper should not be punished for the chance occurrence of a
  // builder cashing out... higglehaven will have to bear the financial
  // burden of the negative balance." PR #652 briefly added a 409
  // floor-guard here (see git history) that this test reverts: the
  // clawback is unconditional again and genuinely allowed to go negative.
  it('lets the clawback push a builder\'s higgles balance negative — there is no floor on a refund', async () => {
    const seller = await signupAdmin('purchase-refund-negative-seller');
    await createGreenbeltLandletWithArea('purchase-refund-negative-landlet', 1000);
    await claim('purchase-refund-negative-landlet', seller);
    await createTemplate('purchase-refund-negative-template', { priceCents: 10000 });
    await placeInstance('purchase-refund-negative-instance', 'purchase-refund-negative-landlet', 'purchase-refund-negative-template', seller);

    const purchased = await api('/instances/purchase-refund-negative-instance/purchase', seller.session({ method: 'POST' }));
    // Spend down the builder's balance below the commission they're about
    // to have clawed back, so the refund must push it negative.
    await env.DB.prepare('UPDATE builders SET higgles_balance_cents = 0 WHERE builder_id = ?').bind(seller.builderId).run();

    await api(`/purchases/${purchased.body.purchase.purchaseId}/refund`, adminSession({ method: 'POST' }));
    const after = await builderRow(seller.builderId);
    expect(after.higgles_balance_cents).toBe(-purchased.body.purchase.builderShareCents);
  });

  it('respects a seller\'s no-returns policy, rejecting the refund', async () => {
    const seller = await signupAdmin('purchase-no-returns-seller');
    await createGreenbeltLandletWithArea('purchase-no-returns-landlet', 1000);
    await claim('purchase-no-returns-landlet', seller);
    await createTemplate('purchase-no-returns-template', { priceCents: 500, metadata: { noReturns: true } });
    await placeInstance('purchase-no-returns-instance', 'purchase-no-returns-landlet', 'purchase-no-returns-template', seller);

    const purchased = await api('/instances/purchase-no-returns-instance/purchase', seller.session({ method: 'POST' }));
    const rejected = await api(`/purchases/${purchased.body.purchase.purchaseId}/refund`, adminSession({ method: 'POST' }));
    expect(rejected.response.status).toBe(400);
  });

  it('rejects a non-boolean metadata.noReturns', async () => {
    const rejected = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'purchase-bad-no-returns-template',
        name: 'Bad no-returns product',
        color: '#123456',
        dimensions: { width: 1, depth: 1, height: 1 },
        metadata: { noReturns: 'yes' },
      }),
    });
    expect(rejected.response.status).toBe(400);
  });

  // #453: real-money checkout for a seller who has fully completed Stripe
  // Connect onboarding (#452). This test suite never configures
  // STRIPE_SECRET_KEY (same dev-mode-friendly pattern as RESEND_API_KEY
  // and stripe-connect.test.js's own tests), so the actual PaymentIntent-
  // creation/confirmation round trip can't be exercised here — only the
  // fallback behavior and handlePurchaseFinalize's own validation/
  // idempotency logic, which run entirely without a live Stripe call.
  describe('Real-money checkout (#453)', () => {
    it('still uses the simulated purchase path when Stripe is not configured, even for a fully connected seller', async () => {
      const seller = await signupSeller('checkout-fallback-seller');
      const builder = await signupAdmin('checkout-fallback-builder');
      await createGreenbeltLandletWithArea('checkout-fallback-landlet', 1000);
      await claim('checkout-fallback-landlet', builder);
      const created = await api('/catalog', seller.session({
        method: 'POST',
        body: JSON.stringify({
          templateId: 'checkout-fallback-template',
          name: 'Connected-seller product',
          color: '#123456',
          dimensions: { width: 1, depth: 1, height: 1 },
          priceCents: 5000,
          sellerId: seller.sellerId,
        }),
      }));
      expect(created.response.status).toBe(201);
      await placeInstance('checkout-fallback-instance', 'checkout-fallback-landlet', 'checkout-fallback-template', builder);

      // Simulates a seller who has finished onboarding (#452's own POST
      // endpoint is what would normally set these, but that requires a
      // real Stripe call this test suite deliberately never makes).
      await env.DB.prepare(`
        UPDATE sellers SET stripe_account_id = 'acct_test123', stripe_onboarding_status = 'complete' WHERE seller_id = ?
      `).bind(seller.sellerId).run();

      const purchased = await api('/instances/checkout-fallback-instance/purchase', builder.session({ method: 'POST' }));
      expect(purchased.response.status).toBe(201);
      expect(purchased.body.purchase).toMatchObject({ totalCents: 5000, paymentIntentId: null });
      expect(purchased.body.requiresPayment).toBeUndefined();
    });

    it('validates paymentIntentId before checking whether Stripe is configured', async () => {
      const missing = await api('/purchases/finalize', { method: 'POST', body: JSON.stringify({}) });
      expect(missing.response.status).toBe(400);

      const wrongType = await api('/purchases/finalize', { method: 'POST', body: JSON.stringify({ paymentIntentId: 42 }) });
      expect(wrongType.response.status).toBe(400);
    });

    it('503s once a well-formed but unknown paymentIntentId passes validation, since Stripe is never configured in this test suite', async () => {
      const notConfigured = await api('/purchases/finalize', {
        method: 'POST',
        body: JSON.stringify({ paymentIntentId: 'pi_does_not_exist' }),
      });
      expect(notConfigured.response.status).toBe(503);
    });

    it('is idempotent for an already-finalized paymentIntentId, entirely without needing Stripe configured', async () => {
      const seller = await signupAdmin('checkout-idempotent-seller');
      await createGreenbeltLandletWithArea('checkout-idempotent-landlet', 1000);
      await claim('checkout-idempotent-landlet', seller);
      await createTemplate('checkout-idempotent-template', { priceCents: 2000 });
      await placeInstance('checkout-idempotent-instance', 'checkout-idempotent-landlet', 'checkout-idempotent-template', seller);
      const purchased = await api('/instances/checkout-idempotent-instance/purchase', seller.session({ method: 'POST' }));
      const { purchaseId } = purchased.body.purchase;

      // Directly attaches a payment_intent_id to an existing (simulated)
      // purchase to stand in for one handlePurchaseFinalize itself wrote
      // — the idempotency lookup only cares that a purchases row already
      // carries this id, not how it got there.
      await env.DB.prepare('UPDATE purchases SET payment_intent_id = ? WHERE purchase_id = ?')
        .bind('pi_already_finalized', purchaseId).run();

      const finalized = await api('/purchases/finalize', {
        method: 'POST',
        body: JSON.stringify({ paymentIntentId: 'pi_already_finalized' }),
      });
      expect(finalized.response.status).toBe(200);
      expect(finalized.body.purchase.purchaseId).toBe(purchaseId);
    });

    // #839: this endpoint makes a real outbound Stripe API call on every
    // invocation and is unauthenticated by design (no buyer account exists
    // in this app), so it's keyed by client IP the same way every other
    // unauthenticated repeatable write in this file is rate-limited.
    it('rate-limits finalize attempts per client IP', async () => {
      const ip = `test-finalize-rate-limit-${crypto.randomUUID()}`;
      for (let i = 0; i < 20; i++) {
        const response = await api('/purchases/finalize', {
          method: 'POST',
          body: JSON.stringify({ paymentIntentId: `pi_rate_limit_probe_${i}` }),
          headers: { 'cf-connecting-ip': ip },
        });
        // 503 (Stripe not configured in this suite) either way -- the point
        // is that the rate limiter itself, not Stripe config, is what
        // eventually returns 429 below.
        expect(response.response.status).toBe(503);
      }
      const limited = await api('/purchases/finalize', {
        method: 'POST',
        body: JSON.stringify({ paymentIntentId: 'pi_rate_limit_probe_final' }),
        headers: { 'cf-connecting-ip': ip },
      });
      expect(limited.response.status).toBe(429);
    });
  });

  // #1084: handlePurchaseFinalize used to re-derive the builder to credit
  // from a live `landlets.owner_builder_id` lookup instead of the
  // checkout-time-locked `meta.builderId` -- if an auction on the same
  // landlet resolved in the gap between checkout and finalize, the live
  // lookup would silently credit the auction's new winner instead of the
  // seller who actually made the sale. resolveFinalizeBuilderId is the
  // extracted decision logic that now backs handlePurchaseFinalize's own
  // choice -- exercised directly here (rather than via the real checkout->
  // finalize HTTP flow) since that flow only ever reaches this logic via a
  // live Stripe call, which this test suite deliberately never configures.
  describe('resolveFinalizeBuilderId honors the checkout-time-locked builder (#1084)', () => {
    it('returns the checkout-time builderId regardless of who currently owns the landlet', async () => {
      const originalSeller = await signupBuilder('finalize-builder-original-seller');
      // A second, unrelated builder stands in for "whoever a live landlet
      // lookup would now return" (e.g. an auction winner) -- the fix means
      // this account is never even queried, let alone credited.
      await signupBuilder('finalize-builder-auction-winner');

      const resolved = await resolveFinalizeBuilderId(env.DB, { builderId: originalSeller.builderId });
      expect(resolved).toBe(originalSeller.builderId);
    });

    it('returns null when the checkout-time builder has since self-deleted', async () => {
      const seller = await signupBuilder('finalize-builder-self-deleted');
      const deleted = await api(`/builders/${seller.builderId}`, seller.session({ method: 'DELETE' }));
      expect(deleted.response.status).toBe(200);

      const resolved = await resolveFinalizeBuilderId(env.DB, { builderId: seller.builderId });
      expect(resolved).toBeNull();
    });

    it('returns null when the metadata carries no builderId at all', async () => {
      const resolved = await resolveFinalizeBuilderId(env.DB, {});
      expect(resolved).toBeNull();
    });
  });

  // #348: refunding a real-money purchase (one with a paymentIntentId, see
  // #453) needs to reverse the actual Stripe charge, not just flag the
  // local row. Same limitation as the "Real-money checkout" tests above —
  // this suite never configures STRIPE_SECRET_KEY, so the only exercisable
  // path is the 503 "not configured" branch — which is exactly what proves
  // the important safety property: a purchase whose Stripe reversal never
  // happened must not end up looking refunded, and the builder's higgles
  // share must stay untouched until it does.
  describe('Real-money refunds (#348)', () => {
    it('leaves the purchase unrefunded and the builder\'s balance untouched when Stripe is not configured', async () => {
      const seller = await signupAdmin('real-refund-seller');
      await createGreenbeltLandletWithArea('real-refund-landlet', 1000);
      await claim('real-refund-landlet', seller);
      await createTemplate('real-refund-template', { priceCents: 8000 });
      await placeInstance('real-refund-instance', 'real-refund-landlet', 'real-refund-template', seller);
      const purchased = await api('/instances/real-refund-instance/purchase', seller.session({ method: 'POST' }));
      const { purchaseId } = purchased.body.purchase;

      // Stands in for a real-money purchase handlePurchaseFinalize would
      // have written (same technique as the idempotent-finalize test
      // above) — the refund path only cares that payment_intent_id is set.
      await env.DB.prepare('UPDATE purchases SET payment_intent_id = ? WHERE purchase_id = ?')
        .bind('pi_real_refund_test', purchaseId).run();

      const before = await builderRow(seller.builderId);
      const refunded = await api(`/purchases/${purchaseId}/refund`, adminSession({ method: 'POST' }));
      expect(refunded.response.status).toBe(503);

      const purchaseRow = await env.DB.prepare('SELECT refunded_at FROM purchases WHERE purchase_id = ?').bind(purchaseId).first();
      expect(purchaseRow.refunded_at).toBeNull();
      const after = await builderRow(seller.builderId);
      expect(after.higgles_balance_cents).toBe(before.higgles_balance_cents);

      // The refunded_at guard was released, not left stuck — a retry (once
      // Stripe is actually configured) isn't permanently blocked by this
      // failed attempt.
      const retried = await api(`/purchases/${purchaseId}/refund`, adminSession({ method: 'POST' }));
      expect(retried.response.status).toBe(503);
    });

    // #871: the refund's Stripe call previously passed no idempotency key at
    // all, so a lost-response retry would have Stripe process a second real
    // refund. Same fix shape as #869's builder/seller payout keys — verified
    // directly since STRIPE_SECRET_KEY is never configured in this suite.
    it('refundIdempotencyKey is stable for the same purchase and differs across purchases', () => {
      expect(refundIdempotencyKey('purchase-abc')).toBe(refundIdempotencyKey('purchase-abc'));
      expect(refundIdempotencyKey('purchase-abc')).not.toBe(refundIdempotencyKey('purchase-xyz'));
    });

    // #1302: same "real outbound Stripe API call on the shared key" gap
    // #948/#1050 already closed for the other Stripe-calling handlers --
    // handlePurchaseRefund had no checkRateLimit call at all. Direct-inserts
    // 21 already-refundable (no payment_intent_id, so no Stripe call) purchase
    // rows for one seller, same technique as the mark-shipped rate-limit test,
    // rather than calling the much more expensive purchase flow 21 times.
    it('rate-limits repeated refund attempts from the same seller', async () => {
      const builder = await signupBuilder('refund-rate-limit-builder');
      const seller = await signupSeller('refund-rate-limit-seller');
      const purchaseIds = Array.from({ length: 21 }, (_, i) => `refund-rate-limit-purchase-${i}`);
      await env.DB.batch(purchaseIds.map((purchaseId) => env.DB.prepare(`
        INSERT INTO purchases (
          purchase_id, instance_id, template_id, builder_id, seller_id, unit_price_cents, quantity,
          total_cents, commission_cents, builder_share_cents, platform_share_cents
        ) VALUES (?, ?, ?, ?, ?, 5000, 1, 5000, 100, 4900, 100)
      `).bind(purchaseId, `${purchaseId}-instance`, `${purchaseId}-template`, builder.builderId, seller.sellerId)));

      for (let i = 0; i < 20; i++) {
        const attempt = await api(`/purchases/${purchaseIds[i]}/refund`, seller.session({ method: 'POST' }));
        expect(attempt.response.status).toBe(200);
      }
      const limited = await api(`/purchases/${purchaseIds[20]}/refund`, seller.session({ method: 'POST' }));
      expect(limited.response.status).toBe(429);
    }, 30000); // #1656: same 21-sequential-request shape as the mark-shipped
    // rate-limit test just below, which already carries this same override
    // -- missed here when this test was authored "using the same technique."
  });

  // #732: unlike DELETE /api/builders/:builderId (which already guards a
  // pending auction payout), DELETE /api/sellers/:sellerId had no guard at
  // all against real-money proceeds still owed to the seller — deleting it
  // strands that money, since getOrCreateSellerForUser is keyed by user_id
  // and mints a brand-new, Stripe-account-less seller_id on next lookup.
  describe('Seller deletion (#732)', () => {
    it('rejects deleting a seller with an unpaid real-money purchase, and allows it again once paid out', async () => {
      const seller = await signupSeller('unpaid-payout-delete-seller');
      const builder = await signupAdmin('unpaid-payout-delete-builder');
      await createGreenbeltLandletWithArea('unpaid-payout-delete-landlet', 1000);
      await claim('unpaid-payout-delete-landlet', builder);
      const created = await api('/catalog', seller.session({
        method: 'POST',
        body: JSON.stringify({
          templateId: 'unpaid-payout-delete-template',
          name: 'Product with an unpaid real-money sale',
          color: '#123456',
          dimensions: { width: 1, depth: 1, height: 1 },
          priceCents: 3000,
          sellerId: seller.sellerId,
        }),
      }));
      expect(created.response.status).toBe(201);
      await placeInstance('unpaid-payout-delete-instance', 'unpaid-payout-delete-landlet', 'unpaid-payout-delete-template', builder);

      const purchased = await api('/instances/unpaid-payout-delete-instance/purchase', builder.session({ method: 'POST' }));
      const { purchaseId } = purchased.body.purchase;

      // Stands in for a real-money purchase handlePurchaseFinalize would
      // have written (same technique as the refund tests above) — the
      // deletion guard only cares that payment_intent_id is set and
      // paid_out_at/refunded_at are not.
      await env.DB.prepare('UPDATE purchases SET payment_intent_id = ? WHERE purchase_id = ?')
        .bind('pi_unpaid_payout_delete_test', purchaseId).run();

      const blocked = await api(`/sellers/${seller.sellerId}`, seller.session({ method: 'DELETE' }));
      expect(blocked.response.status).toBe(409);
      expect(blocked.body).toEqual({
        error: "Cannot delete this seller while a real-money purchase's proceeds are still unpaid — request a payout first",
      });
      const stillThere = await env.DB.prepare('SELECT seller_id FROM sellers WHERE seller_id = ?')
        .bind(seller.sellerId).first();
      expect(stillThere).not.toBeNull();

      // Once the payout actually lands, deletion is allowed again — same
      // "guard released, not stuck" shape as the builder-deletion guards.
      // Both paid_out_at and stripe_payout_id, matching what a real
      // successful payout actually writes (#745's own guard checks both).
      await env.DB.prepare('UPDATE purchases SET paid_out_at = ?, stripe_payout_id = ? WHERE purchase_id = ?')
        .bind('2024-01-01T00:00:00.000Z', 'po_unpaid_payout_delete_test', purchaseId).run();
      const deleted = await api(`/sellers/${seller.sellerId}`, seller.session({ method: 'DELETE' }));
      expect(deleted.response.status).toBe(200);
    });

    // #745: claimPurchasesForPayout stamps paid_out_at before the Stripe
    // payout call resolves, so a purchase can sit in an ambiguous
    // "claimed, not yet confirmed" state (paid_out_at set, stripe_payout_id
    // still null) for the duration of that outbound call. The original
    // #732 guard only checked paid_out_at, so a delete landing in that
    // exact window would have slipped through — reproduced here by writing
    // that same in-flight state directly, without ever calling the real
    // payout endpoint.
    it('rejects deleting a seller whose purchase is claimed for payout but not yet Stripe-confirmed', async () => {
      const seller = await signupSeller('inflight-payout-delete-seller');
      const builder = await signupAdmin('inflight-payout-delete-builder');
      await createGreenbeltLandletWithArea('inflight-payout-delete-landlet', 1000);
      await claim('inflight-payout-delete-landlet', builder);
      const created = await api('/catalog', seller.session({
        method: 'POST',
        body: JSON.stringify({
          templateId: 'inflight-payout-delete-template',
          name: 'Product mid-payout',
          color: '#abcdef',
          dimensions: { width: 1, depth: 1, height: 1 },
          priceCents: 3000,
          sellerId: seller.sellerId,
        }),
      }));
      expect(created.response.status).toBe(201);
      await placeInstance('inflight-payout-delete-instance', 'inflight-payout-delete-landlet', 'inflight-payout-delete-template', builder);
      const purchased = await api('/instances/inflight-payout-delete-instance/purchase', builder.session({ method: 'POST' }));
      const { purchaseId } = purchased.body.purchase;
      await env.DB.prepare('UPDATE purchases SET payment_intent_id = ? WHERE purchase_id = ?')
        .bind('pi_inflight_payout_delete_test', purchaseId).run();

      // The in-flight state claimPurchasesForPayout leaves a purchase in
      // for the duration of the (here, never-made) outbound Stripe call.
      await env.DB.prepare('UPDATE purchases SET paid_out_at = ? WHERE purchase_id = ?')
        .bind('2024-01-01T00:00:00.000Z', purchaseId).run();

      const blocked = await api(`/sellers/${seller.sellerId}`, seller.session({ method: 'DELETE' }));
      expect(blocked.response.status).toBe(409);
      const stillThere = await env.DB.prepare('SELECT seller_id FROM sellers WHERE seller_id = ?')
        .bind(seller.sellerId).first();
      expect(stillThere).not.toBeNull();

      // Once stripe_payout_id lands (the claim actually confirmed), deletion
      // is allowed — same release-not-stuck shape as the base case above.
      await env.DB.prepare('UPDATE purchases SET stripe_payout_id = ? WHERE purchase_id = ?')
        .bind('po_inflight_payout_delete_test', purchaseId).run();
      const deleted = await api(`/sellers/${seller.sellerId}`, seller.session({ method: 'DELETE' }));
      expect(deleted.response.status).toBe(200);
    });

    it('still allows deleting a seller whose only purchase is a simulated (no payment_intent_id) sale', async () => {
      const seller = await signupSeller('sim-sale-deletable-seller');
      const builder = await signupAdmin('sim-sale-deletable-builder');
      await createGreenbeltLandletWithArea('sim-sale-deletable-landlet', 1000);
      await claim('sim-sale-deletable-landlet', builder);
      const created = await api('/catalog', seller.session({
        method: 'POST',
        body: JSON.stringify({
          templateId: 'sim-sale-deletable-template',
          name: 'Simulated-sale product',
          color: '#654321',
          dimensions: { width: 1, depth: 1, height: 1 },
          priceCents: 1500,
          sellerId: seller.sellerId,
        }),
      }));
      expect(created.response.status).toBe(201);
      await placeInstance('sim-sale-deletable-instance', 'sim-sale-deletable-landlet', 'sim-sale-deletable-template', builder);
      const purchased = await api('/instances/sim-sale-deletable-instance/purchase', builder.session({ method: 'POST' }));
      expect(purchased.body.purchase.paymentIntentId).toBeNull();

      const deleted = await api(`/sellers/${seller.sellerId}`, seller.session({ method: 'DELETE' }));
      expect(deleted.response.status).toBe(200);
    });

    // #1003: same snapshot-before-losing-the-live-row shape as the builder
    // deletion handler's own test in profiles.test.js -- see that handler's
    // comment (and the issue-1003 comment it cites) for why the connected
    // Stripe account itself is left untouched here.
    it('snapshots a connected Stripe account into retained_stripe_accounts on seller deletion', async () => {
      const seller = await signupSeller('retain-stripe-delete-seller');
      await env.DB.prepare(`
        UPDATE sellers SET stripe_account_id = 'acct_retain_test_seller', stripe_onboarding_status = 'complete' WHERE seller_id = ?
      `).bind(seller.sellerId).run();

      const deleted = await api(`/sellers/${seller.sellerId}`, seller.session({ method: 'DELETE' }));
      expect(deleted.response.status).toBe(200);

      const retained = await env.DB.prepare(
        'SELECT * FROM retained_stripe_accounts WHERE source = ? AND source_id = ?',
      ).bind('seller', seller.sellerId).first();
      expect(retained).toMatchObject({
        source: 'seller',
        source_id: seller.sellerId,
        stripe_account_id: 'acct_retain_test_seller',
        stripe_onboarding_status: 'complete',
      });
      expect(retained.deleted_at).toBeTruthy();
    });

    it('does not snapshot anything on seller deletion when no Stripe account was ever connected', async () => {
      const seller = await signupSeller('no-stripe-delete-seller');
      const deleted = await api(`/sellers/${seller.sellerId}`, seller.session({ method: 'DELETE' }));
      expect(deleted.response.status).toBe(200);

      const retained = await env.DB.prepare(
        'SELECT * FROM retained_stripe_accounts WHERE source = ? AND source_id = ?',
      ).bind('seller', seller.sellerId).first();
      expect(retained).toBeNull();
    });
  });
});
