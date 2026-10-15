import {
  applyD1Migrations, env,
} from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  claimPurchasesForPayout, sellerPayoutIdempotencyKey, claimOrResumeSellerPayout, selectPurchasesForPayout,
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

// #454: seller payout/cash-out hold policy. Same limitation as the
// "Real-money checkout"/"Real-money refunds" tests in worker/purchases.test.js
// — this suite never configures STRIPE_SECRET_KEY, so the actual Stripe
// balance/payout API calls can't be exercised here. What's fully
// testable without Stripe, and is the actual point of this feature, is
// the hold-eligibility logic itself: it's pure DB state (payment_intent_id/
// is_digital_good/shipped_at/delivery_confirmed_at/refunded_at), gated
// by handleSellerPayouts' GET summary, mark-shipped, and confirm-delivery
// — none of which touch Stripe at all.
describe('Seller payouts (#454)', () => {
  async function sha256Hex(text) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  async function createConnectedSeller(label) {
    const seller = await signupSeller(label);
    // Stands in for a completed #452 onboarding (a real Stripe Connect
    // account create/verify round trip, never exercised in this suite)
    // — the payout logic under test only cares that these columns say
    // "connected and complete".
    await env.DB.prepare(`
      UPDATE sellers SET stripe_account_id = 'acct_test_payout', stripe_onboarding_status = 'complete' WHERE seller_id = ?
    `).bind(seller.sellerId).run();
    return seller;
  }

  // Same technique as "Real-money checkout"/"Real-money refunds" above:
  // create the ordinary simulated purchase (Stripe isn't configured, so
  // this is what /instances/:id/purchase actually does), then directly
  // set the columns a real #453 finalize would have written.
  async function makeRealMoneyPurchase(builder, seller, { isDigitalGood = false, deliveryConfirmToken } = {}) {
    const suffix = crypto.randomUUID().slice(0, 8);
    const landletId = `payout-landlet-${suffix}`;
    const templateId = `payout-template-${suffix}`;
    const instanceId = `payout-instance-${suffix}`;
    await createGreenbeltLandletWithArea(landletId, 1000);
    await claim(landletId, builder);
    const created = await api('/catalog', seller.session({
      method: 'POST',
      body: JSON.stringify({
        templateId,
        name: `Payout product ${templateId}`,
        color: '#654321',
        dimensions: { width: 1, depth: 1, height: 1 },
        priceCents: 5000,
        sellerId: seller.sellerId,
      }),
    }));
    expect(created.response.status).toBe(201);
    await placeInstance(instanceId, landletId, templateId, builder);
    const purchased = await api(`/instances/${instanceId}/purchase`, builder.session({ method: 'POST' }));
    expect(purchased.response.status).toBe(201);
    const { purchaseId } = purchased.body.purchase;
    const tokenHash = deliveryConfirmToken ? await sha256Hex(deliveryConfirmToken) : null;
    await env.DB.prepare(`
      UPDATE purchases SET payment_intent_id = ?, is_digital_good = ?, delivery_confirm_token_hash = ? WHERE purchase_id = ?
    `).bind(`pi_${suffix}`, isDigitalGood ? 1 : 0, tokenHash, purchaseId).run();
    return purchaseId;
  }

  it('requires a session for the payout summary', async () => {
    const got = await api('/sellers/me/payouts');
    expect(got.response.status).toBe(401);
  });

  it('a digital good is available for payout immediately, with 2% commission excluded', async () => {
    const builder = await signupBuilder('payout-digital-builder');
    const seller = await createConnectedSeller('payout-digital-seller');
    await makeRealMoneyPurchase(builder, seller, { isDigitalGood: true });

    const summary = await api('/sellers/me/payouts', seller.session());
    expect(summary.response.status).toBe(200);
    expect(summary.body.availableCents).toBe(4900); // 5000 - 2% commission
    expect(summary.body.heldCents).toBe(0);
  });

  it('a physical good stays held until shipped, and only its own seller can mark it shipped', async () => {
    const builder = await signupBuilder('payout-physical-builder');
    const seller = await createConnectedSeller('payout-physical-seller');
    const stranger = await createConnectedSeller('payout-physical-stranger');
    const purchaseId = await makeRealMoneyPurchase(builder, seller);

    const heldSummary = await api('/sellers/me/payouts', seller.session());
    expect(heldSummary.body.availableCents).toBe(0);
    expect(heldSummary.body.heldCents).toBe(4900);
    expect(heldSummary.body.nextEligibleAt).toBeNull(); // not shipped yet — no countdown started

    const unauthenticated = await api(`/purchases/${purchaseId}/mark-shipped`, { method: 'POST' });
    expect(unauthenticated.response.status).toBe(401);

    const byStranger = await api(`/purchases/${purchaseId}/mark-shipped`, stranger.session({ method: 'POST' }));
    expect(byStranger.response.status).toBe(403);

    const shipped = await api(`/purchases/${purchaseId}/mark-shipped`, seller.session({ method: 'POST' }));
    expect(shipped.response.status).toBe(200);
    expect(shipped.body.purchase.shippedAt).toBeTruthy();

    // Still held right after shipping — the 7-day fallback clock has
    // only just started, and there's no delivery confirmation either.
    const afterShip = await api('/sellers/me/payouts', seller.session());
    expect(afterShip.body.availableCents).toBe(0);
    expect(afterShip.body.heldCents).toBe(4900);
    expect(afterShip.body.nextEligibleAt).toBeTruthy();

    const reShipped = await api(`/purchases/${purchaseId}/mark-shipped`, seller.session({ method: 'POST' }));
    expect(reShipped.response.status).toBe(409);
  });

  // #1288: every other "something happened that the other party should
  // passively learn about" event already fires a notification -- the
  // buyer waiting on a physical purchase was the one missing.
  it('notifies the buyer once their purchase is marked shipped', async () => {
    const builder = await signupBuilder('mark-shipped-notify-builder');
    const seller = await createConnectedSeller('mark-shipped-notify-seller');
    const purchaseId = await makeRealMoneyPurchase(builder, seller);

    const shipped = await api(`/purchases/${purchaseId}/mark-shipped`, seller.session({ method: 'POST' }));
    expect(shipped.response.status).toBe(200);

    const notices = await api('/notifications', builder.session());
    expect(notices.body.notifications.some((n) => n.message.includes('has shipped!'))).toBe(true);
  });

  // #925: the sequential re-ship test above only proves a repeat call
  // after the first one is already committed gets a 400 — it doesn't
  // exercise the actual race, two requests genuinely concurrent
  // (Promise.all, not awaited one at a time), which a plain check-then-
  // act UPDATE with no WHERE shipped_at IS NULL guard could let both
  // pass the read-check and both write. Exactly one should win.
  it('does not let two concurrent mark-shipped requests both succeed', async () => {
    const builder = await signupBuilder('payout-shipped-race-builder');
    const seller = await createConnectedSeller('payout-shipped-race-seller');
    const purchaseId = await makeRealMoneyPurchase(builder, seller);

    const [first, second] = await Promise.all([
      api(`/purchases/${purchaseId}/mark-shipped`, seller.session({ method: 'POST' })),
      api(`/purchases/${purchaseId}/mark-shipped`, seller.session({ method: 'POST' })),
    ]);
    expect([first.response.status, second.response.status].sort()).toEqual([200, 409]);
  });

  // #1249: unlike other owner-gated repeatable mutations in this file
  // (saved-layout deletes, product-review deletes, etc.), mark-shipped had
  // no checkRateLimit call at all. Direct-inserts 21 already-real-money,
  // not-yet-shipped purchase rows for one seller (same technique as
  // worker/land.test.js's own saved-layout-delete rate-limit test) rather
  // than calling the much more expensive makeRealMoneyPurchase 21 times.
  it('rate-limits repeated mark-shipped calls from the same seller', async () => {
    const builder = await signupBuilder('mark-shipped-rate-limit-builder');
    const seller = await createConnectedSeller('mark-shipped-rate-limit-seller');
    const purchaseIds = Array.from({ length: 21 }, (_, i) => `mark-shipped-rate-limit-purchase-${i}`);
    await env.DB.batch(purchaseIds.map((purchaseId) => env.DB.prepare(`
      INSERT INTO purchases (
        purchase_id, instance_id, template_id, builder_id, seller_id, unit_price_cents, quantity,
        total_cents, commission_cents, builder_share_cents, platform_share_cents, payment_intent_id
      ) VALUES (?, ?, ?, ?, ?, 5000, 1, 5000, 100, 4900, 100, ?)
    `).bind(purchaseId, `${purchaseId}-instance`, `${purchaseId}-template`, builder.builderId, seller.sellerId, `pi_${purchaseId}`)));

    for (let i = 0; i < 20; i++) {
      const attempt = await api(`/purchases/${purchaseIds[i]}/mark-shipped`, seller.session({ method: 'POST' }));
      expect(attempt.response.status).toBe(200);
    }
    const limited = await api(`/purchases/${purchaseIds[20]}/mark-shipped`, seller.session({ method: 'POST' }));
    expect(limited.response.status).toBe(429);
  }, 30000);

  // #937: seller_id can be non-null yet dangling once DELETE /api/sellers/:id
  // removes the seller row it points at. Before this fix, the plain
  // `if (purchase.seller_id)` truthiness check treated that dangling id as
  // still-owned, so no session (not even admin) could ever match it — the
  // purchase became permanently un-shippable, unlike its refund sibling
  // which already falls back to admin for this exact case.
  it("falls back to admin marking a purchase shipped once the product's seller has since deleted their account", async () => {
    const builder = await signupBuilder('payout-shipped-deleted-seller-builder');
    const seller = await createConnectedSeller('payout-shipped-deleted-seller-seller');
    const purchaseId = await makeRealMoneyPurchase(builder, seller);
    // DELETE /api/sellers/:id blocks while a purchase's proceeds are
    // unpaid -- stamp paid_out_at/stripe_payout_id first, same as the
    // real flow the issue describes (a seller can only self-delete once
    // shipped_at doesn't matter to that guard, but payout does).
    await env.DB.prepare(`
      UPDATE purchases SET paid_out_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), stripe_payout_id = 'po_test' WHERE purchase_id = ?
    `).bind(purchaseId).run();

    const sellerDeleted = await api(`/sellers/${seller.sellerId}`, seller.session({ method: 'DELETE' }));
    expect(sellerDeleted.response.status).toBe(200);

    const nonAdmin = await signupBuilder('payout-shipped-deleted-seller-nonadmin');
    const wrongSession = await api(`/purchases/${purchaseId}/mark-shipped`, nonAdmin.session({ method: 'POST' }));
    expect(wrongSession.response.status).toBe(403);

    const asAdmin = await api(`/purchases/${purchaseId}/mark-shipped`, adminSession({ method: 'POST' }));
    expect(asAdmin.response.status).toBe(200);
    expect(asAdmin.body.purchase.shippedAt).toBeTruthy();

    const logRow = await env.DB.prepare(
      'SELECT * FROM admin_action_log WHERE action_type = ? AND target_id = ?',
    ).bind('mark_shipped_override', purchaseId).first();
    expect(logRow).not.toBeNull();
  });

  // #749: handlePurchaseRefund treats refunded_at as authoritative (it
  // rejects a second refund), but mark-shipped and confirm-delivery never
  // checked it at all — a refunded physical order could still be marked
  // shipped, or delivery-confirmed via the buyer's own token link, leaving
  // contradictory state on the purchase row.
  it('rejects marking a refunded purchase as shipped, or confirming its delivery', async () => {
    const builder = await signupBuilder('payout-refunded-shipped-builder');
    const seller = await createConnectedSeller('payout-refunded-shipped-seller');
    const rawToken = `test-refunded-delivery-token-${crypto.randomUUID()}`;
    const purchaseId = await makeRealMoneyPurchase(builder, seller, { deliveryConfirmToken: rawToken });
    await env.DB.prepare(`UPDATE purchases SET refunded_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE purchase_id = ?`)
      .bind(purchaseId).run();

    const shipRejected = await api(`/purchases/${purchaseId}/mark-shipped`, seller.session({ method: 'POST' }));
    expect(shipRejected.response.status).toBe(400);
    const row = await env.DB.prepare('SELECT shipped_at FROM purchases WHERE purchase_id = ?').bind(purchaseId).first();
    expect(row.shipped_at).toBeNull();

    const confirmRejected = await api('/purchases/confirm-delivery', {
      method: 'POST', body: JSON.stringify({ token: rawToken }),
    });
    expect(confirmRejected.response.status).toBe(400);
    const rowAfterConfirm = await env.DB.prepare('SELECT delivery_confirmed_at FROM purchases WHERE purchase_id = ?')
      .bind(purchaseId).first();
    expect(rowAfterConfirm.delivery_confirmed_at).toBeNull();
  });

  // #1384: #749's own test above only covers a purchase ALREADY refunded
  // before mark-shipped/confirm-delivery is ever called — it doesn't
  // exercise the race where a refund lands in the gap between the eager
  // refunded_at read and the atomic UPDATE. Same db.prepare-interception
  // idiom worker/land.test.js already uses for this exact race shape
  // (injecting the concurrent write right as the real statement's own SQL
  // is about to run, deterministically landing it inside the window a
  // real two-request race would only hit by chance).
  it('rejects marking shipped if the purchase is refunded in the window between the check and the write', async () => {
    const builder = await signupBuilder('payout-shipped-refund-race-builder');
    const seller = await createConnectedSeller('payout-shipped-refund-race-seller');
    const purchaseId = await makeRealMoneyPurchase(builder, seller);

    const originalPrepare = env.DB.prepare.bind(env.DB);
    let armed = true;
    env.DB.prepare = (sql) => {
      if (armed && sql.includes('UPDATE purchases SET shipped_at')) {
        armed = false;
        originalPrepare('UPDATE purchases SET refunded_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\', \'now\') WHERE purchase_id = ?')
          .bind(purchaseId).run();
      }
      return originalPrepare(sql);
    };
    let rejected;
    try {
      rejected = await api(`/purchases/${purchaseId}/mark-shipped`, seller.session({ method: 'POST' }));
    } finally {
      env.DB.prepare = originalPrepare;
    }
    expect(rejected.response.status).toBe(400);
    expect(rejected.body.error).toMatch(/refunded/);

    const row = await env.DB.prepare('SELECT shipped_at, refunded_at FROM purchases WHERE purchase_id = ?').bind(purchaseId).first();
    expect(row.shipped_at).toBeNull();
    expect(row.refunded_at).not.toBeNull();
  });

  it('rejects confirming delivery if the purchase is refunded in the window between the check and the write', async () => {
    const builder = await signupBuilder('payout-confirm-refund-race-builder');
    const seller = await createConnectedSeller('payout-confirm-refund-race-seller');
    const rawToken = `test-confirm-refund-race-token-${crypto.randomUUID()}`;
    const purchaseId = await makeRealMoneyPurchase(builder, seller, { deliveryConfirmToken: rawToken });

    const originalPrepare = env.DB.prepare.bind(env.DB);
    let armed = true;
    env.DB.prepare = (sql) => {
      if (armed && sql.includes('UPDATE purchases SET delivery_confirmed_at')) {
        armed = false;
        originalPrepare('UPDATE purchases SET refunded_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\', \'now\') WHERE purchase_id = ?')
          .bind(purchaseId).run();
      }
      return originalPrepare(sql);
    };
    let rejected;
    try {
      rejected = await api('/purchases/confirm-delivery', {
        method: 'POST', body: JSON.stringify({ token: rawToken }),
      });
    } finally {
      env.DB.prepare = originalPrepare;
    }
    expect(rejected.response.status).toBe(400);
    expect(rejected.body.error).toMatch(/refunded/);

    const row = await env.DB.prepare('SELECT delivery_confirmed_at, refunded_at FROM purchases WHERE purchase_id = ?').bind(purchaseId).first();
    expect(row.delivery_confirmed_at).toBeNull();
    expect(row.refunded_at).not.toBeNull();
  });

  it('rejects marking a digital good or a simulated purchase as shipped', async () => {
    const builder = await signupBuilder('payout-mark-shipped-reject-builder');
    const seller = await createConnectedSeller('payout-mark-shipped-reject-seller');
    const digitalPurchaseId = await makeRealMoneyPurchase(builder, seller, { isDigitalGood: true });
    const digitalRejected = await api(`/purchases/${digitalPurchaseId}/mark-shipped`, seller.session({ method: 'POST' }));
    expect(digitalRejected.response.status).toBe(400);

    // No payment_intent_id at all — an ordinary simulated (higgles) sale.
    // A separate builder claims this one: `builder` above already holds
    // its own claimed landlet from makeRealMoneyPurchase, and a builder
    // can only ever hold one claimed landlet at a time.
    const secondBuilder = await signupBuilder('payout-mark-shipped-reject-builder-2');
    await createGreenbeltLandletWithArea('payout-simulated-landlet', 1000);
    await claim('payout-simulated-landlet', secondBuilder);
    const simTemplate = await api('/catalog', seller.session({
      method: 'POST',
      body: JSON.stringify({
        templateId: 'payout-simulated-template', name: 'Simulated product', color: '#111111',
        dimensions: { width: 1, depth: 1, height: 1 }, priceCents: 2000, sellerId: seller.sellerId,
      }),
    }));
    expect(simTemplate.response.status).toBe(201);
    await placeInstance('payout-simulated-instance', 'payout-simulated-landlet', 'payout-simulated-template', secondBuilder);
    const simPurchased = await api('/instances/payout-simulated-instance/purchase', secondBuilder.session({ method: 'POST' }));
    expect(simPurchased.response.status).toBe(201);
    const simRejected = await api(`/purchases/${simPurchased.body.purchase.purchaseId}/mark-shipped`,
      seller.session({ method: 'POST' }));
    expect(simRejected.response.status).toBe(400);

    // The simulated purchase never shows up in the payout summary at all
    // — availableCents is exactly the earlier digital purchase's own
    // share (4900), nothing added by the simulated one, and heldCents
    // stays 0 since nothing real is held either.
    const summary = await api('/sellers/me/payouts', seller.session());
    expect(summary.body.availableCents).toBe(4900);
    expect(summary.body.heldCents).toBe(0);
  }, 30000); // #978-style: two full purchase flows (each several sequential
  // real HTTP requests) plus catalog/instance setup and two mark-shipped
  // attempts -- same cumulative-D1-state-under-CI-load shape as #978/#1656,
  // just not rate-limit-named.

  it('becomes available once the buyer confirms delivery via their own token link, idempotently, and notifies the seller', async () => {
    const builder = await signupBuilder('payout-confirm-builder');
    const seller = await createConnectedSeller('payout-confirm-seller');
    const sellerBuilderId = (await api('/builders/me', seller.session())).body.builder.builderId;
    const rawToken = `test-delivery-token-${crypto.randomUUID()}`;
    await makeRealMoneyPurchase(builder, seller, { deliveryConfirmToken: rawToken });

    const badToken = await api('/purchases/confirm-delivery', {
      method: 'POST', body: JSON.stringify({ token: 'this-token-does-not-exist' }),
    });
    expect(badToken.response.status).toBe(400);

    const confirmed = await api('/purchases/confirm-delivery', { method: 'POST', body: JSON.stringify({ token: rawToken }) });
    expect(confirmed.response.status).toBe(200);
    expect(confirmed.body.confirmed).toBe(true);

    const summary = await api('/sellers/me/payouts', seller.session());
    expect(summary.body.availableCents).toBe(4900);
    expect(summary.body.heldCents).toBe(0);

    // #1289: the seller should passively learn their payout was just
    // released early, the same way every other transactional event in
    // this file notifies the other party.
    const { results: notifications } = await env.DB.prepare(
      'SELECT message FROM notifications WHERE builder_id = ?',
    ).bind(sellerBuilderId).all();
    expect(notifications).toHaveLength(1);
    expect(notifications[0].message).toContain('delivery was confirmed by the buyer');

    // Idempotent — a second visit to the same link is a no-op, not an
    // error, and doesn't re-notify the seller.
    const confirmedAgain = await api('/purchases/confirm-delivery', { method: 'POST', body: JSON.stringify({ token: rawToken }) });
    expect(confirmedAgain.response.status).toBe(200);
    const { results: notificationsAfterSecondConfirm } = await env.DB.prepare(
      'SELECT message FROM notifications WHERE builder_id = ?',
    ).bind(sellerBuilderId).all();
    expect(notificationsAfterSecondConfirm).toHaveLength(1);
  });

  // #1361: the sequential idempotency test above only proves a repeat call
  // after the first one is already committed doesn't re-notify -- it
  // doesn't exercise the actual race, two requests genuinely concurrent
  // (Promise.all, not awaited one at a time) with the same token, which a
  // plain check-then-act UPDATE with no WHERE delivery_confirmed_at IS
  // NULL guard could let both pass the read-check and both fire the
  // seller notification. Unlike mark-shipped's own #925 race test, this
  // endpoint is deliberately idempotent rather than erroring on a repeat,
  // so both responses should come back 200 -- the notification count is
  // what actually proves only one request's write won the race.
  it('does not let two concurrent confirm-delivery requests both notify the seller', async () => {
    const builder = await signupBuilder('confirm-delivery-race-builder');
    const seller = await createConnectedSeller('confirm-delivery-race-seller');
    const sellerBuilderId = (await api('/builders/me', seller.session())).body.builder.builderId;
    const rawToken = `test-delivery-race-token-${crypto.randomUUID()}`;
    await makeRealMoneyPurchase(builder, seller, { deliveryConfirmToken: rawToken });

    const [first, second] = await Promise.all([
      api('/purchases/confirm-delivery', { method: 'POST', body: JSON.stringify({ token: rawToken }) }),
      api('/purchases/confirm-delivery', { method: 'POST', body: JSON.stringify({ token: rawToken }) }),
    ]);
    expect([first.response.status, second.response.status]).toEqual([200, 200]);

    const { results: notifications } = await env.DB.prepare(
      'SELECT message FROM notifications WHERE builder_id = ?',
    ).bind(sellerBuilderId).all();
    expect(notifications).toHaveLength(1);
  });

  // #1248: this endpoint is unauthenticated by design (no buyer account
  // exists in this app) and hashes + looks up a token on every call, so
  // it's keyed by client IP the same way other unauthenticated repeatable
  // writes are rate-limited (see handlePurchaseFinalize's own #839 test
  // just above this describe block).
  it('rate-limits confirm-delivery attempts per client IP', async () => {
    const ip = `test-confirm-delivery-rate-limit-${crypto.randomUUID()}`;
    for (let i = 0; i < 20; i++) {
      const response = await api('/purchases/confirm-delivery', {
        method: 'POST',
        body: JSON.stringify({ token: `probe-token-${i}` }),
        headers: { 'cf-connecting-ip': ip },
      });
      // 400 (no matching purchase) either way -- the point is that the
      // rate limiter itself, not the token lookup, is what eventually
      // returns 429 below.
      expect(response.response.status).toBe(400);
    }
    const limited = await api('/purchases/confirm-delivery', {
      method: 'POST',
      body: JSON.stringify({ token: 'probe-token-final' }),
      headers: { 'cf-connecting-ip': ip },
    });
    expect(limited.response.status).toBe(429);
  }, 30000); // #1656: same 21-sequential-request shape as the mark-shipped/
  // refund rate-limit tests above, which already carry this same override
  // -- missed here when this test was authored.

  it('becomes available via the 7-day-after-shipped fallback even with no delivery confirmation', async () => {
    const builder = await signupBuilder('payout-fallback-builder');
    const seller = await createConnectedSeller('payout-fallback-seller');
    const purchaseId = await makeRealMoneyPurchase(builder, seller);
    const shipped = await api(`/purchases/${purchaseId}/mark-shipped`, seller.session({ method: 'POST' }));
    expect(shipped.response.status).toBe(200);

    // Back-dates shipped_at well past the hold window instead of waiting
    // 7 real days — same technique this file's own auction/calendar
    // tests already use to simulate elapsed time.
    await env.DB.prepare('UPDATE purchases SET shipped_at = ? WHERE purchase_id = ?')
      .bind('2000-01-01T00:00:00.000Z', purchaseId).run();

    const summary = await api('/sellers/me/payouts', seller.session());
    expect(summary.body.availableCents).toBe(4900);
    expect(summary.body.heldCents).toBe(0);
  });

  it('a refunded purchase never counts toward held or available', async () => {
    const builder = await signupBuilder('payout-refund-builder');
    const seller = await createConnectedSeller('payout-refund-seller');
    const purchaseId = await makeRealMoneyPurchase(builder, seller, { isDigitalGood: true });
    await env.DB.prepare(`UPDATE purchases SET refunded_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE purchase_id = ?`)
      .bind(purchaseId).run();

    const summary = await api('/sellers/me/payouts', seller.session());
    expect(summary.body.availableCents).toBe(0);
    expect(summary.body.heldCents).toBe(0);
  });

  it('503s triggering a payout since this suite never configures Stripe, without touching any purchase', async () => {
    const builder = await signupBuilder('payout-trigger-builder');
    const seller = await createConnectedSeller('payout-trigger-seller');
    const purchaseId = await makeRealMoneyPurchase(builder, seller, { isDigitalGood: true });

    const triggered = await api('/sellers/me/payouts', seller.session({ method: 'POST' }));
    expect(triggered.response.status).toBe(503);

    const row = await env.DB.prepare('SELECT paid_out_at FROM purchases WHERE purchase_id = ?').bind(purchaseId).first();
    expect(row.paid_out_at).toBeNull();
  });

  // #1050: this POST branch makes real outbound Stripe balance/payouts
  // calls on the shared platform key (once Stripe is actually
  // configured), the same "real cost/quota risk" #839/#948 already fixed
  // for the stripe-account handlers -- this endpoint never got the same
  // guard. Same coverage shape as those handlers' own rate-limit tests.
  it('rate-limits repeated payout attempts from the same seller', async () => {
    const builder = await signupBuilder('payout-rate-limit-builder');
    const seller = await createConnectedSeller('payout-rate-limit-seller');
    await makeRealMoneyPurchase(builder, seller, { isDigitalGood: true });

    for (let i = 0; i < 20; i++) {
      const attempt = await api('/sellers/me/payouts', seller.session({ method: 'POST' }));
      expect(attempt.response.status).toBe(503);
    }
    const limited = await api('/sellers/me/payouts', seller.session({ method: 'POST' }));
    expect(limited.response.status).toBe(429);
  }, 45000); // same pre-existing scheduling-contention flake as the
  // purchase-rate-limit test above — 20 sequential round trips reliably
  // finishes in under a second in isolation, but this file's 177+ tests
  // in one long-running CI worker process can occasionally push it past
  // the 20s default on nothing but contention, not a real regression.
  // Hit three times in this session's own full-suite runs today.

  // Self-found audit fix, no issue: handleSellerPayouts used to read
  // unpaid purchases, call Stripe, and only afterward mark paid_out_at
  // with no guard at all — two concurrent POST /sellers/me/payouts calls
  // (a double-click, two tabs) could both pass the read, both trigger a
  // real Stripe payout for the same purchases, and both write. Fixed by
  // claiming purchases (this guarded UPDATE) BEFORE ever calling Stripe.
  // Can't prove the fix through the real endpoint the way this file's
  // other concurrent-request tests do (auction-start/bid races, above) —
  // this suite deliberately never configures STRIPE_SECRET_KEY (see
  // stripe-connect.test.js's own comment), so POST /sellers/me/payouts
  // always 503s before ever reaching this claim. Testing the extracted
  // claim primitive directly instead, the same concurrency-proof shape
  // (Promise.all, assert an all-or-nothing split) applied one layer down.
  it('claimPurchasesForPayout lets only one of two concurrent claims win the same purchases, never both', async () => {
    const builder = await signupBuilder('payout-race-builder');
    const seller = await createConnectedSeller('payout-race-seller');
    const purchaseId = await makeRealMoneyPurchase(builder, seller, { isDigitalGood: true });
    const purchase = await env.DB.prepare('SELECT * FROM purchases WHERE purchase_id = ?').bind(purchaseId).first();

    const [first, second] = await Promise.all([
      claimPurchasesForPayout(env.DB, [purchase], '2026-01-01T00:00:00.000Z'),
      claimPurchasesForPayout(env.DB, [purchase], '2026-01-01T00:00:01.000Z'),
    ]);
    // All-or-nothing on each purchase, the same shape as the auction-start
    // race above — never both empty (that would mean the claim silently
    // failed for everyone) and never both non-empty (that would be the
    // double-payout bug this test exists to catch).
    const winners = [first.length, second.length].filter((n) => n === 1);
    const losers = [first.length, second.length].filter((n) => n === 0);
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(1);

    const row = await env.DB.prepare('SELECT paid_out_at FROM purchases WHERE purchase_id = ?').bind(purchaseId).first();
    expect(row.paid_out_at).toBeTruthy();
  });

  // #1061: a refund and a payout claim used to be able to both land on
  // the same purchase if they raced -- neither guard checked the other
  // field (handlePurchaseRefund's atomic UPDATE only checked
  // refunded_at, claimPurchasesForPayout's only checked paid_out_at).
  // Fired genuinely concurrently, same shape as the claim-vs-claim race
  // just above and #849's own candidate-materialization race -- asserts
  // the all-or-nothing invariant the fix guarantees, not a forced
  // ordering. Uses a simulated (no payment_intent_id) purchase so a
  // winning refund completes fully via the higgles-only clawback path
  // instead of hitting this suite's deliberately-unconfigured Stripe.
  it('a refund racing a concurrent payout claim never lets both land on the same purchase', async () => {
    const seller = await signupBuilder('refund-payout-race-seller');
    await createGreenbeltLandletWithArea('refund-payout-race-landlet', 1000);
    await claim('refund-payout-race-landlet', seller);
    await createTemplate('refund-payout-race-template', { priceCents: 10000 });
    await placeInstance('refund-payout-race-instance', 'refund-payout-race-landlet', 'refund-payout-race-template', seller);
    const purchased = await api('/instances/refund-payout-race-instance/purchase', seller.session({ method: 'POST' }));
    const { purchaseId } = purchased.body.purchase;
    const purchaseRow = await env.DB.prepare('SELECT * FROM purchases WHERE purchase_id = ?').bind(purchaseId).first();

    const [refunded, claimed] = await Promise.all([
      api(`/purchases/${purchaseId}/refund`, adminSession({ method: 'POST' })),
      claimPurchasesForPayout(env.DB, [purchaseRow], '2026-01-01T00:00:00.000Z'),
    ]);

    const refundWon = refunded.response.status === 200;
    const claimWon = claimed.length === 1;
    // Exactly one side wins -- never both (the bug this test exists to
    // catch) and never neither (that would mean the guard is too
    // aggressive and silently drops a legitimate request).
    expect([refundWon, claimWon].filter(Boolean).length).toBe(1);

    const row = await env.DB.prepare('SELECT refunded_at, paid_out_at FROM purchases WHERE purchase_id = ?').bind(purchaseId).first();
    if (refundWon) {
      expect(row.refunded_at).not.toBeNull();
      expect(row.paid_out_at).toBeNull();
      expect(claimed).toHaveLength(0);
    } else {
      expect(row.paid_out_at).not.toBeNull();
      expect(row.refunded_at).toBeNull();
      expect(refunded.response.status).toBe(409);
      expect(refunded.body.error).toMatch(/already been paid out/i);
    }
  });

  // #1061: deterministic version of the race just above, targeting
  // claimPurchasesForPayout's own guard specifically rather than relying
  // on however this test harness happens to schedule a genuinely
  // concurrent Promise.all (which, for this particular pairing, reliably
  // lets the claim resolve before the refund's own initial read gets a
  // chance to see it — see that test's own comment). This instead
  // reproduces the real caller-side gap directly: handleSellerPayouts
  // reads unpaidSellerPurchases, then does real work (DB awaits, an
  // outbound Stripe balance call) before ever calling
  // claimPurchasesForPayout with that now-possibly-stale purchase row —
  // exactly what a refund landing in that window would produce. Without
  // the #1061 fix, claimPurchasesForPayout trusted the caller's stale
  // row and claimed (and would have paid out) a purchase already
  // refunded out from under it.
  it('never claims a purchase using a caller-held row that went stale (refunded) after being read', async () => {
    const seller = await signupBuilder('refund-payout-stale-seller');
    await createGreenbeltLandletWithArea('refund-payout-stale-landlet', 1000);
    await claim('refund-payout-stale-landlet', seller);
    await createTemplate('refund-payout-stale-template', { priceCents: 10000 });
    await placeInstance('refund-payout-stale-instance', 'refund-payout-stale-landlet', 'refund-payout-stale-template', seller);
    const purchased = await api('/instances/refund-payout-stale-instance/purchase', seller.session({ method: 'POST' }));
    const { purchaseId } = purchased.body.purchase;

    // The stale row a caller like handleSellerPayouts would still be
    // holding from before the refund below landed.
    const staleRow = await env.DB.prepare('SELECT * FROM purchases WHERE purchase_id = ?').bind(purchaseId).first();
    expect(staleRow.refunded_at).toBeNull();

    const refunded = await api(`/purchases/${purchaseId}/refund`, adminSession({ method: 'POST' }));
    expect(refunded.response.status).toBe(200);

    const claimed = await claimPurchasesForPayout(env.DB, [staleRow], '2026-01-01T00:00:00.000Z');
    expect(claimed).toHaveLength(0);

    const row = await env.DB.prepare('SELECT paid_out_at FROM purchases WHERE purchase_id = ?').bind(purchaseId).first();
    expect(row.paid_out_at).toBeNull();
  });

  // #869: replaces a fresh crypto.randomUUID() per call (#866/#868 —
  // could never match a retry's own key, so it never actually protected
  // against a duplicate payout) with a hash of the claimed purchase-id
  // set, which a genuine retry claiming the same purchases reproduces
  // exactly.
  it('sellerPayoutIdempotencyKey is stable for the same claimed set regardless of order, and differs for a different set', async () => {
    const keyA = await sellerPayoutIdempotencyKey('seller-1', ['purchase-a', 'purchase-b']);
    const keyAReordered = await sellerPayoutIdempotencyKey('seller-1', ['purchase-b', 'purchase-a']);
    expect(keyAReordered).toBe(keyA);

    const keyDifferentSet = await sellerPayoutIdempotencyKey('seller-1', ['purchase-a', 'purchase-c']);
    expect(keyDifferentSet).not.toBe(keyA);

    const keyDifferentSeller = await sellerPayoutIdempotencyKey('seller-2', ['purchase-a', 'purchase-b']);
    expect(keyDifferentSeller).not.toBe(keyA);
  });

  // #969: if the Stripe payout call succeeds but the trailing DB write
  // recording stripe_payout_id never lands (a D1 blip, a Worker
  // eviction), the purchase is left claimed (paid_out_at set) but
  // unconfirmed (stripe_payout_id still NULL) -- exactly the in-flight
  // state the #745 test above seeds directly, without ever calling the
  // real payout endpoint. claimOrResumeSellerPayout is what a retried
  // POST /sellers/me/payouts uses to find and resume that stuck set
  // instead of computing a fresh one (which would never see it, since
  // unpaidSellerPurchases filters paid_out_at IS NULL).
  it('claimOrResumeSellerPayout finds a stuck claimed-but-unconfirmed purchase and nothing else', async () => {
    // A separate builder per purchase -- a builder can only ever own one
    // claimed landlet at a time (POST .../claim's own NOT EXISTS guard),
    // so makeRealMoneyPurchase's own fresh-landlet-per-call claim would
    // silently fail (and placeInstance would then 403) on any call past
    // the first if these all reused one builder.
    const seller = await createConnectedSeller('resume-payout-seller');

    const nothingStuck = await claimOrResumeSellerPayout(env.DB, seller.sellerId);
    expect(nothingStuck).toEqual({ claimed: [], resumed: false });

    const stuckBuilder = await signupBuilder('resume-payout-stuck-builder');
    const stuckPurchaseId = await makeRealMoneyPurchase(stuckBuilder, seller, { isDigitalGood: true });
    await claimPurchasesForPayout(
      env.DB,
      [await env.DB.prepare('SELECT * FROM purchases WHERE purchase_id = ?').bind(stuckPurchaseId).first()],
      '2026-01-01T00:00:00.000Z',
    );

    // A confirmed (stripe_payout_id set) claim is not "stuck" -- it
    // already completed successfully and must never be resumed again.
    const confirmedBuilder = await signupBuilder('resume-payout-confirmed-builder');
    const confirmedPurchaseId = await makeRealMoneyPurchase(confirmedBuilder, seller, { isDigitalGood: true });
    await env.DB.prepare('UPDATE purchases SET paid_out_at = ?, stripe_payout_id = ? WHERE purchase_id = ?')
      .bind('2026-01-01T00:00:00.000Z', 'po_already_confirmed', confirmedPurchaseId).run();

    // A refunded purchase is claimed-but-unconfirmed by the same raw
    // columns, but refunded_at excludes it -- the same guard
    // isPurchaseEligibleForPayout/unpaidSellerPurchases already apply to
    // the fresh-claim path, kept consistent here.
    const refundedBuilder = await signupBuilder('resume-payout-refunded-builder');
    const refundedPurchaseId = await makeRealMoneyPurchase(refundedBuilder, seller, { isDigitalGood: true });
    await env.DB.prepare('UPDATE purchases SET paid_out_at = ?, refunded_at = ? WHERE purchase_id = ?')
      .bind('2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', refundedPurchaseId).run();

    const stuck = await claimOrResumeSellerPayout(env.DB, seller.sellerId);
    expect(stuck.resumed).toBe(true);
    expect(stuck.claimed.map((p) => p.purchase_id)).toEqual([stuckPurchaseId]);
  }, 30000); // #1656: three makeRealMoneyPurchase calls, each several
  // sequential HTTP round trips -- same CI-load timeout margin issue as
  // the rate-limit tests above.

  // #969: proves the resume branch actually gets taken through the real
  // POST /sellers/me/payouts endpoint, not just the extracted primitive
  // above. This suite never configures Stripe, so the real payout call
  // itself still can't be exercised -- but the routing decision is
  // observable anyway: before this fix, a seller whose entire unpaid
  // balance was stuck (invisible to unpaidSellerPurchases) got the
  // fresh-claim path's own "Nothing is available to cash out yet." 400,
  // since the stuck purchase never even reached the Stripe checks.
  // After the fix, the resume branch runs first and reaches its own
  // stripeConfigured guard instead, so the response flips to a 503
  // "not configured" -- proof the stuck purchase was found and routed to
  // resumeSellerPayout rather than silently falling through.
  it('routes a stuck claimed-but-unconfirmed purchase to the resume path instead of "nothing available"', async () => {
    const builder = await signupBuilder('resume-payout-endpoint-builder');
    const seller = await createConnectedSeller('resume-payout-endpoint-seller');
    const stuckPurchaseId = await makeRealMoneyPurchase(builder, seller, { isDigitalGood: true });
    await claimPurchasesForPayout(
      env.DB,
      [await env.DB.prepare('SELECT * FROM purchases WHERE purchase_id = ?').bind(stuckPurchaseId).first()],
      '2026-01-01T00:00:00.000Z',
    );

    const attempted = await api('/sellers/me/payouts', seller.session({ method: 'POST' }));
    expect(attempted.response.status).toBe(503);
    expect(attempted.body.error).toMatch(/not configured/);
  });

  // #599: once paid_out_at is set, this purchase's seller-share has
  // actually left the platform via a real Stripe payout — refunding it
  // would call Stripe's reverse_transfer against whatever balance
  // currently sits in the connected account (not funds earmarked to
  // this specific transfer), silently pulling money that's supposed to
  // back other, still-unpaid sales. This suite never configures Stripe
  // (see stripe-connect.test.js's own comment), so the pre-fix behavior
  // for this exact scenario would have been a 503 from the
  // stripeConfigured guard further down handlePurchaseRefund, not the
  // real risk this fix guards against — but 409 vs 503 still proves the
  // paid_out_at check fires first, before the refund does anything else.
  it('rejects refunding a purchase that has already been paid out', async () => {
    const builder = await signupBuilder('refund-after-payout-builder');
    const seller = await createConnectedSeller('refund-after-payout-seller');
    const purchaseId = await makeRealMoneyPurchase(builder, seller, { isDigitalGood: true });
    const purchase = await env.DB.prepare('SELECT * FROM purchases WHERE purchase_id = ?').bind(purchaseId).first();
    await claimPurchasesForPayout(env.DB, [purchase], '2026-01-01T00:00:00.000Z');

    const refunded = await api(`/purchases/${purchaseId}/refund`, seller.session({ method: 'POST' }));
    expect(refunded.response.status).toBe(409);
    expect(refunded.body.error).toMatch(/already been paid out/i);

    const row = await env.DB.prepare('SELECT refunded_at FROM purchases WHERE purchase_id = ?').bind(purchaseId).first();
    expect(row.refunded_at).toBeNull();
  });

  // #612 (sub-issue of #350): foundational annual gross-income summary
  // feeding the eventual 1099-K/1099-NEC pipeline. Reuses this describe
  // block's own createConnectedSeller/makeRealMoneyPurchase helpers for
  // the real-money side.
  describe('Tax summary (#612)', () => {
    it('requires a session', async () => {
      const got = await api('/tax/summary');
      expect(got.response.status).toBe(401);
    });

    it('defaults to all zeros for a builder with no earnings and no seller profile', async () => {
      const builder = await signupBuilder('tax-summary-empty-builder');
      const got = await api('/tax/summary', builder.session());
      expect(got.response.status).toBe(200);
      expect(got.body).toMatchObject({
        year: new Date().getUTCFullYear(), builderHigglesCents: 0, sellerPayoutCents: 0, totalCents: 0,
        thresholdCents: 2000000, noticeLevel: 'none',
      });
    });

    it('counts higgles commission income earned as a builder', async () => {
      const builder = await signupBuilder('tax-summary-builder');
      const seller = await signupSeller('tax-summary-builder-seller');
      const landletId = 'tax-summary-builder-landlet';
      const templateId = 'tax-summary-builder-template';
      const instanceId = 'tax-summary-builder-instance';
      await createGreenbeltLandletWithArea(landletId, 1000);
      await claim(landletId, builder);
      await api('/catalog', seller.session({
        method: 'POST',
        body: JSON.stringify({
          templateId, name: 'Tax summary product', color: '#222222',
          dimensions: { width: 1, depth: 1, height: 1 }, priceCents: 10000, sellerId: seller.sellerId,
        }),
      }));
      await placeInstance(instanceId, landletId, templateId, builder);
      const purchased = await api(`/instances/${instanceId}/purchase`, builder.session({ method: 'POST' }));
      expect(purchased.response.status).toBe(201);

      const got = await api('/tax/summary', builder.session());
      expect(got.body.builderHigglesCents).toBe(purchased.body.purchase.builderShareCents);
      expect(got.body.sellerPayoutCents).toBe(0);
      expect(got.body.totalCents).toBe(purchased.body.purchase.builderShareCents);
    });

    it("counts a seller's gross real-money payout volume as the full transaction total, not the net share", async () => {
      const builder = await signupBuilder('tax-summary-seller-builder');
      const seller = await createConnectedSeller('tax-summary-seller');
      await makeRealMoneyPurchase(builder, seller, { isDigitalGood: true }); // priceCents 5000, 2% commission

      const got = await api('/tax/summary', seller.session());
      expect(got.body.sellerPayoutCents).toBe(5000); // full transaction total, not the 4900 net share
      expect(got.body.builderHigglesCents).toBe(0); // this account's own builder profile earned nothing
      expect(got.body.totalCents).toBe(5000);
    });

    it("excludes a refunded real-money purchase from the seller's gross total", async () => {
      const builder = await signupBuilder('tax-summary-refund-builder');
      const seller = await createConnectedSeller('tax-summary-refund-seller');
      const purchaseId = await makeRealMoneyPurchase(builder, seller, { isDigitalGood: true });
      // Refunding for real always 503s in this suite (Stripe isn't
      // configured — see "Real-money refunds" above), so simulate what a
      // real refund would have written, the same technique used
      // throughout this file for other Stripe-dependent columns.
      await env.DB.prepare(
        "UPDATE purchases SET refunded_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE purchase_id = ?",
      ).bind(purchaseId).run();

      const got = await api('/tax/summary', seller.session());
      expect(got.body.sellerPayoutCents).toBe(0);
    });

    it('only counts income within the requested calendar year', async () => {
      const builder = await signupBuilder('tax-summary-year-builder');
      const seller = await createConnectedSeller('tax-summary-year-seller');
      const purchaseId = await makeRealMoneyPurchase(builder, seller, { isDigitalGood: true });
      await env.DB.prepare("UPDATE purchases SET created_at = '2020-06-15T00:00:00.000Z' WHERE purchase_id = ?")
        .bind(purchaseId).run();

      const currentYear = await api('/tax/summary', seller.session());
      expect(currentYear.body.sellerPayoutCents).toBe(0);

      const pastYear = await api('/tax/summary?year=2020', seller.session());
      expect(pastYear.response.status).toBe(200);
      expect(pastYear.body.year).toBe(2020);
      expect(pastYear.body.sellerPayoutCents).toBe(5000);
    });

    it('rejects a malformed year', async () => {
      const builder = await signupBuilder('tax-summary-bad-year-builder');
      const got = await api('/tax/summary?year=not-a-year', builder.session());
      expect(got.response.status).toBe(400);
    });

    // #613: progressive, non-blocking notice levels at 50%/80%/100% of
    // the combined-income threshold. Uses the admin land-cap-grants
    // escape hatch (a real higgles_earnings_events row, not a fabricated
    // column) to push a builder's own combined total across each
    // breakpoint in turn.
    it('reports progressive notice levels as combined income approaches the reporting threshold', async () => {
      const builder = await signupBuilder('tax-summary-notice-builder');
      async function grantHiggles(amountCents) {
        const granted = await api(`/builders/${builder.builderId}/land-cap-grants`, adminSession({
          method: 'POST',
          body: JSON.stringify({ amountCents }),
        }));
        expect(granted.response.status).toBe(201);
      }

      const initial = await api('/tax/summary', builder.session());
      expect(initial.body.noticeLevel).toBe('none');

      await grantHiggles(1000000); // 50% of the $20,000 threshold
      const early = await api('/tax/summary', builder.session());
      expect(early.body.noticeLevel).toBe('early');

      await grantHiggles(600000); // now 80%
      const approaching = await api('/tax/summary', builder.session());
      expect(approaching.body.noticeLevel).toBe('approaching');

      await grantHiggles(400000); // now 100%
      const crossed = await api('/tax/summary', builder.session());
      expect(crossed.body.noticeLevel).toBe('crossed');
    });
  });

  // #615 (sub-issue of #350): gates real-money payout once combined
  // (higgles + real-money) gross income for the year crosses #613's
  // reporting threshold with no W-9/W-8BEN on file. This suite never
  // configures STRIPE_SECRET_KEY, but handleSellerPayouts computes this
  // gate before the stripeConfigured check specifically so the
  // full-block scenario (no headroom left at all) is reachable and
  // testable here — see that function's own comment. The
  // partial-headroom cap (letting some, not all, of a payout through)
  // interacts with the Stripe balance call further down and isn't
  // exercisable without Stripe configured, the same limitation this
  // whole describe block already documents at its own top.
  describe('Tax-threshold payout gate (#615)', () => {
    // Same admin land-cap-grants escape hatch "Tax summary (#612)" above
    // uses to create a real higgles_earnings_events row without needing
    // a real sale.
    async function grantHiggles(builderId, amountCents) {
      const granted = await api(`/builders/${builderId}/land-cap-grants`, adminSession({
        method: 'POST', body: JSON.stringify({ amountCents }),
      }));
      expect(granted.response.status).toBe(201);
    }

    it('blocks a payout once combined earnings have reached the threshold with no tax paperwork on file', async () => {
      const builder = await signupBuilder('tax-gate-blocked-builder');
      const seller = await createConnectedSeller('tax-gate-blocked-seller');
      await makeRealMoneyPurchase(builder, seller, { isDigitalGood: true }); // 4900 available
      const sellerBuilder = await api('/builders/me', seller.session());
      await grantHiggles(sellerBuilder.body.builder.builderId, 2000000); // hits the $20,000 threshold on its own

      const blocked = await api('/sellers/me/payouts', seller.session({ method: 'POST' }));
      expect(blocked.response.status).toBe(403);
      expect(blocked.body.error).toMatch(/tax-reporting/i);

      // Never even reached the claim step — nothing was touched.
      const summary = await api('/sellers/me/payouts', seller.session());
      expect(summary.body.availableCents).toBe(4900);
    });

    // #1087: `eligible` (unpaidSellerPurchases) has no year filter, but
    // annualGrossIncome's own sellerPayoutCents total is year-filtered —
    // a prior-year unpaid purchase that only just became eligible must
    // not count toward "this payout's own gross" when isolating
    // otherEarnedCents, or its total gets subtracted from a total that
    // never included it, understating otherEarnedCents and letting real
    // current-year income slip past this gate.
    it('does not let a stale prior-year unpaid purchase inflate this year\'s tax-reporting headroom', async () => {
      const builder = await signupBuilder('tax-gate-crossyear-builder');
      const otherBuilder = await signupBuilder('tax-gate-crossyear-builder-2');
      const seller = await createConnectedSeller('tax-gate-crossyear-seller');
      await makeRealMoneyPurchase(builder, seller, { isDigitalGood: true }); // this year, 5000 cents, eligible+unpaid

      const stalePurchaseId = await makeRealMoneyPurchase(otherBuilder, seller, { isDigitalGood: true });
      await env.DB.prepare("UPDATE purchases SET created_at = '2020-06-15T00:00:00.000Z' WHERE purchase_id = ?")
        .bind(stalePurchaseId).run();

      const sellerBuilder = await api('/builders/me', seller.session());
      await grantHiggles(sellerBuilder.body.builder.builderId, 2000000); // hits the $20,000 threshold on its own

      const blocked = await api('/sellers/me/payouts', seller.session({ method: 'POST' }));
      expect(blocked.response.status).toBe(403);
      expect(blocked.body.error).toMatch(/tax-reporting/i);
    }, 30000); // #1656: two makeRealMoneyPurchase calls plus several more
    // API calls -- same CI-load timeout margin issue as the rate-limit
    // tests above.

    // #1335: same unfiltered-`eligible` gap #1087 fixed just above for
    // eligibleGrossCents, missed in the inclusion loop itself -- a stale
    // prior-year purchase must not spend any of this year's
    // taxBudgetCents, or (since unpaidSellerPurchases orders oldest-first,
    // same as this array) it can eat the whole budget and wrongly skip a
    // genuinely current-year purchase that would otherwise fit easily.
    // Pure-logic test against the extracted primitive directly, same
    // precedent as claimPurchasesForPayout's own direct tests elsewhere in
    // this file -- this suite never configures STRIPE_SECRET_KEY, so
    // nothing past handleSellerPayouts' own stripeConfigured check (this
    // selection logic included) is reachable through the real endpoint.
    it('selectPurchasesForPayout does not let a stale prior-year purchase spend this year\'s tax budget', () => {
      const yearStart = '2026-01-01T00:00:00.000Z';
      const yearEnd = '2027-01-01T00:00:00.000Z';
      const stale = {
        purchase_id: 'stale', created_at: '2020-06-15T00:00:00.000Z', total_cents: 8000, commission_cents: 0,
      };
      const current = {
        purchase_id: 'current', created_at: '2026-06-15T00:00:00.000Z', total_cents: 5000, commission_cents: 0,
      };
      // unpaidSellerPurchases orders ASC by created_at, so the stale
      // (older) purchase is processed first here too.
      const result = selectPurchasesForPayout([stale, current], {
        payoutCapCents: 1000000, // generous -- Stripe availability isn't what this test is about
        taxBudgetCents: 10000, // smaller than stale+current combined, but bigger than either alone
        yearStart, yearEnd,
      });
      expect(result.skippedForTax).toBe(false);
      expect(result.included.map((p) => p.purchase_id)).toEqual(['stale', 'current']);
      expect(result.payoutCents).toBe(8000 + 5000);
    });

    it('does not block a payout while combined earnings stay under the threshold', async () => {
      const builder = await signupBuilder('tax-gate-under-builder');
      const seller = await createConnectedSeller('tax-gate-under-seller');
      await makeRealMoneyPurchase(builder, seller, { isDigitalGood: true });
      const sellerBuilder = await api('/builders/me', seller.session());
      await grantHiggles(sellerBuilder.body.builder.builderId, 1000000); // 50% of threshold — nowhere near it

      // Falls through to the ordinary unconfigured-Stripe 503, same as
      // every other payout test in this file — proof the tax gate didn't
      // fire and block it with its own 403 first.
      const attempted = await api('/sellers/me/payouts', seller.session({ method: 'POST' }));
      expect(attempted.response.status).toBe(503);
    });

    it('lifts the block once W-9/W-8BEN tax paperwork is on file, even over the threshold', async () => {
      const builder = await signupBuilder('tax-gate-paperwork-builder');
      const seller = await createConnectedSeller('tax-gate-paperwork-seller');
      await makeRealMoneyPurchase(builder, seller, { isDigitalGood: true });
      const sellerBuilder = await api('/builders/me', seller.session());
      await grantHiggles(sellerBuilder.body.builder.builderId, 2000000);
      await env.DB.prepare('UPDATE users SET tax_form_type = ?, tax_form_completed_at = ? WHERE email = ?')
        .bind('w9', '2026-01-01T00:00:00.000Z', seller.email).run();

      // Same unconfigured-Stripe 503 as the under-threshold case above —
      // paperwork being on file means the tax gate no longer applies at
      // all, so this falls through exactly the same way.
      const attempted = await api('/sellers/me/payouts', seller.session({ method: 'POST' }));
      expect(attempted.response.status).toBe(503);
    });
  });

  // #614 (sub-issue of #350): W-9/W-8BEN collection. This suite
  // deliberately never configures TAX_ID_ENCRYPTION_KEY (worker/tax-id-form.test.js
  // is a separate file for that reason — see its own comment), so this is
  // only the unconfigured-503 path; the real submit/validate/encrypt
  // behavior lives in that other file.
  it('rejects a tax-ID form submission when TAX_ID_ENCRYPTION_KEY is not configured', async () => {
    const builder = await signupBuilder('tax-id-form-unconfigured');
    const got = await api('/tax/id-form', builder.session({
      method: 'POST',
      body: JSON.stringify({ formType: 'w9', legalName: 'Ada Lovelace' }),
    }));
    expect(got.response.status).toBe(503);
  });

  // #645 (sub-issue of #616, itself sub-issue of #350): the vendor-independent
  // half of #616 — a 1099 form-record data model plus an admin-only
  // generate/review endpoint. No e-filing vendor involved here at all
  // (that's #646); this only covers deciding who needs a form and tracking
  // its draft/approved lifecycle.
  describe('1099 form generation + admin review (#645)', () => {
    async function grantHiggles(builderId, amountCents) {
      const granted = await api(`/builders/${builderId}/land-cap-grants`, adminSession({
        method: 'POST', body: JSON.stringify({ amountCents }),
      }));
      expect(granted.response.status).toBe(201);
    }

    it('requires a session, then admin access', async () => {
      const anon = await api('/tax/admin-forms');
      expect(anon.response.status).toBe(401);

      const builder = await signupBuilder('tax-1099-not-admin');
      const nonAdmin = await api('/tax/admin-forms', builder.session());
      expect(nonAdmin.response.status).toBe(403);
    });

    it('generates a 1099-NEC draft once a builder\'s higgle-commission income crosses $600, not before', async () => {
      const builder = await signupBuilder('tax-1099-nec-builder');
      const builderMe = await api('/builders/me', builder.session());

      await grantHiggles(builderMe.body.builder.builderId, 50000); // $500 — under the $600 NEC threshold
      const under = await api(`/tax/admin-forms?year=${new Date().getUTCFullYear()}`, adminSession());
      expect(under.response.status).toBe(200);
      expect(under.body.forms.find((f) => f.email === builder.email)).toBeUndefined();

      await grantHiggles(builderMe.body.builder.builderId, 20000); // now $700 total — crosses $600
      const over = await api(`/tax/admin-forms?year=${new Date().getUTCFullYear()}`, adminSession());
      const form = over.body.forms.find((f) => f.email === builder.email);
      expect(form).toMatchObject({
        formType: '1099-nec', status: 'draft', grossIncomeCents: 70000, taxPaperworkOnFile: false,
      });
    });

    it("generates a 1099-K draft once a seller's real-money payout volume crosses $20,000, not a 1099-NEC", async () => {
      const builder = await signupBuilder('tax-1099-k-builder');
      const seller = await createConnectedSeller('tax-1099-k-seller');
      const purchaseId = await makeRealMoneyPurchase(builder, seller);
      // makeRealMoneyPurchase's own priceCents is a fixed $50 -- nowhere
      // near the $20,000 threshold, and buying enough $50 items to reach
      // it for real would need hundreds of purchases (each its own
      // landlet/instance). Bumping this one purchase's total_cents
      // directly is the same "simulate what a real transaction would have
      // written" technique already used elsewhere in this describe block
      // (see the refund-exclusion test above).
      await env.DB.prepare('UPDATE purchases SET total_cents = 2000000 WHERE purchase_id = ?').bind(purchaseId).run();

      const got = await api(`/tax/admin-forms?year=${new Date().getUTCFullYear()}`, adminSession());
      const forms = got.body.forms.filter((f) => f.email === seller.email);
      expect(forms).toEqual([expect.objectContaining({ formType: '1099-k', status: 'draft', grossIncomeCents: 2000000 })]);
    });

    // #2214: generateTax1099Drafts only ever upserts payees its own
    // threshold-crossing queries still return -- a draft whose payee later
    // drops back under the threshold (here, via a refund) stopped
    // appearing in those queries and so just kept its original,
    // now-overstated snapshot forever. Covers both form types, since the
    // underlying bug (and fix) is a parallel pair of queries for each.
    it('removes a still-draft 1099-K form once a refund drops the seller\'s real total back under the threshold', async () => {
      const builder = await signupBuilder('tax-1099-k-refund-prune-builder');
      const seller = await createConnectedSeller('tax-1099-k-refund-prune-seller');
      const purchaseId = await makeRealMoneyPurchase(builder, seller);
      await env.DB.prepare('UPDATE purchases SET total_cents = 2000000 WHERE purchase_id = ?').bind(purchaseId).run();

      const year = new Date().getUTCFullYear();
      const before = await api(`/tax/admin-forms?year=${year}`, adminSession());
      expect(before.body.forms.find((f) => f.email === seller.email)).toMatchObject({
        formType: '1099-k', status: 'draft', grossIncomeCents: 2000000,
      });

      // Refunding for real always 503s in this suite (no Stripe configured)
      // -- simulate what a real refund would have written, same technique
      // as the "Tax summary" describe block's own refund-exclusion test.
      await env.DB.prepare(
        "UPDATE purchases SET refunded_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE purchase_id = ?",
      ).bind(purchaseId).run();

      const after = await api(`/tax/admin-forms?year=${year}`, adminSession());
      expect(after.body.forms.find((f) => f.email === seller.email)).toBeUndefined();
      const row = await env.DB.prepare(
        "SELECT * FROM tax_1099_forms WHERE user_id = (SELECT user_id FROM users WHERE email = ?) AND tax_year = ?",
      ).bind(seller.email, year).first();
      expect(row).toBeNull();
    });

    it('removes a still-draft 1099-NEC form once a builder\'s qualifying income drops back under the threshold', async () => {
      const builder = await signupBuilder('tax-1099-nec-refund-prune-builder');
      const builderMe = await api('/builders/me', builder.session());
      const year = new Date().getUTCFullYear();

      await grantHiggles(builderMe.body.builder.builderId, 70000); // $700 — over the $600 NEC threshold
      const before = await api(`/tax/admin-forms?year=${year}`, adminSession());
      const draft = before.body.forms.find((f) => f.email === builder.email);
      expect(draft).toMatchObject({ formType: '1099-nec', status: 'draft', grossIncomeCents: 70000 });

      // higgles_earnings_events has no refund concept of its own, and
      // amount_cents has its own CHECK(amount_cents > 0) -- deleting the
      // event outright is the simplest way to simulate the underlying
      // earnings being reversed (e.g. a moderation clawback), dropping
      // this builder's qualifying total back under $600.
      await env.DB.prepare('DELETE FROM higgles_earnings_events WHERE builder_id = ?')
        .bind(builderMe.body.builder.builderId).run();

      const after = await api(`/tax/admin-forms?year=${year}`, adminSession());
      expect(after.body.forms.find((f) => f.email === builder.email)).toBeUndefined();
      const row = await env.DB.prepare(
        "SELECT * FROM tax_1099_forms WHERE user_id = (SELECT user_id FROM users WHERE email = ?) AND tax_year = ? AND form_type = '1099-nec'",
      ).bind(builder.email, year).first();
      expect(row).toBeNull();
    });

    // An approved form must survive the exact same refund/reversal that
    // would prune an equivalent still-draft form -- #2214's fix only ever
    // targets status = 'draft' rows, the same guard upsertTax1099Draft's
    // own WHERE clause already relies on.
    it('does not prune an already-approved 1099 form when the payee\'s income later drops under the threshold', async () => {
      const builder = await signupBuilder('tax-1099-approved-survives-refund');
      const builderMe = await api('/builders/me', builder.session());
      await env.DB.prepare('UPDATE users SET tax_form_type = ?, tax_form_completed_at = ? WHERE email = ?')
        .bind('w9', '2026-01-01T00:00:00.000Z', builder.email).run();
      const year = new Date().getUTCFullYear();

      await grantHiggles(builderMe.body.builder.builderId, 70000);
      const listed = await api(`/tax/admin-forms?year=${year}`, adminSession());
      const draft = listed.body.forms.find((f) => f.email === builder.email);
      const approved = await api(`/tax/admin-forms/${draft.formId}/approve`, adminSession({ method: 'POST' }));
      expect(approved.response.status).toBe(200);

      await env.DB.prepare('DELETE FROM higgles_earnings_events WHERE builder_id = ?')
        .bind(builderMe.body.builder.builderId).run();

      const after = await api(`/tax/admin-forms?year=${year}`, adminSession());
      const stillThere = after.body.forms.find((f) => f.email === builder.email);
      expect(stillThere).toMatchObject({ status: 'approved', grossIncomeCents: 70000 });
    });

    it('refreshes a draft\'s snapshot on regeneration, but never touches an already-approved form', async () => {
      const builder = await signupBuilder('tax-1099-refresh-builder');
      const builderMe = await api('/builders/me', builder.session());
      await env.DB.prepare('UPDATE users SET tax_form_type = ?, tax_form_completed_at = ? WHERE email = ?')
        .bind('w9', '2026-01-01T00:00:00.000Z', builder.email).run();
      const year = new Date().getUTCFullYear();

      await grantHiggles(builderMe.body.builder.builderId, 70000);
      const first = await api(`/tax/admin-forms?year=${year}`, adminSession());
      const draft = first.body.forms.find((f) => f.email === builder.email);
      expect(draft.grossIncomeCents).toBe(70000);

      // Still a draft — regenerating after more income posts refreshes it.
      await grantHiggles(builderMe.body.builder.builderId, 10000);
      const refreshed = await api(`/tax/admin-forms?year=${year}`, adminSession());
      expect(refreshed.body.forms.find((f) => f.email === builder.email).grossIncomeCents).toBe(80000);

      const approved = await api(`/tax/admin-forms/${draft.formId}/approve`, adminSession({ method: 'POST' }));
      expect(approved.response.status).toBe(200);
      expect(approved.body.status).toBe('approved');

      // #815: approving a real tax record is a sensitive, real-money-
      // adjacent action — it must leave a record of which admin did it.
      const meAdmin = await api('/auth/me', adminSession());
      const logRow = await env.DB.prepare(
        'SELECT * FROM admin_action_log WHERE action_type = ? AND target_id = ?',
      ).bind('approve_1099_form', draft.formId).first();
      expect(logRow.admin_user_id).toBe(meAdmin.body.user.userId);
      expect(logRow.target_type).toBe('tax_1099_form');
      expect(JSON.parse(logRow.detail_json)).toMatchObject({ formType: draft.formType });

      // More income posts after approval — the now-locked-in snapshot must
      // not silently drift.
      await grantHiggles(builderMe.body.builder.builderId, 100000);
      const afterApproval = await api(`/tax/admin-forms?year=${year}`, adminSession());
      const stillApproved = afterApproval.body.forms.find((f) => f.email === builder.email);
      expect(stillApproved.status).toBe('approved');
      expect(stillApproved.grossIncomeCents).toBe(80000);
    });

    it('rejects approving a form for a payee with no W-9/W-8BEN paperwork on file', async () => {
      const builder = await signupBuilder('tax-1099-approve-no-paperwork');
      const builderMe = await api('/builders/me', builder.session());
      await grantHiggles(builderMe.body.builder.builderId, 70000);
      const year = new Date().getUTCFullYear();
      const listed = await api(`/tax/admin-forms?year=${year}`, adminSession());
      const form = listed.body.forms.find((f) => f.email === builder.email);
      expect(form.taxPaperworkOnFile).toBe(false);

      const rejected = await api(`/tax/admin-forms/${form.formId}/approve`, adminSession({ method: 'POST' }));
      expect(rejected.response.status).toBe(409);
      expect(rejected.body.error).toMatch(/no W-9\/W-8BEN/i);
    });

    it('rejects approving an already-approved form, and a nonexistent one', async () => {
      const builder = await signupBuilder('tax-1099-double-approve');
      const builderMe = await api('/builders/me', builder.session());
      await env.DB.prepare('UPDATE users SET tax_form_type = ?, tax_form_completed_at = ? WHERE email = ?')
        .bind('w9', '2026-01-01T00:00:00.000Z', builder.email).run();
      await grantHiggles(builderMe.body.builder.builderId, 70000);
      const year = new Date().getUTCFullYear();
      const listed = await api(`/tax/admin-forms?year=${year}`, adminSession());
      const form = listed.body.forms.find((f) => f.email === builder.email);

      const first = await api(`/tax/admin-forms/${form.formId}/approve`, adminSession({ method: 'POST' }));
      expect(first.response.status).toBe(200);
      const second = await api(`/tax/admin-forms/${form.formId}/approve`, adminSession({ method: 'POST' }));
      expect(second.response.status).toBe(409);

      const notFound = await api('/tax/admin-forms/tax1099-does-not-exist/approve', adminSession({ method: 'POST' }));
      expect(notFound.response.status).toBe(404);
    });

    it('requires admin access to approve a form', async () => {
      const builder = await signupBuilder('tax-1099-approve-not-admin');
      const rejected = await api('/tax/admin-forms/tax1099-whatever/approve', builder.session({ method: 'POST' }));
      expect(rejected.response.status).toBe(403);
    });

    // #897: the UPDATE's own status='draft' guard means the losing side of
    // a concurrent approve legitimately affects 0 rows and must 409 -- but
    // before the fix, its admin_action_log INSERT was batched with that
    // UPDATE and committed regardless, misattributing an approval that
    // never happened to whichever admin lost the race.
    it('does not log admin_action_log for the losing side of a concurrent approve', async () => {
      const builder = await signupBuilder('tax-1099-approve-race');
      const builderMe = await api('/builders/me', builder.session());
      await env.DB.prepare('UPDATE users SET tax_form_type = ?, tax_form_completed_at = ? WHERE email = ?')
        .bind('w9', '2026-01-01T00:00:00.000Z', builder.email).run();
      await grantHiggles(builderMe.body.builder.builderId, 70000);
      const year = new Date().getUTCFullYear();
      const listed = await api(`/tax/admin-forms?year=${year}`, adminSession());
      const form = listed.body.forms.find((f) => f.email === builder.email);

      // Fired together, not awaited one at a time — see reviews-auth.test.js's
      // own verify-email/reset-password races for the same "genuinely
      // concurrent, not sequential" pattern this needs to reproduce the bug.
      const [first, second] = await Promise.all([
        api(`/tax/admin-forms/${form.formId}/approve`, adminSession({ method: 'POST' })),
        api(`/tax/admin-forms/${form.formId}/approve`, adminSession({ method: 'POST' })),
      ]);
      expect([first.response.status, second.response.status].sort()).toEqual([200, 409]);

      const logRows = await env.DB.prepare(
        'SELECT COUNT(*) AS count FROM admin_action_log WHERE action_type = ? AND target_id = ?',
      ).bind('approve_1099_form', form.formId).first();
      expect(logRows.count).toBe(1);
    });

    // #763: the schema (migrations/0081) always had a 'voided' status in
    // its CHECK constraint, but nothing ever set it until now -- an admin
    // who approved a form in error (or a draft generated against a bad
    // snapshot) had no way to correct it.
    describe('1099 form voiding (#763)', () => {
      it('requires admin access to void a form', async () => {
        const builder = await signupBuilder('tax-1099-void-not-admin');
        const rejected = await api('/tax/admin-forms/tax1099-whatever/void', builder.session({ method: 'POST' }));
        expect(rejected.response.status).toBe(403);
      });

      it('rejects voiding a nonexistent form', async () => {
        const notFound = await api('/tax/admin-forms/tax1099-does-not-exist/void', adminSession({ method: 'POST' }));
        expect(notFound.response.status).toBe(404);
      });

      it('voids a draft form', async () => {
        const builder = await signupBuilder('tax-1099-void-draft');
        const builderMe = await api('/builders/me', builder.session());
        await grantHiggles(builderMe.body.builder.builderId, 70000);
        const year = new Date().getUTCFullYear();
        const listed = await api(`/tax/admin-forms?year=${year}`, adminSession());
        const form = listed.body.forms.find((f) => f.email === builder.email);

        const voided = await api(`/tax/admin-forms/${form.formId}/void`, adminSession({ method: 'POST' }));
        expect(voided.response.status).toBe(200);
        expect(voided.body.status).toBe('voided');

        const after = await api(`/tax/admin-forms?year=${year}`, adminSession());
        expect(after.body.forms.find((f) => f.email === builder.email).status).toBe('voided');

        // #815: voiding a real tax record is a correction with real
        // accountability weight — it must leave a record of which admin did it.
        const meAdmin = await api('/auth/me', adminSession());
        const logRow = await env.DB.prepare(
          'SELECT * FROM admin_action_log WHERE action_type = ? AND target_id = ?',
        ).bind('void_1099_form', form.formId).first();
        expect(logRow.admin_user_id).toBe(meAdmin.body.user.userId);
        expect(logRow.target_type).toBe('tax_1099_form');
        expect(JSON.parse(logRow.detail_json)).toMatchObject({ formType: form.formType, previousStatus: 'draft' });
      });

      it('voids an approved form', async () => {
        const builder = await signupBuilder('tax-1099-void-approved');
        const builderMe = await api('/builders/me', builder.session());
        await env.DB.prepare('UPDATE users SET tax_form_type = ?, tax_form_completed_at = ? WHERE email = ?')
          .bind('w9', '2026-01-01T00:00:00.000Z', builder.email).run();
        await grantHiggles(builderMe.body.builder.builderId, 70000);
        const year = new Date().getUTCFullYear();
        const listed = await api(`/tax/admin-forms?year=${year}`, adminSession());
        const form = listed.body.forms.find((f) => f.email === builder.email);
        const approved = await api(`/tax/admin-forms/${form.formId}/approve`, adminSession({ method: 'POST' }));
        expect(approved.response.status).toBe(200);

        const voided = await api(`/tax/admin-forms/${form.formId}/void`, adminSession({ method: 'POST' }));
        expect(voided.response.status).toBe(200);
        expect(voided.body.status).toBe('voided');
      });

      it('rejects voiding an already-voided form', async () => {
        const builder = await signupBuilder('tax-1099-void-twice');
        const builderMe = await api('/builders/me', builder.session());
        await grantHiggles(builderMe.body.builder.builderId, 70000);
        const year = new Date().getUTCFullYear();
        const listed = await api(`/tax/admin-forms?year=${year}`, adminSession());
        const form = listed.body.forms.find((f) => f.email === builder.email);

        const first = await api(`/tax/admin-forms/${form.formId}/void`, adminSession({ method: 'POST' }));
        expect(first.response.status).toBe(200);
        const second = await api(`/tax/admin-forms/${form.formId}/void`, adminSession({ method: 'POST' }));
        expect(second.response.status).toBe(409);
        expect(second.body.error).toMatch(/status "voided"/);
      });

      // #897: same reasoning as the concurrent-approve test above -- the
      // losing side of a concurrent void must not still write a log row.
      it('does not log admin_action_log for the losing side of a concurrent void', async () => {
        const builder = await signupBuilder('tax-1099-void-race');
        const builderMe = await api('/builders/me', builder.session());
        await grantHiggles(builderMe.body.builder.builderId, 70000);
        const year = new Date().getUTCFullYear();
        const listed = await api(`/tax/admin-forms?year=${year}`, adminSession());
        const form = listed.body.forms.find((f) => f.email === builder.email);

        const [first, second] = await Promise.all([
          api(`/tax/admin-forms/${form.formId}/void`, adminSession({ method: 'POST' })),
          api(`/tax/admin-forms/${form.formId}/void`, adminSession({ method: 'POST' })),
        ]);
        expect([first.response.status, second.response.status].sort()).toEqual([200, 409]);

        const logRows = await env.DB.prepare(
          'SELECT COUNT(*) AS count FROM admin_action_log WHERE action_type = ? AND target_id = ?',
        ).bind('void_1099_form', form.formId).first();
        expect(logRows.count).toBe(1);
      });

      // Filing genuinely can't be reached through the real API in this
      // test environment (no TAX_1099_EFILING_* secrets configured — see
      // the transmission describe block below), so this seeds a 'filed'
      // row directly, the same "simulate what a real transaction would
      // have written" technique this describe block already uses for
      // #612's refund-exclusion case above.
      it('rejects voiding an already-filed form', async () => {
        const builder = await signupBuilder('tax-1099-void-filed');
        const builderMe = await api('/builders/me', builder.session());
        await grantHiggles(builderMe.body.builder.builderId, 70000);
        const year = new Date().getUTCFullYear();
        const listed = await api(`/tax/admin-forms?year=${year}`, adminSession());
        const form = listed.body.forms.find((f) => f.email === builder.email);
        await env.DB.prepare(`UPDATE tax_1099_forms SET status = 'filed' WHERE form_id = ?`).bind(form.formId).run();

        const rejected = await api(`/tax/admin-forms/${form.formId}/void`, adminSession({ method: 'POST' }));
        expect(rejected.response.status).toBe(409);
        expect(rejected.body.error).toMatch(/status "filed"/);
      });
    });

    // #646 follow-up: lets an admin verify the vendor OAuth handshake
    // works the moment TAX_1099_EFILING_CLIENT_ID/_CLIENT_SECRET/
    // _USER_TOKEN are set, independent of TAX_1099_PAYER_NAME/_EIN (the
    // platform's own payer identity, which may not exist yet even once
    // vendor credentials do — see tax1099EfilingCredentialsConfigured's
    // own comment). The test environment never configures any of these,
    // so this only proves the admin gate and the narrower (credentials-
    // only) 503 path; the fetchTax1099EfilingToken call this route makes
    // once configured is exercised by the #646 transmission suite's own
    // "not configured" boundary below, not repeated here.
    describe('1099 e-filing connection test (#646 follow-up)', () => {
      it('requires admin access', async () => {
        const builder = await signupBuilder('tax-1099-conn-test-not-admin');
        const rejected = await api('/tax/efiling-connection-test', builder.session());
        expect(rejected.response.status).toBe(403);
      });

      it('returns 503 when vendor credentials are not configured', async () => {
        const { response, body } = await api('/tax/efiling-connection-test', adminSession());
        expect(response.status).toBe(503);
        expect(body.error).toMatch(/not configured/i);
      });
    });

    // #1147 (sub-issue of #1145, real account deletion): an approved
    // form must keep its own payee snapshot once user_id goes NULL
    // (migrations/0103, ON DELETE SET NULL replacing the old implicit
    // CASCADE) -- otherwise deleting the payee's account would silently
    // destroy, or permanently strand, a record the owner explicitly
    // wants retained. #1146 (the deletion endpoint itself) hasn't
    // landed yet, so this simulates a hard delete directly against the
    // `users` row to prove the schema/snapshot side of the fix on its
    // own, independent of how #1146 ends up implemented.
    it('keeps an approved form listed and filable after its payee\'s users row is deleted', async () => {
      const builder = await signupBuilder('tax-1099-orphaned-approved');
      const builderMe = await api('/builders/me', builder.session());
      await env.DB.prepare('UPDATE users SET tax_form_type = ?, tax_form_completed_at = ?, tax_id_encrypted = ? WHERE email = ?')
        .bind('w9', '2026-01-01T00:00:00.000Z', 'aesgcm$00$00', builder.email).run();
      await grantHiggles(builderMe.body.builder.builderId, 70000);
      const year = new Date().getUTCFullYear();
      const listed = await api(`/tax/admin-forms?year=${year}`, adminSession());
      const form = listed.body.forms.find((f) => f.email === builder.email);

      const approved = await api(`/tax/admin-forms/${form.formId}/approve`, adminSession({ method: 'POST' }));
      expect(approved.response.status).toBe(200);

      await env.DB.prepare('DELETE FROM users WHERE email = ?').bind(builder.email).run();

      const orphanedRow = await env.DB.prepare(
        'SELECT user_id, payee_email, payee_tax_id_encrypted, payee_tax_form_type FROM tax_1099_forms WHERE form_id = ?',
      ).bind(form.formId).first();
      expect(orphanedRow.user_id).toBeNull();
      expect(orphanedRow.payee_email).toBe(builder.email);
      expect(orphanedRow.payee_tax_id_encrypted).toBe('aesgcm$00$00');
      expect(orphanedRow.payee_tax_form_type).toBe('w9');

      // Still shows up in the review list -- the LEFT JOIN + snapshot
      // COALESCE means losing the live `users` row doesn't drop it.
      const afterDelete = await api(`/tax/admin-forms?year=${year}`, adminSession());
      const stillListed = afterDelete.body.forms.find((f) => f.formId === form.formId);
      expect(stillListed).toMatchObject({ status: 'approved', email: builder.email, taxPaperworkOnFile: true });

      // /file reaches the "not configured" 503, not the "no paperwork on
      // file" 409 -- proving it read the tax ID from the form's own
      // snapshot, not a live lookup against the now-gone `users` row.
      const fileAttempt = await api(`/tax/admin-forms/${form.formId}/file`, adminSession({ method: 'POST' }));
      expect(fileAttempt.response.status).toBe(503);
    });

    // #646: the e-filing transmission #645 was built to feed into. The
    // test environment never configures TAX_1099_EFILING_CLIENT_ID/
    // _CLIENT_SECRET/_USER_TOKEN, TAX_1099_PAYER_NAME/_EIN, or
    // TAX_ID_ENCRYPTION_KEY
    // (same dev-mode-friendly pattern as STRIPE_SECRET_KEY elsewhere in
    // this file) — these prove every local validation (admin access,
    // form existence, status, payee paperwork) runs and returns its own
    // real error before ever reaching either guarded-secret check, and
    // that a fully valid attempt only fails at the "not configured" step.
    describe('1099 e-filing transmission (#646)', () => {
      async function approvedFormFor(builder, builderMeBody) {
        await grantHiggles(builderMeBody.builder.builderId, 70000);
        await env.DB.prepare('UPDATE users SET tax_form_type = ?, tax_form_completed_at = ?, tax_id_encrypted = ? WHERE email = ?')
          .bind('w9', '2026-01-01T00:00:00.000Z', 'aesgcm$00$00', builder.email).run();
        const year = new Date().getUTCFullYear();
        const listed = await api(`/tax/admin-forms?year=${year}`, adminSession());
        const form = listed.body.forms.find((f) => f.email === builder.email);
        const approved = await api(`/tax/admin-forms/${form.formId}/approve`, adminSession({ method: 'POST' }));
        expect(approved.response.status).toBe(200);
        return form.formId;
      }

      it('requires admin access to file a form', async () => {
        const builder = await signupBuilder('tax-1099-file-not-admin');
        const rejected = await api('/tax/admin-forms/tax1099-whatever/file', builder.session({ method: 'POST' }));
        expect(rejected.response.status).toBe(403);
      });

      it('rejects filing a nonexistent form', async () => {
        const notFound = await api('/tax/admin-forms/tax1099-does-not-exist/file', adminSession({ method: 'POST' }));
        expect(notFound.response.status).toBe(404);
      });

      it('rejects filing a form that is still a draft', async () => {
        const builder = await signupBuilder('tax-1099-file-still-draft');
        const builderMe = await api('/builders/me', builder.session());
        await grantHiggles(builderMe.body.builder.builderId, 70000);
        const year = new Date().getUTCFullYear();
        const listed = await api(`/tax/admin-forms?year=${year}`, adminSession());
        const form = listed.body.forms.find((f) => f.email === builder.email);

        const rejected = await api(`/tax/admin-forms/${form.formId}/file`, adminSession({ method: 'POST' }));
        expect(rejected.response.status).toBe(409);
        expect(rejected.body.error).toMatch(/status "draft"/);
      });

      it('returns 503 once a form is approved but e-filing is not configured', async () => {
        const builder = await signupBuilder('tax-1099-file-unconfigured');
        const builderMe = await api('/builders/me', builder.session());
        const formId = await approvedFormFor(builder, builderMe.body);

        const { response, body } = await api(`/tax/admin-forms/${formId}/file`, adminSession({ method: 'POST' }));
        expect(response.status).toBe(503);
        expect(body.error).toMatch(/not configured/i);
      });
    });
  });
});
