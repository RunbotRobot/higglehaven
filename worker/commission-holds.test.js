// #1109 (owner decision, 2026-10-27): velocity-based limits on commission
// cash outs. Covers the two cap shapes (established per-sale multiplier,
// new-builder cumulative flat cap), the escrow hold they create,
// clawBackPurchaseCommission's interaction with an active hold on refund,
// and releaseDueCommissionHolds' own cron sweep. See migrations/
// 0164_commission_holds.sql and worker/lib/commission-caps.js for the
// full mechanism.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  releaseDueCommissionHolds, releaseHoldAndCreditStatements,
  MIN_ESTABLISHED_COUNTERPARTIES, NEW_BUILDER_FLAT_CAP_CENTS, ESTABLISHED_CAP_MULTIPLIER,
} from './lib/commission-caps.js';
import { api, signupAdmin } from './test-helpers.js';

let adminSession;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const admin = await signupAdmin('commission-holds-admin');
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

async function createTemplate(templateId, priceCents) {
  const created = await api('/catalog', {
    method: 'POST',
    body: JSON.stringify({
      templateId,
      name: `Purchasable product ${templateId}`,
      color: '#123456',
      dimensions: { width: 1, depth: 1, height: 1 },
      priceCents,
    }),
  });
  expect(created.response.status).toBe(201);
  return templateId;
}

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

async function purchase(instanceId, buyer) {
  const purchased = await api(`/instances/${instanceId}/purchase`, buyer.session({ method: 'POST' }));
  expect(purchased.response.status).toBe(201);
  return purchased.body.purchase;
}

// One seller + one priced template + one landlet-hosted instance, ready
// for repeated purchases by different buyers -- shared setup every test
// below needs, parameterized only by a unique id/price so tests don't
// collide with each other in this file's one shared D1 instance.
async function setUpSeller(id, priceCents) {
  const seller = await signupAdmin(`${id}-seller`);
  await createGreenbeltLandletWithArea(`${id}-landlet`, 1000);
  await claim(`${id}-landlet`, seller);
  await createTemplate(`${id}-template`, priceCents);
  await placeInstance(`${id}-instance`, `${id}-landlet`, `${id}-template`, seller);
  return seller;
}

describe('Established-builder per-sale cap (#1109)', () => {
  it('caps a sale that exceeds multiplier * average, escrowing the excess', async () => {
    const seller = await setUpSeller('established-cap', 1000); // $10/sale -> $0.10 commission (2% * 50%)
    // Establish history: MIN_ESTABLISHED_COUNTERPARTIES distinct buyers,
    // one ordinary purchase each.
    for (let i = 0; i < MIN_ESTABLISHED_COUNTERPARTIES; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- sequential fixture setup, order matters for distinct buyers
      const buyer = await signupAdmin(`established-cap-history-${i}`);
      // eslint-disable-next-line no-await-in-loop
      await purchase('established-cap-instance', buyer);
    }
    const beforeBalance = (await builderRow(seller.builderId)).higgles_balance_cents;

    // A new instance priced high enough that its own commission is
    // guaranteed to exceed ESTABLISHED_CAP_MULTIPLIER * the $0.10-ish
    // average established above, forcing a real cap.
    await createTemplate('established-cap-big-template', 100000); // $1000 -> $10 commission
    await placeInstance('established-cap-big-instance', 'established-cap-landlet', 'established-cap-big-template', seller);
    const bigBuyer = await signupAdmin('established-cap-big-buyer');
    const bigPurchase = await purchase('established-cap-big-instance', bigBuyer);

    const afterBalance = (await builderRow(seller.builderId)).higgles_balance_cents;
    const creditedNow = afterBalance - beforeBalance;
    expect(creditedNow).toBeLessThan(bigPurchase.builderShareCents);
    expect(creditedNow).toBeGreaterThan(0);

    const hold = await env.DB.prepare('SELECT * FROM commission_holds WHERE purchase_id = ?').bind(bigPurchase.purchaseId).first();
    expect(hold).toBeTruthy();
    expect(hold.amount_cents).toBe(bigPurchase.builderShareCents - creditedNow);
    expect(hold.released_at).toBeNull();
    expect(hold.revoked_at).toBeNull();

    const earningsEvents = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM higgles_earnings_events WHERE builder_id = ? AND amount_cents = ?',
    ).bind(seller.builderId, creditedNow).first();
    expect(earningsEvents.count).toBeGreaterThan(0);
  });

  it('credits a sale under the cap in full, with no hold row', async () => {
    const seller = await setUpSeller('established-under-cap', 1000);
    for (let i = 0; i < MIN_ESTABLISHED_COUNTERPARTIES; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const buyer = await signupAdmin(`established-under-cap-history-${i}`);
      // eslint-disable-next-line no-await-in-loop
      await purchase('established-under-cap-instance', buyer);
    }
    const beforeBalance = (await builderRow(seller.builderId)).higgles_balance_cents;

    const ordinaryBuyer = await signupAdmin('established-under-cap-ordinary-buyer');
    const ordinaryPurchase = await purchase('established-under-cap-instance', ordinaryBuyer);

    const afterBalance = (await builderRow(seller.builderId)).higgles_balance_cents;
    expect(afterBalance - beforeBalance).toBe(ordinaryPurchase.builderShareCents);
    const hold = await env.DB.prepare('SELECT * FROM commission_holds WHERE purchase_id = ?').bind(ordinaryPurchase.purchaseId).first();
    expect(hold).toBeNull();
  });
});

describe('New-builder cumulative per-counterparty cap (#1109)', () => {
  it('escrows the excess once the same counterparty\'s cumulative total would exceed the flat cap', async () => {
    // Priced so one sale's commission is a little over half the flat cap,
    // so a second sale from the same buyer pushes the running total over
    // it, but the first sale alone does not.
    // builderShareCents = round(totalCents * PURCHASE_COMMISSION_RATE * PURCHASE_BUILDER_SPLIT)
    // = round(priceCents * 0.01) for a single-quantity purchase (the floor
    // rate, 0.005, never binds since it's smaller) -- solve for a
    // builderShareCents around 60% of the flat cap.
    const priceCents = Math.round((NEW_BUILDER_FLAT_CAP_CENTS * 0.6) / 0.01);
    const seller = await setUpSeller('new-builder-cumulative', priceCents);
    const buyer = await signupAdmin('new-builder-cumulative-buyer');

    const first = await purchase('new-builder-cumulative-instance', buyer);
    expect(first.builderShareCents).toBeLessThan(NEW_BUILDER_FLAT_CAP_CENTS);
    const firstHold = await env.DB.prepare('SELECT * FROM commission_holds WHERE purchase_id = ?').bind(first.purchaseId).first();
    expect(firstHold).toBeNull();

    await createTemplate('new-builder-cumulative-template-2', priceCents);
    await placeInstance('new-builder-cumulative-instance-2', 'new-builder-cumulative-landlet', 'new-builder-cumulative-template-2', seller);
    const beforeBalance = (await builderRow(seller.builderId)).higgles_balance_cents;
    const second = await purchase('new-builder-cumulative-instance-2', buyer);
    const afterBalance = (await builderRow(seller.builderId)).higgles_balance_cents;

    const creditedNow = afterBalance - beforeBalance;
    const expectedRemainingHeadroom = NEW_BUILDER_FLAT_CAP_CENTS - first.builderShareCents;
    expect(creditedNow).toBe(expectedRemainingHeadroom);
    expect(creditedNow).toBeLessThan(second.builderShareCents);

    const secondHold = await env.DB.prepare('SELECT * FROM commission_holds WHERE purchase_id = ?').bind(second.purchaseId).first();
    expect(secondHold).toBeTruthy();
    expect(secondHold.amount_cents).toBe(second.builderShareCents - creditedNow);
  });

  it('applies the cumulative cap per counterparty, not globally across all new-builder buyers', async () => {
    const priceCents = Math.round((NEW_BUILDER_FLAT_CAP_CENTS * 0.8) / 0.01);
    const seller = await setUpSeller('new-builder-per-counterparty', priceCents);
    const buyerA = await signupAdmin('new-builder-per-counterparty-a');
    const buyerB = await signupAdmin('new-builder-per-counterparty-b');

    const purchaseA = await purchase('new-builder-per-counterparty-instance', buyerA);
    expect(purchaseA.builderShareCents).toBeLessThan(NEW_BUILDER_FLAT_CAP_CENTS);
    const holdA = await env.DB.prepare('SELECT * FROM commission_holds WHERE purchase_id = ?').bind(purchaseA.purchaseId).first();
    expect(holdA).toBeNull();

    const beforeBalance = (await builderRow(seller.builderId)).higgles_balance_cents;
    const purchaseB = await purchase('new-builder-per-counterparty-instance', buyerB);
    const afterBalance = (await builderRow(seller.builderId)).higgles_balance_cents;
    // Buyer B is a fresh counterparty -- their own 80%-of-cap sale is fully
    // under the cap on its own, regardless of buyer A's unrelated history.
    expect(afterBalance - beforeBalance).toBe(purchaseB.builderShareCents);
    const holdB = await env.DB.prepare('SELECT * FROM commission_holds WHERE purchase_id = ?').bind(purchaseB.purchaseId).first();
    expect(holdB).toBeNull();
  });

  // #2879: regression for a genuine TOCTOU race -- remainingCommissionCapCents
  // used to read "already credited" with a plain pre-batch SELECT, so two
  // near-simultaneous purchases from the same counterparty could each read
  // $0 already credited and each credit their own full share, jointly
  // exceeding NEW_BUILDER_FLAT_CAP_CENTS. Promise.all here reproduces the
  // same interleaving the real bug needed: both requests' awaited DB reads
  // overlap in the event loop even though nothing here is truly
  // multi-threaded. Fixed by commissionCreditClaimStatement, which makes
  // and applies the credit decision as one atomic, live-evaluated write
  // instead of a separate stale read.
  it('never jointly credits over the cap when two purchases from the same counterparty race', async () => {
    // Each purchase's own commission is ~60% of the flat cap -- comfortably
    // under cap alone, but the two together are 120% of it, so the bug (if
    // present) credits both in full and the fix must still cap the total.
    const priceCents = Math.round((NEW_BUILDER_FLAT_CAP_CENTS * 0.6) / 0.01);
    const seller = await setUpSeller('new-builder-race', priceCents);
    await createTemplate('new-builder-race-template-2', priceCents);
    await placeInstance('new-builder-race-instance-2', 'new-builder-race-landlet', 'new-builder-race-template-2', seller);
    const buyer = await signupAdmin('new-builder-race-buyer');
    const beforeBalance = (await builderRow(seller.builderId)).higgles_balance_cents;

    const [first, second] = await Promise.all([
      purchase('new-builder-race-instance', buyer),
      purchase('new-builder-race-instance-2', buyer),
    ]);

    const afterBalance = (await builderRow(seller.builderId)).higgles_balance_cents;
    const totalCreditedNow = afterBalance - beforeBalance;
    const totalShareCents = first.builderShareCents + second.builderShareCents;
    expect(totalShareCents).toBeGreaterThan(NEW_BUILDER_FLAT_CAP_CENTS);
    expect(totalCreditedNow).toBeLessThanOrEqual(NEW_BUILDER_FLAT_CAP_CENTS);
    expect(totalCreditedNow).toBeLessThan(totalShareCents);

    // Whatever wasn't credited now must be escrowed, not silently dropped.
    const holds = await env.DB.prepare(
      'SELECT COALESCE(SUM(amount_cents), 0) AS total FROM commission_holds WHERE purchase_id IN (?, ?)',
    ).bind(first.purchaseId, second.purchaseId).first();
    expect(totalCreditedNow + holds.total).toBe(totalShareCents);
  });
});

describe('Refund clawback interaction with an active hold (#1109)', () => {
  it('claws back only the amount actually credited, and revokes the hold', async () => {
    const seller = await setUpSeller('refund-active-hold', 1000);
    for (let i = 0; i < MIN_ESTABLISHED_COUNTERPARTIES; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const buyer = await signupAdmin(`refund-active-hold-history-${i}`);
      // eslint-disable-next-line no-await-in-loop
      await purchase('refund-active-hold-instance', buyer);
    }
    await createTemplate('refund-active-hold-big-template', 100000);
    await placeInstance('refund-active-hold-big-instance', 'refund-active-hold-landlet', 'refund-active-hold-big-template', seller);
    const bigBuyer = await signupAdmin('refund-active-hold-big-buyer');
    const beforeBalance = (await builderRow(seller.builderId)).higgles_balance_cents;
    const bigPurchase = await purchase('refund-active-hold-big-instance', bigBuyer);
    const afterCreditBalance = (await builderRow(seller.builderId)).higgles_balance_cents;
    const creditedNow = afterCreditBalance - beforeBalance;
    expect(creditedNow).toBeLessThan(bigPurchase.builderShareCents); // confirms a hold really was created

    const refunded = await api(`/purchases/${bigPurchase.purchaseId}/refund`, adminSession({ method: 'POST' }));
    expect(refunded.response.status).toBe(200);

    const afterRefundBalance = (await builderRow(seller.builderId)).higgles_balance_cents;
    // Only the amount actually credited should be clawed back -- balance
    // should return to exactly its pre-purchase level, not go negative by
    // the escrowed-but-never-credited difference.
    expect(afterRefundBalance).toBe(beforeBalance);

    const hold = await env.DB.prepare('SELECT * FROM commission_holds WHERE purchase_id = ?').bind(bigPurchase.purchaseId).first();
    expect(hold.revoked_at).not.toBeNull();
    expect(hold.released_at).toBeNull();

    // The release sweep must leave a revoked hold alone.
    await releaseDueCommissionHolds(env.DB);
    const afterSweepBalance = (await builderRow(seller.builderId)).higgles_balance_cents;
    expect(afterSweepBalance).toBe(beforeBalance);
    const holdAfterSweep = await env.DB.prepare('SELECT released_at FROM commission_holds WHERE purchase_id = ?').bind(bigPurchase.purchaseId).first();
    expect(holdAfterSweep.released_at).toBeNull();
  });

  // #2935: regression for a genuine TOCTOU race -- releaseOrRevokeHold's
  // own purchase.refunded_at re-check is itself a stale pre-read relative
  // to a concurrent refund's own revoke landing in the gap before the
  // sweep's batch runs. The real race (two genuinely concurrent requests)
  // is too narrow a window for Promise.all to land reliably in this
  // suite's single-process test runner -- confirmed empirically: racing
  // the real refund endpoint, and even clawBackPurchaseCommission called
  // directly, against releaseDueCommissionHolds never reproduced it in
  // several batches of 8 runs each, unlike #2879's own wider-window
  // concurrent-purchase race above. So this exercises
  // releaseHoldAndCreditStatements (the exported statement-builder the
  // fix pulled out of releaseOrRevokeHold for exactly this reason)
  // directly against a hold a prior statement has already revoked --
  // deterministically reproducing the exact state a genuinely-losing
  // sweep would see, without depending on real scheduling.
  it('releaseHoldAndCreditStatements never credits or releases a hold a concurrent revoke already won', async () => {
    const seller = await setUpSeller('release-revoke-race', 1000);
    for (let i = 0; i < MIN_ESTABLISHED_COUNTERPARTIES; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- sequential fixture setup, order matters for distinct buyers
      const buyer = await signupAdmin(`release-revoke-race-history-${i}`);
      // eslint-disable-next-line no-await-in-loop
      await purchase('release-revoke-race-instance', buyer);
    }
    await createTemplate('release-revoke-race-big-template', 100000);
    await placeInstance('release-revoke-race-big-instance', 'release-revoke-race-landlet', 'release-revoke-race-big-template', seller);
    const bigBuyer = await signupAdmin('release-revoke-race-big-buyer');
    const beforeBalance = (await builderRow(seller.builderId)).higgles_balance_cents;
    const bigPurchase = await purchase('release-revoke-race-big-instance', bigBuyer);
    const hold = await env.DB.prepare('SELECT * FROM commission_holds WHERE purchase_id = ?').bind(bigPurchase.purchaseId).first();
    expect(hold).toBeTruthy(); // confirms a hold really was created

    // Simulates a concurrent clawBackPurchaseCommission's revoke already
    // having committed, in the gap after releaseOrRevokeHold's own
    // purchase.refunded_at read but before its batch runs below.
    await env.DB.prepare('UPDATE commission_holds SET revoked_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\', \'now\') WHERE hold_id = ?')
      .bind(hold.hold_id).run();

    const releaseStatement = env.DB.prepare('UPDATE commission_holds SET released_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\', \'now\') WHERE hold_id = ? AND released_at IS NULL AND revoked_at IS NULL')
      .bind(hold.hold_id);
    await env.DB.batch(releaseHoldAndCreditStatements(env.DB, { hold, amountCents: hold.amount_cents, releaseStatement }));

    // The already-won revoke must be the only thing that happened -- never
    // the stale caller's credit on top of it, and never a release either
    // (both would corrupt the hold's own mutual-exclusion invariant, not
    // just double the money). Balance should sit exactly where the
    // purchase itself left it (the immediate, uncapped share only) --
    // hold.amount_cents must never also land on top.
    const afterBalance = (await builderRow(seller.builderId)).higgles_balance_cents;
    expect(afterBalance).toBe(beforeBalance + (bigPurchase.builderShareCents - hold.amount_cents));
    const earningsEvent = await env.DB.prepare('SELECT 1 FROM higgles_earnings_events WHERE builder_id = ? AND amount_cents = ?')
      .bind(seller.builderId, hold.amount_cents).first();
    expect(earningsEvent).toBeNull();
    const holdAfter = await env.DB.prepare('SELECT released_at, revoked_at FROM commission_holds WHERE hold_id = ?').bind(hold.hold_id).first();
    expect(holdAfter.released_at).toBeNull();
    expect(holdAfter.revoked_at).not.toBeNull();
  });

  it('claws back the full commission when the hold was already released before the refund', async () => {
    const seller = await setUpSeller('refund-released-hold', 1000);
    for (let i = 0; i < MIN_ESTABLISHED_COUNTERPARTIES; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const buyer = await signupAdmin(`refund-released-hold-history-${i}`);
      // eslint-disable-next-line no-await-in-loop
      await purchase('refund-released-hold-instance', buyer);
    }
    await createTemplate('refund-released-hold-big-template', 100000);
    await placeInstance('refund-released-hold-big-instance', 'refund-released-hold-landlet', 'refund-released-hold-big-template', seller);
    const bigBuyer = await signupAdmin('refund-released-hold-big-buyer');
    const beforeBalance = (await builderRow(seller.builderId)).higgles_balance_cents;
    const bigPurchase = await purchase('refund-released-hold-big-instance', bigBuyer);

    // Force the hold's own release_at into the past, then run the sweep to
    // actually release it -- simulating the hold period having elapsed.
    await env.DB.prepare('UPDATE commission_holds SET release_at = \'2000-01-01T00:00:00.000Z\' WHERE purchase_id = ?')
      .bind(bigPurchase.purchaseId).run();
    await releaseDueCommissionHolds(env.DB);
    const afterReleaseBalance = (await builderRow(seller.builderId)).higgles_balance_cents;
    expect(afterReleaseBalance - beforeBalance).toBe(bigPurchase.builderShareCents);

    const refunded = await api(`/purchases/${bigPurchase.purchaseId}/refund`, adminSession({ method: 'POST' }));
    expect(refunded.response.status).toBe(200);
    const afterRefundBalance = (await builderRow(seller.builderId)).higgles_balance_cents;
    expect(afterRefundBalance).toBe(beforeBalance);
  });
});

// #2902: a partial refund that lands while a commission hold is still
// active doesn't shrink the hold's own amount_cents (handlePartialRefundWebhookEvent's
// own accepted residual gap, worker/lib/stripe.js) -- these tests drive
// the purchase row and builder balance directly into the exact state that
// webhook handler would have produced (same "bypass the real trigger,
// isolate the sweep's own logic" shape the refunded-purchase sweep test
// above already uses), since this test file's purchases never go through
// a real Stripe webhook at all (Stripe is unconfigured here, same as
// every other commission-holds test).
describe('Commission-hold release accounts for a partial refund that landed while active (#2902)', () => {
  it('releases only the proportional remaining share once a 50% partial refund already clawed back the immediate credit', async () => {
    const seller = await setUpSeller('partial-refund-active-hold', 1000);
    for (let i = 0; i < MIN_ESTABLISHED_COUNTERPARTIES; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const buyer = await signupAdmin(`partial-refund-active-hold-history-${i}`);
      // eslint-disable-next-line no-await-in-loop
      await purchase('partial-refund-active-hold-instance', buyer);
    }
    await createTemplate('partial-refund-active-hold-big-template', 100000);
    await placeInstance('partial-refund-active-hold-big-instance', 'partial-refund-active-hold-landlet', 'partial-refund-active-hold-big-template', seller);
    const bigBuyer = await signupAdmin('partial-refund-active-hold-big-buyer');
    const beforeBalance = (await builderRow(seller.builderId)).higgles_balance_cents;
    const bigPurchase = await purchase('partial-refund-active-hold-big-instance', bigBuyer);
    const hold = await env.DB.prepare('SELECT * FROM commission_holds WHERE purchase_id = ?').bind(bigPurchase.purchaseId).first();
    expect(hold.amount_cents).toBeGreaterThan(0); // confirms a real hold exists to shrink

    // Simulate a clean 50% partial refund -- the exact DB effects
    // handlePartialRefundWebhookEvent itself would have produced: claws
    // back only the already-credited immediate share (builder_share_cents
    // minus the hold), and records the cumulative refunded total.
    const immediateCreditedCents = bigPurchase.builderShareCents - hold.amount_cents;
    const refundedCents = Math.round(bigPurchase.totalCents / 2);
    const immediateClawbackCents = Math.min(immediateCreditedCents, Math.round((immediateCreditedCents * refundedCents) / bigPurchase.totalCents));
    await env.DB.batch([
      env.DB.prepare('UPDATE purchases SET refunded_amount_cents = ? WHERE purchase_id = ?').bind(refundedCents, bigPurchase.purchaseId),
      env.DB.prepare('UPDATE builders SET higgles_balance_cents = higgles_balance_cents - ? WHERE builder_id = ?').bind(immediateClawbackCents, seller.builderId),
    ]);
    const afterPartialRefundBalance = (await builderRow(seller.builderId)).higgles_balance_cents;

    // Force the hold due, then release it.
    await env.DB.prepare('UPDATE commission_holds SET release_at = \'2000-01-01T00:00:00.000Z\' WHERE hold_id = ?').bind(hold.hold_id).run();
    await releaseDueCommissionHolds(env.DB);

    const expectedTrueRemovedCents = Math.round(bigPurchase.builderShareCents * refundedCents / bigPurchase.totalCents);
    const expectedReleaseCents = hold.amount_cents - (expectedTrueRemovedCents - immediateClawbackCents);
    const afterReleaseBalance = (await builderRow(seller.builderId)).higgles_balance_cents;
    expect(afterReleaseBalance - afterPartialRefundBalance).toBe(expectedReleaseCents);
    // Net result across the whole purchase lifetime: exactly half the
    // commission retained, matching the 50% refund -- not the full
    // builder_share_cents the pre-#2902 code released regardless.
    expect(afterReleaseBalance - beforeBalance).toBe(bigPurchase.builderShareCents - expectedTrueRemovedCents);
    expect(afterReleaseBalance - beforeBalance).toBeLessThan(bigPurchase.builderShareCents);

    const releasedHold = await env.DB.prepare('SELECT released_at, revoked_at FROM commission_holds WHERE hold_id = ?').bind(hold.hold_id).first();
    expect(releasedHold.released_at).not.toBeNull();
    expect(releasedHold.revoked_at).toBeNull();

    const earningsEvents = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM higgles_earnings_events WHERE builder_id = ? AND amount_cents = ?',
    ).bind(seller.builderId, expectedReleaseCents).first();
    expect(earningsEvents.count).toBeGreaterThan(0);
  });

  it('releases nothing (but still marks the hold released) once a large enough partial refund already ate through the whole remaining share', async () => {
    const seller = await setUpSeller('partial-refund-eats-hold', 1000);
    for (let i = 0; i < MIN_ESTABLISHED_COUNTERPARTIES; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const buyer = await signupAdmin(`partial-refund-eats-hold-history-${i}`);
      // eslint-disable-next-line no-await-in-loop
      await purchase('partial-refund-eats-hold-instance', buyer);
    }
    await createTemplate('partial-refund-eats-hold-big-template', 100000);
    await placeInstance('partial-refund-eats-hold-big-instance', 'partial-refund-eats-hold-landlet', 'partial-refund-eats-hold-big-template', seller);
    const bigBuyer = await signupAdmin('partial-refund-eats-hold-big-buyer');
    const bigPurchase = await purchase('partial-refund-eats-hold-big-instance', bigBuyer);
    const hold = await env.DB.prepare('SELECT * FROM commission_holds WHERE purchase_id = ?').bind(bigPurchase.purchaseId).first();

    // A partial refund just 1 cent short of the full purchase total --
    // not a full refund (so this still goes through the partial-refund
    // path, not the refunded_at revoke branch), but close enough that
    // rounding the proportional share to the nearest cent correctly
    // collapses the remaining release to zero. (A genuinely partial,
    // i.e. non-100%, refund can mathematically only approach but never
    // exceed the hold's own remaining share -- see the formula in
    // releaseOrRevokeHold -- so this edge, not an arbitrary high
    // percentage, is what actually drives the release to 0.)
    const immediateCreditedCents = bigPurchase.builderShareCents - hold.amount_cents;
    const refundedCents = bigPurchase.totalCents - 1;
    const immediateClawbackCents = Math.min(immediateCreditedCents, Math.round((immediateCreditedCents * refundedCents) / bigPurchase.totalCents));
    await env.DB.batch([
      env.DB.prepare('UPDATE purchases SET refunded_amount_cents = ? WHERE purchase_id = ?').bind(refundedCents, bigPurchase.purchaseId),
      env.DB.prepare('UPDATE builders SET higgles_balance_cents = higgles_balance_cents - ? WHERE builder_id = ?').bind(immediateClawbackCents, seller.builderId),
    ]);
    const afterPartialRefundBalance = (await builderRow(seller.builderId)).higgles_balance_cents;

    await env.DB.prepare('UPDATE commission_holds SET release_at = \'2000-01-01T00:00:00.000Z\' WHERE hold_id = ?').bind(hold.hold_id).run();
    await releaseDueCommissionHolds(env.DB);

    // Nothing left in the hold to release -- balance unchanged by this step.
    expect((await builderRow(seller.builderId)).higgles_balance_cents).toBe(afterPartialRefundBalance);
    const releasedHold = await env.DB.prepare('SELECT released_at, revoked_at FROM commission_holds WHERE hold_id = ?').bind(hold.hold_id).first();
    // Still marked released, not left dangling for the sweep to retry forever.
    expect(releasedHold.released_at).not.toBeNull();
    expect(releasedHold.revoked_at).toBeNull();
  });
});

// #2936: clawBackPurchaseCommission's own pre-read of the active hold used
// to be a plain SELECT, separate from its later debit -- if a concurrent
// releaseDueCommissionHolds sweep's own credit+release landed in the gap
// between that read and the debit, the debit would still only exclude the
// pre-sweep hold amount, under-clawing-back by exactly what the sweep had
// just (correctly, on its own) credited. The fix makes the revoke attempt
// itself the live, atomic read (UPDATE ... RETURNING), so there's no
// separate stale read left to race. Fired genuinely concurrently, same
// "assert the invariant holds for either winner, not a forced ordering"
// shape as the #1061 precedent in seller-payouts-and-tax.test.js -- the
// release side here is a hand-rolled, correctly-guarded simulated batch
// (not the real releaseOrRevokeHold/releaseDueCommissionHolds, which as of
// this writing still carry a separate, unrelated bug of their own -- #2935)
// so this test's own correctness doesn't depend on that sibling issue.
describe('Refund clawback racing a concurrent release sweep (#2936)', () => {
  async function simulateGuardedRelease(holdId, builderId, amountCents) {
    // Mirrors releaseOrRevokeHold's own release path, but -- unlike that
    // function as of #2935 -- gates ALL three effects (not just the final
    // released_at flip) on a single atomic guarded UPDATE...RETURNING, so
    // this simulated release can never double-credit regardless of how it
    // interleaves with a concurrent clawback.
    const won = await env.DB.prepare(`
      UPDATE commission_holds SET released_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE hold_id = ? AND released_at IS NULL AND revoked_at IS NULL
      RETURNING hold_id
    `).bind(holdId).first();
    if (!won) return;
    await env.DB.batch([
      env.DB.prepare('UPDATE builders SET higgles_balance_cents = higgles_balance_cents + ? WHERE builder_id = ?').bind(amountCents, builderId),
      env.DB.prepare('INSERT INTO higgles_earnings_events (event_id, builder_id, amount_cents) VALUES (?, ?, ?)').bind(`earnings-${crypto.randomUUID()}`, builderId, amountCents),
    ]);
  }

  it('leaves the builder balance at exactly the pre-purchase baseline regardless of which side wins', async () => {
    const seller = await setUpSeller('clawback-sweep-race', 1000);
    for (let i = 0; i < MIN_ESTABLISHED_COUNTERPARTIES; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const buyer = await signupAdmin(`clawback-sweep-race-history-${i}`);
      // eslint-disable-next-line no-await-in-loop
      await purchase('clawback-sweep-race-instance', buyer);
    }
    await createTemplate('clawback-sweep-race-big-template', 100000);
    await placeInstance('clawback-sweep-race-big-instance', 'clawback-sweep-race-landlet', 'clawback-sweep-race-big-template', seller);
    const bigBuyer = await signupAdmin('clawback-sweep-race-big-buyer');
    const beforeBalance = (await builderRow(seller.builderId)).higgles_balance_cents;
    const bigPurchase = await purchase('clawback-sweep-race-big-instance', bigBuyer);
    const hold = await env.DB.prepare('SELECT * FROM commission_holds WHERE purchase_id = ?').bind(bigPurchase.purchaseId).first();
    expect(hold.amount_cents).toBeGreaterThan(0); // confirms a real hold exists to race over

    const [refunded] = await Promise.all([
      api(`/purchases/${bigPurchase.purchaseId}/refund`, adminSession({ method: 'POST' })),
      simulateGuardedRelease(hold.hold_id, seller.builderId, hold.amount_cents),
    ]);
    expect(refunded.response.status).toBe(200);

    // Whichever side actually won the race to resolve the hold, the net
    // effect on the builder's balance must be identical: this purchase was
    // fully refunded, so nothing from it should remain credited.
    const afterBalance = (await builderRow(seller.builderId)).higgles_balance_cents;
    expect(afterBalance).toBe(beforeBalance);

    // The hold itself must land in exactly one terminal state -- never
    // both released and revoked, and never neither (which would mean the
    // sweep's own release attempt and the clawback's own revoke attempt
    // each thought the other had already handled it).
    const holdAfter = await env.DB.prepare('SELECT released_at, revoked_at FROM commission_holds WHERE hold_id = ?').bind(hold.hold_id).first();
    expect([holdAfter.released_at !== null, holdAfter.revoked_at !== null].filter(Boolean).length).toBe(1);
  });

  // Deterministic version of the race just above, targeting the exact
  // window the bug lived in rather than relying on however this test
  // harness happens to schedule a genuinely concurrent Promise.all (which,
  // for this particular pairing, reliably lets each side fully resolve
  // before the other reaches its own critical statement -- see that test's
  // own comment -- so it never actually lands inside the narrow window).
  // clawBackPurchaseCommission's own hold check and its builder-balance
  // debit have no await between them, so the only place a concurrent
  // release can actually land "in between" from this test's point of view
  // is by intercepting the debit's own statement right as it's about to
  // run and synchronously driving the release to completion first --
  // reproducing, deterministically, exactly what a sweep's commit landing
  // in that gap would have done to a caller already holding the pre-sweep
  // hold-active result.
  it('still claws back the full share when a concurrent release lands between the hold check and the debit', async () => {
    const seller = await setUpSeller('clawback-sweep-deterministic', 1000);
    for (let i = 0; i < MIN_ESTABLISHED_COUNTERPARTIES; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const buyer = await signupAdmin(`clawback-sweep-deterministic-history-${i}`);
      // eslint-disable-next-line no-await-in-loop
      await purchase('clawback-sweep-deterministic-instance', buyer);
    }
    await createTemplate('clawback-sweep-deterministic-big-template', 100000);
    await placeInstance('clawback-sweep-deterministic-big-instance', 'clawback-sweep-deterministic-landlet', 'clawback-sweep-deterministic-big-template', seller);
    const bigBuyer = await signupAdmin('clawback-sweep-deterministic-big-buyer');
    const beforeBalance = (await builderRow(seller.builderId)).higgles_balance_cents;
    const bigPurchase = await purchase('clawback-sweep-deterministic-big-instance', bigBuyer);
    const hold = await env.DB.prepare('SELECT * FROM commission_holds WHERE purchase_id = ?').bind(bigPurchase.purchaseId).first();
    expect(hold.amount_cents).toBeGreaterThan(0); // confirms a real hold exists to race over

    const originalPrepare = env.DB.prepare.bind(env.DB);
    let armed = true;
    env.DB.prepare = (sql) => {
      const stmt = originalPrepare(sql);
      if (armed && sql.includes('UPDATE builders SET higgles_balance_cents = higgles_balance_cents - ?')) {
        armed = false;
        const originalBind = stmt.bind.bind(stmt);
        stmt.bind = (...bindArgs) => {
          const bound = originalBind(...bindArgs);
          const originalRun = bound.run.bind(bound);
          bound.run = async () => {
            // The sweep's own release commits here, in between
            // clawBackPurchaseCommission's own hold check (already
            // resolved by this point, "hold still active") and the debit
            // about to run with that now-stale result.
            await simulateGuardedRelease(hold.hold_id, seller.builderId, hold.amount_cents);
            return originalRun();
          };
          return bound;
        };
      }
      return stmt;
    };
    let refunded;
    try {
      refunded = await api(`/purchases/${bigPurchase.purchaseId}/refund`, adminSession({ method: 'POST' }));
    } finally {
      env.DB.prepare = originalPrepare;
    }
    expect(refunded.response.status).toBe(200);

    // Without the fix, a stale pre-release read would only debit the
    // immediate share computed before this intercepted statement ran,
    // leaving hold.amount_cents -- which the simulated release injected
    // right here would have just credited -- stuck in the builder's
    // balance. The fix's atomic revoke-first check already claims the
    // hold before this debit statement is even reached, so by the time
    // this intercepted debit (and the simulated release it triggers)
    // actually runs, the hold is already revoked and the simulated
    // release's own guard correctly finds nothing left to credit --
    // either way, the debit below must claw back the full
    // builder_share_cents, landing exactly back at the pre-purchase
    // baseline.
    const afterBalance = (await builderRow(seller.builderId)).higgles_balance_cents;
    expect(afterBalance).toBe(beforeBalance);

    const holdAfter = await env.DB.prepare('SELECT released_at, revoked_at FROM commission_holds WHERE hold_id = ?').bind(hold.hold_id).first();
    expect(holdAfter.revoked_at).not.toBeNull();
    expect(holdAfter.released_at).toBeNull();
  });
});

describe('releaseDueCommissionHolds cron sweep (#1109)', () => {
  it('credits a past-due hold and leaves a not-yet-due one alone', async () => {
    const seller = await setUpSeller('release-sweep', 1000);
    for (let i = 0; i < MIN_ESTABLISHED_COUNTERPARTIES; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const buyer = await signupAdmin(`release-sweep-history-${i}`);
      // eslint-disable-next-line no-await-in-loop
      await purchase('release-sweep-instance', buyer);
    }
    await createTemplate('release-sweep-big-template', 100000);
    await placeInstance('release-sweep-big-instance', 'release-sweep-landlet', 'release-sweep-big-template', seller);
    const bigBuyer = await signupAdmin('release-sweep-big-buyer');
    const beforeBalance = (await builderRow(seller.builderId)).higgles_balance_cents;
    const bigPurchase = await purchase('release-sweep-big-instance', bigBuyer);
    const afterCreditBalance = (await builderRow(seller.builderId)).higgles_balance_cents;
    const hold = await env.DB.prepare('SELECT * FROM commission_holds WHERE purchase_id = ?').bind(bigPurchase.purchaseId).first();

    // Not yet due: sweep must not touch it.
    await releaseDueCommissionHolds(env.DB);
    expect((await builderRow(seller.builderId)).higgles_balance_cents).toBe(afterCreditBalance);
    expect((await env.DB.prepare('SELECT released_at FROM commission_holds WHERE hold_id = ?').bind(hold.hold_id).first()).released_at).toBeNull();

    // Force it due, then sweep again.
    await env.DB.prepare('UPDATE commission_holds SET release_at = \'2000-01-01T00:00:00.000Z\' WHERE hold_id = ?').bind(hold.hold_id).run();
    await releaseDueCommissionHolds(env.DB);
    const afterReleaseBalance = (await builderRow(seller.builderId)).higgles_balance_cents;
    expect(afterReleaseBalance - afterCreditBalance).toBe(hold.amount_cents);
    expect(afterReleaseBalance - beforeBalance).toBe(bigPurchase.builderShareCents);

    const releasedHold = await env.DB.prepare('SELECT released_at, revoked_at FROM commission_holds WHERE hold_id = ?').bind(hold.hold_id).first();
    expect(releasedHold.released_at).not.toBeNull();
    expect(releasedHold.revoked_at).toBeNull();

    const earningsEvents = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM higgles_earnings_events WHERE builder_id = ? AND amount_cents = ?',
    ).bind(seller.builderId, hold.amount_cents).first();
    expect(earningsEvents.count).toBeGreaterThan(0);
  });

  it('revokes rather than credits a past-due hold whose purchase has since been refunded', async () => {
    const seller = await setUpSeller('release-sweep-refunded', 1000);
    for (let i = 0; i < MIN_ESTABLISHED_COUNTERPARTIES; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const buyer = await signupAdmin(`release-sweep-refunded-history-${i}`);
      // eslint-disable-next-line no-await-in-loop
      await purchase('release-sweep-refunded-instance', buyer);
    }
    await createTemplate('release-sweep-refunded-big-template', 100000);
    await placeInstance('release-sweep-refunded-big-instance', 'release-sweep-refunded-landlet', 'release-sweep-refunded-big-template', seller);
    const bigBuyer = await signupAdmin('release-sweep-refunded-big-buyer');
    const bigPurchase = await purchase('release-sweep-refunded-big-instance', bigBuyer);
    const hold = await env.DB.prepare('SELECT * FROM commission_holds WHERE purchase_id = ?').bind(bigPurchase.purchaseId).first();

    // Directly mark the purchase refunded (bypassing clawBackPurchaseCommission's
    // own revoke, to isolate the sweep's own defensive re-check) and force
    // the hold due, then run the sweep.
    await env.DB.prepare('UPDATE purchases SET refunded_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\', \'now\') WHERE purchase_id = ?')
      .bind(bigPurchase.purchaseId).run();
    await env.DB.prepare('UPDATE commission_holds SET release_at = \'2000-01-01T00:00:00.000Z\' WHERE hold_id = ?').bind(hold.hold_id).run();
    const beforeSweepBalance = (await builderRow(seller.builderId)).higgles_balance_cents;

    await releaseDueCommissionHolds(env.DB);

    expect((await builderRow(seller.builderId)).higgles_balance_cents).toBe(beforeSweepBalance);
    const afterSweepHold = await env.DB.prepare('SELECT released_at, revoked_at FROM commission_holds WHERE hold_id = ?').bind(hold.hold_id).first();
    expect(afterSweepHold.released_at).toBeNull();
    expect(afterSweepHold.revoked_at).not.toBeNull();
  });
});

// #2880: commission_holds.builder_id used to CASCADE on the host builder's
// own self-delete, silently destroying the record of an active hold's
// escrowed money -- same real-money gap migrations/0062/0086 already fixed
// for purchases.builder_id/higgles_redemptions.builder_id. migrations/
// 0165_commission_holds_builder_id_set_null.sql switches it to SET NULL
// instead; what should actually happen to a null-builder hold's money on
// release is a genuine owner-judgment call, not decided here -- these
// tests only confirm the record survives and the sweep stays safe, not
// what it eventually does with the money.
describe('Builder self-delete while holding an active commission_holds row (#2880)', () => {
  it('keeps the hold record (with a nulled builderId) instead of destroying it', async () => {
    const seller = await setUpSeller('self-delete-active-hold', 1000);
    for (let i = 0; i < MIN_ESTABLISHED_COUNTERPARTIES; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const buyer = await signupAdmin(`self-delete-active-hold-history-${i}`);
      // eslint-disable-next-line no-await-in-loop
      await purchase('self-delete-active-hold-instance', buyer);
    }
    await createTemplate('self-delete-active-hold-big-template', 100000);
    await placeInstance('self-delete-active-hold-big-instance', 'self-delete-active-hold-landlet', 'self-delete-active-hold-big-template', seller);
    const bigBuyer = await signupAdmin('self-delete-active-hold-big-buyer');
    const bigPurchase = await purchase('self-delete-active-hold-big-instance', bigBuyer);
    const hold = await env.DB.prepare('SELECT * FROM commission_holds WHERE purchase_id = ?').bind(bigPurchase.purchaseId).first();
    expect(hold).toBeTruthy(); // confirms a hold really was created

    const deleted = await api(`/builders/${seller.builderId}`, seller.session({ method: 'DELETE' }));
    expect(deleted.response.status).toBe(200);

    const holdAfterDelete = await env.DB.prepare('SELECT * FROM commission_holds WHERE hold_id = ?').bind(hold.hold_id).first();
    expect(holdAfterDelete).toBeTruthy(); // not CASCADE-deleted along with the builder
    expect(holdAfterDelete.builder_id).toBeNull();
    expect(holdAfterDelete.amount_cents).toBe(hold.amount_cents);
    expect(holdAfterDelete.released_at).toBeNull();
    expect(holdAfterDelete.revoked_at).toBeNull();
  });

  it('leaves a null-builder hold untouched (neither released nor revoked) once due, instead of crashing the sweep', async () => {
    const seller = await setUpSeller('self-delete-due-hold', 1000);
    for (let i = 0; i < MIN_ESTABLISHED_COUNTERPARTIES; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const buyer = await signupAdmin(`self-delete-due-hold-history-${i}`);
      // eslint-disable-next-line no-await-in-loop
      await purchase('self-delete-due-hold-instance', buyer);
    }
    await createTemplate('self-delete-due-hold-big-template', 100000);
    await placeInstance('self-delete-due-hold-big-instance', 'self-delete-due-hold-landlet', 'self-delete-due-hold-big-template', seller);
    const bigBuyer = await signupAdmin('self-delete-due-hold-big-buyer');
    const bigPurchase = await purchase('self-delete-due-hold-big-instance', bigBuyer);
    const hold = await env.DB.prepare('SELECT * FROM commission_holds WHERE purchase_id = ?').bind(bigPurchase.purchaseId).first();

    const deleted = await api(`/builders/${seller.builderId}`, seller.session({ method: 'DELETE' }));
    expect(deleted.response.status).toBe(200);

    // Force it due, same as the ordinary cron-sweep tests above.
    await env.DB.prepare('UPDATE commission_holds SET release_at = \'2000-01-01T00:00:00.000Z\' WHERE hold_id = ?').bind(hold.hold_id).run();

    // Must not throw -- a null builder_id would otherwise violate
    // higgles_earnings_events.builder_id's own NOT NULL constraint.
    await expect(releaseDueCommissionHolds(env.DB)).resolves.toBeUndefined();

    // released_at staying null (not just "no throw") is the real
    // confirmation nothing got credited -- releaseOrRevokeHold's own
    // credit/ledger-insert/released_at-set happen together in one batch,
    // so a null released_at here means that batch never ran at all for
    // this hold.
    const holdAfterSweep = await env.DB.prepare('SELECT released_at, revoked_at, builder_id FROM commission_holds WHERE hold_id = ?').bind(hold.hold_id).first();
    expect(holdAfterSweep.builder_id).toBeNull();
    expect(holdAfterSweep.released_at).toBeNull();
    expect(holdAfterSweep.revoked_at).toBeNull();
  });
});
