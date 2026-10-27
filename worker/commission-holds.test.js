// #1109 (owner decision, 2026-10-27): velocity-based limits on commission
// cash outs. Covers the two cap shapes (established per-sale multiplier,
// new-builder cumulative flat cap), the escrow hold they create,
// clawBackPurchaseCommission's interaction with an active hold on refund,
// and releaseDueCommissionHolds' own cron sweep. See migrations/
// 0160_commission_holds.sql and worker/lib/commission-caps.js for the
// full mechanism.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { releaseDueCommissionHolds, MIN_ESTABLISHED_COUNTERPARTIES, NEW_BUILDER_FLAT_CAP_CENTS, ESTABLISHED_CAP_MULTIPLIER } from './lib/commission-caps.js';
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
