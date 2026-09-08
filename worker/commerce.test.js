import {
  applyD1Migrations, env, SELF, createExecutionContext, createScheduledController, waitOnExecutionContext,
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

describe('Auctions', () => {
  async function claim(landletId, builder) {
    return api(`/landlets/${landletId}/claim`, builder.session({ method: 'POST' }));
  }

  it('only lets the current owner start an auction on their own claimed landlet', async () => {
    const owner = await signupBuilder('auction-owner');
    const stranger = await signupBuilder('auction-stranger');
    await createGreenbeltLandlet('auction-ownership-landlet');
    await claim('auction-ownership-landlet', owner);

    const byStranger = await api('/landlets/auction-ownership-landlet/auction', stranger.session({ method: 'POST', body: JSON.stringify({}) }));
    expect(byStranger.response.status).toBe(400);

    const onUnclaimed = await api('/landlets/does-not-exist/auction', owner.session({ method: 'POST', body: JSON.stringify({}) }));
    expect(onUnclaimed.response.status).toBe(404);

    const started = await api('/landlets/auction-ownership-landlet/auction', owner.session({ method: 'POST', body: JSON.stringify({}) }));
    expect(started.response.status).toBe(201);
    expect(started.body.auction).toMatchObject({
      landletId: 'auction-ownership-landlet',
      sellerBuilderId: owner.builderId,
      startingBidCents: 0,
      status: 'active',
      highestBidCents: null,
      bidCount: 0,
    });

    const secondAttempt = await api('/landlets/auction-ownership-landlet/auction', owner.session({ method: 'POST', body: JSON.stringify({}) }));
    expect(secondAttempt.response.status).toBe(409);
  });

  it('accepts only one of two concurrent auction-start requests for the same landlet, not both', async () => {
    const owner = await signupBuilder('auction-start-race-owner');
    await createGreenbeltLandlet('auction-start-race-landlet');
    await claim('auction-start-race-landlet', owner);

    // Fired together, not awaited one at a time — a read-then-insert
    // implementation could let both requests read "no active auction yet",
    // both pass the check, and both land as separate active auctions on
    // the same landlet, which would later each independently resolve and
    // double-transfer the same land (#265).
    const [first, second] = await Promise.all([
      api('/landlets/auction-start-race-landlet/auction', owner.session({ method: 'POST', body: JSON.stringify({}) })),
      api('/landlets/auction-start-race-landlet/auction', owner.session({ method: 'POST', body: JSON.stringify({}) })),
    ]);
    expect([first.response.status, second.response.status].sort()).toEqual([201, 409]);
  });

  it('accepts a custom starting bid and duration', async () => {
    const owner = await signupBuilder('custom-auction-owner');
    await createGreenbeltLandlet('auction-custom-landlet');
    await claim('auction-custom-landlet', owner);

    const started = await api('/landlets/auction-custom-landlet/auction', owner.session({
      method: 'POST', body: JSON.stringify({ startingBidCents: 500, durationHours: 1 }),
    }));
    expect(started.response.status).toBe(201);
    expect(started.body.auction.startingBidCents).toBe(500);
    const endsAt = new Date(started.body.auction.endsAt).getTime();
    const createdAt = new Date(started.body.auction.createdAt).getTime();
    expect(endsAt - createdAt).toBeGreaterThan(59 * 60 * 1000);
    expect(endsAt - createdAt).toBeLessThan(61 * 60 * 1000);
  });

  // Found via backlog audit (#318): startingBidCents/amountCents had no
  // upper bound and used Number.isInteger rather than Number.isSafeInteger,
  // letting a value past MAX_MONEY_CENTS (or past safe-integer range
  // entirely) through to a persisted balance/ledger.
  it('rejects a startingBidCents or amountCents over the money-field cap, and a non-safe-integer value', async () => {
    const owner = await signupBuilder('bid-cap-owner');
    const bidder = await signupBuilder('bid-cap-bidder');
    await createGreenbeltLandlet('auction-bid-cap-landlet');
    await claim('auction-bid-cap-landlet', owner);

    const overCap = await api('/landlets/auction-bid-cap-landlet/auction', owner.session({
      method: 'POST', body: JSON.stringify({ startingBidCents: 100_000_001 }),
    }));
    expect(overCap.response.status).toBe(400);

    const notSafe = await api('/landlets/auction-bid-cap-landlet/auction', owner.session({
      method: 'POST', body: JSON.stringify({ startingBidCents: Number.MAX_SAFE_INTEGER + 1 }),
    }));
    expect(notSafe.response.status).toBe(400);

    const started = await api('/landlets/auction-bid-cap-landlet/auction', owner.session({
      method: 'POST', body: JSON.stringify({ startingBidCents: 100_000_000 }),
    }));
    expect(started.response.status).toBe(201);
    const auctionId = started.body.auction.auctionId;

    const bidOverCap = await api(`/auctions/${auctionId}/bids`, bidder.session({
      method: 'POST', body: JSON.stringify({ amountCents: 100_000_001 }),
    }));
    expect(bidOverCap.response.status).toBe(400);

    const bidAtCap = await api(`/auctions/${auctionId}/bids`, bidder.session({
      method: 'POST', body: JSON.stringify({ amountCents: 100_000_000 }),
    }));
    expect(bidAtCap.response.status).toBe(201);
  });

  it('enforces increasing bids and rejects the seller bidding on their own auction', async () => {
    const owner = await signupBuilder('bid-rules-owner');
    const bidderA = await signupBuilder('bidder-a');
    const bidderB = await signupBuilder('bidder-b');
    await createGreenbeltLandlet('auction-bid-rules-landlet');
    await claim('auction-bid-rules-landlet', owner);
    const started = await api('/landlets/auction-bid-rules-landlet/auction', owner.session({
      method: 'POST', body: JSON.stringify({ startingBidCents: 1000 }),
    }));
    const auctionId = started.body.auction.auctionId;

    const sellerBid = await api(`/auctions/${auctionId}/bids`, owner.session({
      method: 'POST', body: JSON.stringify({ amountCents: 2000 }),
    }));
    expect(sellerBid.response.status).toBe(400);

    const tooLow = await api(`/auctions/${auctionId}/bids`, bidderA.session({
      method: 'POST', body: JSON.stringify({ amountCents: 500 }),
    }));
    expect(tooLow.response.status).toBe(400);

    const firstBid = await api(`/auctions/${auctionId}/bids`, bidderA.session({
      method: 'POST', body: JSON.stringify({ amountCents: 1000 }),
    }));
    expect(firstBid.response.status).toBe(201);

    const notHigherEnough = await api(`/auctions/${auctionId}/bids`, bidderB.session({
      method: 'POST', body: JSON.stringify({ amountCents: 1000 }),
    }));
    expect(notHigherEnough.response.status).toBe(400);

    const secondBid = await api(`/auctions/${auctionId}/bids`, bidderB.session({
      method: 'POST', body: JSON.stringify({ amountCents: 1500 }),
    }));
    expect(secondBid.response.status).toBe(201);

    const fetched = await api(`/auctions/${auctionId}`);
    expect(fetched.body.auction.highestBidCents).toBe(1500);
    expect(fetched.body.auction.bidCount).toBe(2);

    const bids = await api(`/auctions/${auctionId}/bids`);
    expect(bids.body.bids.map((b) => b.amountCents)).toEqual([1500, 1000]);
  });

  it('accepts only one of two concurrent bids for the same amount, not both', async () => {
    const owner = await signupBuilder('bid-race-owner');
    const bidderA = await signupBuilder('bid-race-a');
    const bidderB = await signupBuilder('bid-race-b');
    await createGreenbeltLandlet('auction-bid-race-landlet');
    await claim('auction-bid-race-landlet', owner);
    const started = await api('/landlets/auction-bid-race-landlet/auction', owner.session({
      method: 'POST', body: JSON.stringify({ startingBidCents: 1000 }),
    }));
    const auctionId = started.body.auction.auctionId;

    // Fired together, not awaited one at a time — a read-then-insert
    // implementation could let both requests read "no bids yet", both pass
    // validation against startingBidCents, and both land, even though only
    // the first bid to actually insert should win a tie.
    const [first, second] = await Promise.all([
      api(`/auctions/${auctionId}/bids`, bidderA.session({
        method: 'POST', body: JSON.stringify({ amountCents: 1000 }),
      })),
      api(`/auctions/${auctionId}/bids`, bidderB.session({
        method: 'POST', body: JSON.stringify({ amountCents: 1000 }),
      })),
    ]);
    expect([first.response.status, second.response.status].sort()).toEqual([201, 400]);

    const bids = await api(`/auctions/${auctionId}/bids`);
    expect(bids.body.bids).toHaveLength(1);
    expect(bids.body.bids[0].amountCents).toBe(1000);
  });

  it('resolves a winning auction: ownership transfers, build clears, seller is paid in higgles', async () => {
    const owner = await signupBuilder('resolve-winner-owner');
    const bidder = await signupBuilder('resolve-winner-bidder');
    await createGreenbeltLandlet('auction-resolve-win-landlet');
    await claim('auction-resolve-win-landlet', owner);
    await api('/instances', owner.session({
      method: 'POST',
      body: JSON.stringify({ landletId: 'auction-resolve-win-landlet', templateId: 'placeholder-tree', x: 1, y: 1 }),
    }));
    const started = await api('/landlets/auction-resolve-win-landlet/auction', owner.session({
      method: 'POST', body: JSON.stringify({ startingBidCents: 0 }),
    }));
    const auctionId = started.body.auction.auctionId;
    await api(`/auctions/${auctionId}/bids`, bidder.session({
      method: 'POST', body: JSON.stringify({ amountCents: 2500 }),
    }));

    // Force it into the past directly via the DB, the same test-only
    // escape hatch used elsewhere in this file, rather than waiting a real
    // hour or mocking Date globally.
    await env.DB.prepare(`UPDATE auctions SET ends_at = '2000-01-01T00:00:00.000Z' WHERE auction_id = ?`).bind(auctionId).run();

    const resolved = await api(`/auctions/${auctionId}/resolve`, { method: 'POST' });
    expect(resolved.response.status).toBe(200);
    expect(resolved.body.auction.status).toBe('ended');
    expect(resolved.body.auction.winningBidId).not.toBeNull();

    const landlet = await api('/landlets/auction-resolve-win-landlet');
    expect(landlet.body.landlet.ownerBuilderId).toBe(bidder.builderId);
    expect(landlet.body.landlet.status).toBe('claimed');
    expect(landlet.body.landlet.activeVersionId).toBeNull();

    const instances = await api('/instances?landletId=auction-resolve-win-landlet');
    expect(instances.body.instances).toEqual([]);

    const builders = await api('/builders');
    const sellerAfter = builders.body.builders.find((b) => b.builderId === owner.builderId);
    expect(sellerAfter.higglesBalanceCents).toBe(2500);

    const sellerNotices = await api('/notifications', owner.session());
    expect(sellerNotices.body.notifications.some((n) => n.message.includes('sold for $25.00'))).toBe(true);
    const bidderNotices = await api('/notifications', bidder.session());
    expect(bidderNotices.body.notifications.some((n) => n.message.includes('You won the auction'))).toBe(true);

    // Resolving again is a harmless no-op, not an error — it just returns
    // the already-ended auction's current (unchanged) state, and must not
    // re-run the money-mutating side effects (double-crediting the
    // seller's balance — #229) even though nothing here is a real
    // concurrent race. The 409 case is specifically "not due yet,"
    // covered by the next test.
    const resolveAgain = await api(`/auctions/${auctionId}/resolve`, { method: 'POST' });
    expect(resolveAgain.response.status).toBe(200);
    expect(resolveAgain.body.auction.winningBidId).toBe(resolved.body.auction.winningBidId);
    const buildersAfterSecondResolve = await api('/builders');
    const sellerAfterSecondResolve = buildersAfterSecondResolve.body.builders.find((b) => b.builderId === owner.builderId);
    expect(sellerAfterSecondResolve.higglesBalanceCents).toBe(2500);
    const earningsCount = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM higgles_earnings_events WHERE builder_id = ?',
    ).bind(owner.builderId).first();
    expect(earningsCount.n).toBe(1);
  });

  // #415: a draft save's ownership check (at the top of the handler) and
  // its actual write (a batch several awaits later) used to straddle a
  // resolving auction's own ownership-transfer-and-wipe batch, the same
  // shape of race #391/#392 already closed for plain PUT/PATCH — letting
  // the old owner's stale draft resurrect on the landlet under its new
  // owner. Fired together (not awaited one at a time) so a real interleave
  // is possible, the same idiom as the claim-vs-PATCH/DELETE races above.
  it('does not let a concurrent draft save resurrect the old owner\'s content once an auction transfers the landlet', async () => {
    const owner = await signupBuilder('draft-resolve-race-owner');
    const bidder = await signupBuilder('draft-resolve-race-bidder');
    await createGreenbeltLandlet('draft-resolve-race-landlet');
    await claim('draft-resolve-race-landlet', owner);
    const started = await api('/landlets/draft-resolve-race-landlet/auction', owner.session({
      method: 'POST', body: JSON.stringify({ startingBidCents: 0 }),
    }));
    const auctionId = started.body.auction.auctionId;
    await api(`/auctions/${auctionId}/bids`, bidder.session({
      method: 'POST', body: JSON.stringify({ amountCents: 1500 }),
    }));
    await env.DB.prepare(`UPDATE auctions SET ends_at = '2000-01-01T00:00:00.000Z' WHERE auction_id = ?`).bind(auctionId).run();

    const [drafted] = await Promise.all([
      api('/landlets/draft-resolve-race-landlet/draft', owner.session({
        method: 'PUT',
        body: JSON.stringify({
          instances: [{ instanceId: 'draft-resolve-race-instance', templateId: 'placeholder-tree', x: 1, y: 1 }],
        }),
      })),
      api(`/auctions/${auctionId}/resolve`, { method: 'POST' }),
    ]);
    // Whichever ran first, both landing 200 is impossible — the loser's
    // write is guarded out with a 409 (the draft's own atomic write-time
    // guard), or, if the transfer commits before this PUT's own
    // requireLandlet() read even resolves, a 403 (its assertOwner check,
    // using that now-already-stale-relative-to-the-transfer read, correctly
    // sees the new owner and rejects — same root cause #455 already fixed
    // for the sibling "concurrent version save" race just below this one,
    // just never ported to this test's own accepted-outcomes list).
    expect([200, 403, 409]).toContain(drafted.response.status);

    const landlet = await api('/landlets/draft-resolve-race-landlet');
    expect(landlet.body.landlet.ownerBuilderId).toBe(bidder.builderId);
    // The transfer's clean-slate guarantee holds either way: the draft
    // save's own guard rejected it if resolve ran first, and resolve's own
    // wipe removed it if the draft save ran first — never both landing
    // such that the old owner's content survives under the new owner.
    const instances = await api('/instances?landletId=draft-resolve-race-landlet');
    expect(instances.body.instances).toEqual([]);
  });

  // #415: same shape of race as the draft-save one above, for the version-
  // create endpoint's own ownership-checked-then-later-written batch.
  it('does not let a concurrent version save land once an auction transfers the landlet', async () => {
    const owner = await signupBuilder('version-resolve-race-owner');
    const bidder = await signupBuilder('version-resolve-race-bidder');
    await createGreenbeltLandlet('version-resolve-race-landlet');
    await claim('version-resolve-race-landlet', owner);
    const started = await api('/landlets/version-resolve-race-landlet/auction', owner.session({
      method: 'POST', body: JSON.stringify({ startingBidCents: 0 }),
    }));
    const auctionId = started.body.auction.auctionId;
    await api(`/auctions/${auctionId}/bids`, bidder.session({
      method: 'POST', body: JSON.stringify({ amountCents: 1500 }),
    }));
    await env.DB.prepare(`UPDATE auctions SET ends_at = '2000-01-01T00:00:00.000Z' WHERE auction_id = ?`).bind(auctionId).run();

    const [versioned] = await Promise.all([
      api('/landlets/version-resolve-race-landlet/versions', owner.session({
        method: 'POST', body: JSON.stringify({ name: 'Race version' }),
      })),
      api(`/auctions/${auctionId}/resolve`, { method: 'POST' }),
    ]);
    // #455: handleLandletVersions' POST does an early assertOwner check
    // (using the landlet fetched just before it) ahead of its own atomic
    // write. If the transfer commits before that fetch resolves, the check
    // correctly sees the new owner and rejects with 403 — a legitimate
    // race outcome distinct from 409 (the write-time atomic-guard
    // rejection for a transfer landing in the narrower window between the
    // check and the write, which #415 already closes).
    expect([201, 403, 409]).toContain(versioned.response.status);

    // resolveAuction wipes landlet_versions on a real transfer regardless
    // of ordering, so this must read empty either way: if the version save
    // won the race it gets wiped right after; if it lost, its own guard
    // already rejected it.
    const versions = await api('/landlets/version-resolve-race-landlet/versions');
    expect(versions.body.versions).toEqual([]);
  });

  // #415: same shape again, for the activate endpoint — resolveAuction
  // always resets active_version_id to NULL on a real transfer, so a
  // concurrent activate must never leave it pointing at a version from
  // before the transfer.
  it('does not let a concurrent activate leave a stale active version pointer once an auction transfers the landlet', async () => {
    const owner = await signupBuilder('activate-resolve-race-owner');
    const bidder = await signupBuilder('activate-resolve-race-bidder');
    await createGreenbeltLandlet('activate-resolve-race-landlet');
    await claim('activate-resolve-race-landlet', owner);
    const versioned = await api('/landlets/activate-resolve-race-landlet/versions', owner.session({
      method: 'POST', body: JSON.stringify({ name: 'Pre-race version' }),
    }));
    const versionId = versioned.body.version.versionId;
    const started = await api('/landlets/activate-resolve-race-landlet/auction', owner.session({
      method: 'POST', body: JSON.stringify({ startingBidCents: 0 }),
    }));
    const auctionId = started.body.auction.auctionId;
    await api(`/auctions/${auctionId}/bids`, bidder.session({
      method: 'POST', body: JSON.stringify({ amountCents: 1500 }),
    }));
    await env.DB.prepare(`UPDATE auctions SET ends_at = '2000-01-01T00:00:00.000Z' WHERE auction_id = ?`).bind(auctionId).run();

    const [activated] = await Promise.all([
      api(`/landlets/activate-resolve-race-landlet/versions/${versionId}/activate`, owner.session({ method: 'POST' })),
      api(`/auctions/${auctionId}/resolve`, { method: 'POST' }),
    ]);
    // 404 is also legitimate here, independent of the ownership guard
    // itself: activate's own getVersion existence check can race against
    // resolveAuction's DELETE FROM landlet_versions and lose, the version
    // it was about to activate having genuinely ceased to exist by then.
    // 403 is legitimate too (same root cause #455 already fixed for the
    // sibling "concurrent version save" test above, just never ported
    // here): if the transfer commits before this endpoint's own
    // requireLandlet() read resolves, its assertOwner check correctly
    // sees the new owner and rejects, ahead of ever reaching the
    // write-time guard that would otherwise produce 409.
    expect([200, 403, 404, 409]).toContain(activated.response.status);

    const landlet = await api('/landlets/activate-resolve-race-landlet');
    expect(landlet.body.landlet.ownerBuilderId).toBe(bidder.builderId);
    expect(landlet.body.landlet.activeVersionId).toBeNull();
  });

  // #456: same race shape as the draft/version/activate tests above, for
  // the plain instance-create endpoint — it had no atomic ownership guard
  // at all before this fix (unlike those three, which #415 already closed).
  it('does not let a concurrent instance create land once an auction transfers the landlet', async () => {
    const owner = await signupBuilder('instance-create-resolve-race-owner');
    const bidder = await signupBuilder('instance-create-resolve-race-bidder');
    await createGreenbeltLandlet('instance-create-resolve-race-landlet');
    await claim('instance-create-resolve-race-landlet', owner);
    const started = await api('/landlets/instance-create-resolve-race-landlet/auction', owner.session({
      method: 'POST', body: JSON.stringify({ startingBidCents: 0 }),
    }));
    const auctionId = started.body.auction.auctionId;
    await api(`/auctions/${auctionId}/bids`, bidder.session({
      method: 'POST', body: JSON.stringify({ amountCents: 1500 }),
    }));
    await env.DB.prepare(`UPDATE auctions SET ends_at = '2000-01-01T00:00:00.000Z' WHERE auction_id = ?`).bind(auctionId).run();

    const [created] = await Promise.all([
      api('/instances', owner.session({
        method: 'POST',
        body: JSON.stringify({ instanceId: 'instance-create-resolve-race-instance', landletId: 'instance-create-resolve-race-landlet', templateId: 'placeholder-tree', x: 1, y: 1 }),
      })),
      api(`/auctions/${auctionId}/resolve`, { method: 'POST' }),
    ]);
    // 403 is also legitimate here (same shape as #455): the endpoint's own
    // early requireOwnedLandlet check can itself lose the race and see the
    // new owner already in place, ahead of ever reaching the write-time
    // guard this fix adds (which is what produces 409 instead).
    expect([201, 403, 409]).toContain(created.response.status);

    const landlet = await api('/landlets/instance-create-resolve-race-landlet');
    expect(landlet.body.landlet.ownerBuilderId).toBe(bidder.builderId);
    // Whichever ran first: the create's own guard rejected it if resolve
    // won, or resolve's unconditional wipe removed it right after if the
    // create won — the old owner's instance never survives under the new
    // owner either way.
    const instances = await api('/instances?landletId=instance-create-resolve-race-landlet');
    expect(instances.body.instances).toEqual([]);
  });

  // #456: same race shape, for the batch create/replace endpoint.
  it('does not let a concurrent batch instance create land once an auction transfers the landlet', async () => {
    const owner = await signupBuilder('instance-batch-resolve-race-owner');
    const bidder = await signupBuilder('instance-batch-resolve-race-bidder');
    await createGreenbeltLandlet('instance-batch-resolve-race-landlet');
    await claim('instance-batch-resolve-race-landlet', owner);
    const started = await api('/landlets/instance-batch-resolve-race-landlet/auction', owner.session({
      method: 'POST', body: JSON.stringify({ startingBidCents: 0 }),
    }));
    const auctionId = started.body.auction.auctionId;
    await api(`/auctions/${auctionId}/bids`, bidder.session({
      method: 'POST', body: JSON.stringify({ amountCents: 1500 }),
    }));
    await env.DB.prepare(`UPDATE auctions SET ends_at = '2000-01-01T00:00:00.000Z' WHERE auction_id = ?`).bind(auctionId).run();

    const [created] = await Promise.all([
      api('/instances/batch', owner.session({
        method: 'POST',
        body: JSON.stringify({
          instances: [{ instanceId: 'instance-batch-resolve-race-instance', landletId: 'instance-batch-resolve-race-landlet', templateId: 'placeholder-tree', x: 1, y: 1 }],
        }),
      })),
      api(`/auctions/${auctionId}/resolve`, { method: 'POST' }),
    ]);
    // 403 is also legitimate here — same reasoning as the single-create
    // test above (requireOwnedLandlets' own early check can itself lose
    // the race).
    expect([201, 403, 409]).toContain(created.response.status);

    const landlet = await api('/landlets/instance-batch-resolve-race-landlet');
    expect(landlet.body.landlet.ownerBuilderId).toBe(bidder.builderId);
    const instances = await api('/instances?landletId=instance-batch-resolve-race-landlet');
    expect(instances.body.instances).toEqual([]);
  });

  // #456: same race shape, for the single instance update endpoint —
  // places an instance first (before the race) so there's something to
  // update; resolveAuction's own wipe means the row can already be gone by
  // the time the update's initial existence check runs, hence the extra
  // legitimate 404 outcome (mirroring the activate test's own 404 case
  // above, for the same "existence check itself lost the race" reason),
  // and the endpoint's own early requireOwnedLandlet check can likewise
  // lose the race and see the new owner already in place (403, same
  // reasoning as the create tests above).
  it('does not let a concurrent instance update land once an auction transfers the landlet', async () => {
    const owner = await signupBuilder('instance-update-resolve-race-owner');
    const bidder = await signupBuilder('instance-update-resolve-race-bidder');
    await createGreenbeltLandlet('instance-update-resolve-race-landlet');
    await claim('instance-update-resolve-race-landlet', owner);
    await api('/instances', owner.session({
      method: 'POST',
      body: JSON.stringify({ instanceId: 'instance-update-resolve-race-instance', landletId: 'instance-update-resolve-race-landlet', templateId: 'placeholder-tree', x: 1, y: 1 }),
    }));
    const started = await api('/landlets/instance-update-resolve-race-landlet/auction', owner.session({
      method: 'POST', body: JSON.stringify({ startingBidCents: 0 }),
    }));
    const auctionId = started.body.auction.auctionId;
    await api(`/auctions/${auctionId}/bids`, bidder.session({
      method: 'POST', body: JSON.stringify({ amountCents: 1500 }),
    }));
    await env.DB.prepare(`UPDATE auctions SET ends_at = '2000-01-01T00:00:00.000Z' WHERE auction_id = ?`).bind(auctionId).run();

    const [updated] = await Promise.all([
      api('/instances/instance-update-resolve-race-instance', owner.session({
        method: 'PATCH',
        body: JSON.stringify({ x: 5, y: 5 }),
      })),
      api(`/auctions/${auctionId}/resolve`, { method: 'POST' }),
    ]);
    expect([200, 403, 404, 409]).toContain(updated.response.status);

    const landlet = await api('/landlets/instance-update-resolve-race-landlet');
    expect(landlet.body.landlet.ownerBuilderId).toBe(bidder.builderId);
    const instances = await api('/instances?landletId=instance-update-resolve-race-landlet');
    expect(instances.body.instances).toEqual([]);
  });

  it('resolves a winning auction even when the bidder already owns a claimed landlet, without poisoning the list endpoint', async () => {
    const owner = await signupBuilder('resolve-existing-owner-owner');
    const bidder = await signupBuilder('resolve-existing-owner-bidder');
    await createGreenbeltLandlet('auction-bidder-own-landlet');
    await claim('auction-bidder-own-landlet', bidder);
    await createGreenbeltLandlet('auction-resolve-existing-owner-landlet');
    await claim('auction-resolve-existing-owner-landlet', owner);
    const started = await api('/landlets/auction-resolve-existing-owner-landlet/auction', owner.session({
      method: 'POST', body: JSON.stringify({ startingBidCents: 0 }),
    }));
    const auctionId = started.body.auction.auctionId;
    await api(`/auctions/${auctionId}/bids`, bidder.session({
      method: 'POST', body: JSON.stringify({ amountCents: 500 }),
    }));
    await env.DB.prepare(`UPDATE auctions SET ends_at = '2000-01-01T00:00:00.000Z' WHERE auction_id = ?`).bind(auctionId).run();

    // GET /api/auctions resolves due auctions before listing (resolveDueAuctions)
    // — this is the exact path that used to 409 for everyone once a single
    // stuck auction like this one hit the UNIQUE constraint.
    const list = await api('/auctions');
    expect(list.response.status).toBe(200);

    const landlet = await api('/landlets/auction-resolve-existing-owner-landlet');
    expect(landlet.body.landlet.ownerBuilderId).toBe(bidder.builderId);
    expect(landlet.body.landlet.status).toBe('claimed');

    // The bidder's own earlier landlet is untouched — they now own both.
    const stillOwned = await api('/landlets/auction-bidder-own-landlet');
    expect(stillOwned.body.landlet.ownerBuilderId).toBe(bidder.builderId);
    expect(stillOwned.body.landlet.status).toBe('claimed');
  });

  it('rejects resolving an auction that is not due yet', async () => {
    const owner = await signupBuilder('not-due-owner');
    await createGreenbeltLandlet('auction-not-due-landlet');
    await claim('auction-not-due-landlet', owner);
    const started = await api('/landlets/auction-not-due-landlet/auction', owner.session({
      method: 'POST', body: JSON.stringify({ durationHours: 24 }),
    }));
    const notDue = await api(`/auctions/${started.body.auction.auctionId}/resolve`, { method: 'POST' });
    expect(notDue.response.status).toBe(409);
  });

  it('releases an unsold $0-starting-bid auction to greenbelt', async () => {
    const owner = await signupBuilder('relinquish-owner');
    await createGreenbeltLandlet('auction-relinquish-landlet');
    await claim('auction-relinquish-landlet', owner);
    const started = await api('/landlets/auction-relinquish-landlet/auction', owner.session({
      method: 'POST', body: JSON.stringify({ startingBidCents: 0, durationHours: 1 }),
    }));
    const auctionId = started.body.auction.auctionId;
    await env.DB.prepare(`UPDATE auctions SET ends_at = '2000-01-01T00:00:00.000Z' WHERE auction_id = ?`).bind(auctionId).run();

    const resolved = await api(`/auctions/${auctionId}/resolve`, { method: 'POST' });
    expect(resolved.response.status).toBe(200);
    expect(resolved.body.auction.status).toBe('ended');
    expect(resolved.body.auction.winningBidId).toBeNull();

    const landlet = await api('/landlets/auction-relinquish-landlet');
    expect(landlet.body.landlet.status).toBe('greenbelt');
    expect(landlet.body.landlet.ownerBuilderId).toBeNull();

    const notices = await api('/notifications', owner.session());
    expect(notices.body.notifications.some((n) => n.message.includes('released to greenbelt'))).toBe(true);
  });

  it('keeps an unsold reserved (>$0 starting bid) auction with its seller', async () => {
    const owner = await signupBuilder('reserved-owner');
    await createGreenbeltLandlet('auction-reserved-landlet');
    await claim('auction-reserved-landlet', owner);
    const started = await api('/landlets/auction-reserved-landlet/auction', owner.session({
      method: 'POST', body: JSON.stringify({ startingBidCents: 5000, durationHours: 1 }),
    }));
    const auctionId = started.body.auction.auctionId;
    await env.DB.prepare(`UPDATE auctions SET ends_at = '2000-01-01T00:00:00.000Z' WHERE auction_id = ?`).bind(auctionId).run();

    const resolved = await api(`/auctions/${auctionId}/resolve`, { method: 'POST' });
    expect(resolved.response.status).toBe(200);

    const landlet = await api('/landlets/auction-reserved-landlet');
    expect(landlet.body.landlet.status).toBe('claimed');
    expect(landlet.body.landlet.ownerBuilderId).toBe(owner.builderId);

    const notices = await api('/notifications', owner.session());
    expect(notices.body.notifications.some((n) => n.message.includes('you keep the land'))).toBe(true);
  });

  it('notifies the seller of each new bid and the previous highest bidder of being outbid', async () => {
    const owner = await signupBuilder('bid-notice-owner');
    const bidderA = await signupBuilder('bid-notice-bidder-a');
    const bidderB = await signupBuilder('bid-notice-bidder-b');
    await createGreenbeltLandlet('auction-bid-notice-landlet');
    await claim('auction-bid-notice-landlet', owner);
    const started = await api('/landlets/auction-bid-notice-landlet/auction', owner.session({
      method: 'POST', body: JSON.stringify({ startingBidCents: 1000 }),
    }));
    const auctionId = started.body.auction.auctionId;

    await api(`/auctions/${auctionId}/bids`, bidderA.session({
      method: 'POST', body: JSON.stringify({ amountCents: 1000 }),
    }));
    const ownerAfterFirstBid = await api('/notifications', owner.session());
    expect(ownerAfterFirstBid.body.notifications.some((n) => n.message.includes('New bid of $10.00'))).toBe(true);
    // No previous bidder to outbid yet.
    const bidderAAfterFirstBid = await api('/notifications', bidderA.session());
    expect(bidderAAfterFirstBid.body.notifications).toHaveLength(0);

    await api(`/auctions/${auctionId}/bids`, bidderB.session({
      method: 'POST', body: JSON.stringify({ amountCents: 1500 }),
    }));
    const ownerAfterSecondBid = await api('/notifications', owner.session());
    expect(ownerAfterSecondBid.body.notifications.filter((n) => n.message.includes('New bid'))).toHaveLength(2);
    const bidderANotified = await api('/notifications', bidderA.session());
    expect(bidderANotified.body.notifications.some((n) => n.message.includes('outbid') && n.message.includes('$15.00'))).toBe(true);
  });

  it('auto-resolves an expired auction when the list endpoint is read, without an explicit resolve call', async () => {
    const owner = await signupBuilder('auto-resolve-owner');
    await createGreenbeltLandlet('auction-auto-resolve-landlet');
    await claim('auction-auto-resolve-landlet', owner);
    const started = await api('/landlets/auction-auto-resolve-landlet/auction', owner.session({
      method: 'POST', body: JSON.stringify({ startingBidCents: 0, durationHours: 1 }),
    }));
    const auctionId = started.body.auction.auctionId;
    await env.DB.prepare(`UPDATE auctions SET ends_at = '2000-01-01T00:00:00.000Z' WHERE auction_id = ?`).bind(auctionId).run();

    const list = await api('/auctions?status=active');
    expect(list.body.auctions.some((a) => a.auctionId === auctionId)).toBe(false);

    const fetched = await api(`/auctions/${auctionId}`);
    expect(fetched.body.auction.status).toBe('ended');
  });

  it('rejects bids on an auction that has already ended', async () => {
    const owner = await signupBuilder('ended-bid-owner');
    const bidder = await signupBuilder('ended-bid-bidder');
    await createGreenbeltLandlet('auction-ended-bid-landlet');
    await claim('auction-ended-bid-landlet', owner);
    const started = await api('/landlets/auction-ended-bid-landlet/auction', owner.session({
      method: 'POST', body: JSON.stringify({ startingBidCents: 0, durationHours: 1 }),
    }));
    const auctionId = started.body.auction.auctionId;
    await env.DB.prepare(`UPDATE auctions SET ends_at = '2000-01-01T00:00:00.000Z' WHERE auction_id = ?`).bind(auctionId).run();

    const bid = await api(`/auctions/${auctionId}/bids`, bidder.session({
      method: 'POST', body: JSON.stringify({ amountCents: 100 }),
    }));
    expect(bid.response.status).toBe(409);
  });

  it('reports each auction\'s own highest bid and bid count on the list endpoint, not just on single-fetch', async () => {
    // Regression test for the list branch's N+1 fix (#35): batching the
    // highest-bid/bid-count lookup across the whole page must still land
    // each result on the correct auction, including one with zero bids
    // sitting alongside others that have some.
    // Two separate owners: a builder can only ever claim one landlet
    // through the normal claim flow (their one free starter landlet), so
    // seeding two auctions on one page needs two owners, not one owner
    // with two landlets.
    const ownerNoBids = await signupBuilder('list-bids-owner-a');
    const ownerTwoBids = await signupBuilder('list-bids-owner-b');
    const bidder = await signupBuilder('list-bids-bidder');
    await createGreenbeltLandlet('auction-list-bids-no-bids');
    await createGreenbeltLandlet('auction-list-bids-two-bids');
    await claim('auction-list-bids-no-bids', ownerNoBids);
    await claim('auction-list-bids-two-bids', ownerTwoBids);

    const noBids = await api('/landlets/auction-list-bids-no-bids/auction', ownerNoBids.session({ method: 'POST', body: JSON.stringify({}) }));
    const twoBids = await api('/landlets/auction-list-bids-two-bids/auction', ownerTwoBids.session({ method: 'POST', body: JSON.stringify({}) }));
    const twoBidsId = twoBids.body.auction.auctionId;
    await api(`/auctions/${twoBidsId}/bids`, bidder.session({ method: 'POST', body: JSON.stringify({ amountCents: 500 }) }));
    await api(`/auctions/${twoBidsId}/bids`, bidder.session({ method: 'POST', body: JSON.stringify({ amountCents: 900 }) }));

    const list = await api('/auctions?status=active');
    const noBidsListed = list.body.auctions.find((a) => a.auctionId === noBids.body.auction.auctionId);
    const twoBidsListed = list.body.auctions.find((a) => a.auctionId === twoBidsId);
    expect(noBidsListed).toMatchObject({ highestBidCents: null, bidCount: 0 });
    expect(twoBidsListed).toMatchObject({ highestBidCents: 900, bidCount: 2 });
  });

  it('caps how many due auctions one GET /auctions call resolves, making forward progress across repeated calls', async () => {
    // Regression test for AUCTION_SWEEP_LIMIT: resolveDueAuctions used to
    // sweep and resolve every active-but-expired auction unconditionally,
    // so a burst of simultaneously-expiring auctions would force one
    // public, unauthenticated GET into an unbounded chain of sequential
    // writes. Seeded directly via the DB (not through claim/start-auction,
    // which limit one builder to one claimed landlet) — cheap, exact, and
    // avoids needing AUCTION_SWEEP_LIMIT+ real signups just to prove a
    // bounded sweep. The landlets are left unowned (owner_builder_id NULL)
    // — migrations/0006's "one claimed landlet per builder" unique index
    // only applies once a landlet actually has an owner, and
    // resolveAuction's no-bid path (starting_bid_cents = 0, no bids) never
    // reads landlets.owner_builder_id, only auction.seller_builder_id.
    const seller = await signupBuilder('sweep-cap-seller');
    const total = 27; // > AUCTION_SWEEP_LIMIT (25), so one call can't clear it all
    const inserts = [];
    for (let i = 0; i < total; i++) {
      const landletId = `sweep-cap-landlet-${i}`;
      const auctionId = `sweep-cap-auction-${i}`;
      inserts.push(
        env.DB.prepare(`
          INSERT INTO landlets (landlet_id, name, status) VALUES (?, ?, 'claimed')
        `).bind(landletId, `Sweep cap ${i}`),
        env.DB.prepare(`
          INSERT INTO auctions (auction_id, landlet_id, seller_builder_id, starting_bid_cents, status, ends_at)
          VALUES (?, ?, ?, 0, 'active', '2000-01-01T00:00:00.000Z')
        `).bind(auctionId, landletId, seller.builderId),
      );
    }
    await env.DB.batch(inserts);

    const dueBefore = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM auctions WHERE status = 'active' AND ends_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    ).first();
    expect(dueBefore.count).toBe(total);

    await api('/auctions?status=active');
    const dueAfterFirstCall = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM auctions WHERE status = 'active' AND ends_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    ).first();
    // Some, but not all, resolved — proves the sweep is bounded rather than
    // exhaustive.
    expect(dueAfterFirstCall.count).toBeGreaterThan(0);
    expect(dueAfterFirstCall.count).toBeLessThan(total);

    await api('/auctions?status=active');
    const dueAfterSecondCall = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM auctions WHERE status = 'active' AND ends_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    ).first();
    // A second call clears the rest of the backlog rather than getting
    // stuck resolving the same subset forever.
    expect(dueAfterSecondCall.count).toBe(0);
  });

  it('frees a $0-starting-bid seller to claim another landlet immediately, before the auction resolves', async () => {
    const seller = await signupBuilder('release-zero-seller');
    await createGreenbeltLandlet('release-zero-landlet-a');
    await createGreenbeltLandlet('release-zero-landlet-b');
    await claim('release-zero-landlet-a', seller);

    // Before starting an auction, the ordinary one-claimed-landlet lock
    // still applies.
    const beforeAuction = await claim('release-zero-landlet-b', seller);
    expect(beforeAuction.response.status).toBe(409);

    await api('/landlets/release-zero-landlet-a/auction', seller.session({
      method: 'POST', body: JSON.stringify({ startingBidCents: 0 }),
    }));

    // Starting a $0 auction is itself the commitment to give the land up —
    // the lock frees immediately, with no bid needed and well before the
    // auction's own end time.
    const afterAuctionStart = await claim('release-zero-landlet-b', seller);
    expect(afterAuctionStart.response.status).toBe(200);

    // The original landlet is still nominally theirs (build/display
    // purposes) until the auction actually resolves.
    const original = await api('/landlets/release-zero-landlet-a');
    expect(original.body.landlet.ownerBuilderId).toBe(seller.builderId);
    expect(original.body.landlet.status).toBe('claimed');
  });

  it('frees a reserved-bid seller to claim another landlet only once the first bid lands', async () => {
    const seller = await signupBuilder('release-bid-seller');
    const bidder = await signupBuilder('release-bid-bidder');
    await createGreenbeltLandlet('release-bid-landlet-a');
    await createGreenbeltLandlet('release-bid-landlet-b');
    await claim('release-bid-landlet-a', seller);

    const started = await api('/landlets/release-bid-landlet-a/auction', seller.session({
      method: 'POST', body: JSON.stringify({ startingBidCents: 5000 }),
    }));
    const auctionId = started.body.auction.auctionId;

    // A reserved (non-$0) auction with no bids yet is not a commitment to
    // give the land up — still locked.
    const beforeBid = await claim('release-bid-landlet-b', seller);
    expect(beforeBid.response.status).toBe(409);

    await api(`/auctions/${auctionId}/bids`, bidder.session({
      method: 'POST', body: JSON.stringify({ amountCents: 5000 }),
    }));

    // The first bid guarantees the land eventually transfers, so the lock
    // frees now, not at resolution.
    const afterBid = await claim('release-bid-landlet-b', seller);
    expect(afterBid.response.status).toBe(200);
  });
});

describe('Inactivity-triggered auctions', () => {
  async function claim(landletId, builder) {
    return api(`/landlets/${landletId}/claim`, builder.session({ method: 'POST' }));
  }

  async function backdateLastActive(builderId, daysAgo) {
    const timestamp = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
    await env.DB.prepare('UPDATE builders SET last_active_at = ? WHERE builder_id = ?')
      .bind(timestamp, builderId).run();
  }

  async function runScheduled() {
    const controller = createScheduledController();
    const ctx = createExecutionContext();
    await worker.scheduled(controller, env, ctx);
    await waitOnExecutionContext(ctx);
  }

  async function activeAuctionFor(landletId) {
    return env.DB.prepare(
      "SELECT * FROM auctions WHERE landlet_id = ? AND status = 'active'",
    ).bind(landletId).first();
  }

  it('auto-starts a $0 auction on a claimed landlet whose owner has been inactive past 30 days', async () => {
    const owner = await signupBuilder('inactive-owner');
    await createGreenbeltLandlet('inactivity-landlet-a');
    await claim('inactivity-landlet-a', owner);
    await backdateLastActive(owner.builderId, 31);

    await runScheduled();

    const auction = await activeAuctionFor('inactivity-landlet-a');
    expect(auction).toBeTruthy();
    expect(auction.seller_builder_id).toBe(owner.builderId);
    expect(auction.starting_bid_cents).toBe(0);
  });

  it('does not auction a landlet whose owner has been active within 30 days', async () => {
    const owner = await signupBuilder('active-owner');
    await createGreenbeltLandlet('inactivity-landlet-b');
    await claim('inactivity-landlet-b', owner); // last_active_at bumped to "now" by the claim itself

    await runScheduled();

    expect(await activeAuctionFor('inactivity-landlet-b')).toBeNull();
  });

  it('does not auction a landlet whose owner has never had last_active_at tracked (NULL, not "long inactive")', async () => {
    const owner = await signupBuilder('never-tracked-owner');
    await createGreenbeltLandlet('inactivity-landlet-c');
    await claim('inactivity-landlet-c', owner);
    // Simulates a builder who existed before migrations/0067, or whose
    // profile has genuinely never been resolved since — NULL is supposed
    // to mean "not yet tracked," never "definitely inactive."
    await env.DB.prepare('UPDATE builders SET last_active_at = NULL WHERE builder_id = ?')
      .bind(owner.builderId).run();

    await runScheduled();

    expect(await activeAuctionFor('inactivity-landlet-c')).toBeNull();
  });

  it('does not start a second active auction on a landlet an inactive owner already voluntarily listed', async () => {
    const owner = await signupBuilder('already-listed-owner');
    await createGreenbeltLandlet('inactivity-landlet-d');
    await claim('inactivity-landlet-d', owner);
    const started = await api('/landlets/inactivity-landlet-d/auction', owner.session({
      method: 'POST', body: JSON.stringify({ startingBidCents: 500 }),
    }));
    expect(started.response.status).toBe(201);
    await backdateLastActive(owner.builderId, 31);

    await runScheduled();

    const auction = await activeAuctionFor('inactivity-landlet-d');
    expect(auction.auction_id).toBe(started.body.auction.auctionId);
    expect(auction.starting_bid_cents).toBe(500); // untouched — not replaced by the cron's own $0 listing
  });
});

describe('Bundles', () => {
  function bundleBody(overrides = {}) {
    return {
      name: 'Starter set',
      items: [
        { templateId: 'placeholder-chair', dx: 0, dy: 0, dz: 0 },
        { templateId: 'placeholder-tree', dx: 1, dy: 0, dz: 1 },
      ],
      ...overrides,
    };
  }

  it('creates a bundle owned by the session builder, ignoring any builderId in the body', async () => {
    const builder = await signupBuilder('bundle-create');
    const created = await api('/bundles', builder.session({
      method: 'POST', body: JSON.stringify(bundleBody({ builderId: 'someone-else' })),
    }));
    expect(created.response.status).toBe(201);
    expect(created.body.bundle).toMatchObject({
      builderId: builder.builderId,
      name: 'Starter set',
      shared: false,
    });
    expect(created.body.bundle.items).toHaveLength(2);
    expect(created.body.bundle.createdAt).toBeTruthy();
  });

  it('rejects an empty items array, more than 250 items, and a nonexistent templateId', async () => {
    const builder = await signupBuilder('bundle-validate');
    const empty = await api('/bundles', builder.session({
      method: 'POST', body: JSON.stringify(bundleBody({ items: [] })),
    }));
    expect(empty.response.status).toBe(400);

    const tooMany = await api('/bundles', builder.session({
      method: 'POST',
      body: JSON.stringify(bundleBody({
        items: Array.from({ length: 251 }, () => ({ templateId: 'placeholder-chair', dx: 0, dy: 0, dz: 0 })),
      })),
    }));
    expect(tooMany.response.status).toBe(400);

    const badTemplate = await api('/bundles', builder.session({
      method: 'POST',
      body: JSON.stringify(bundleBody({ items: [{ templateId: 'template-does-not-exist', dx: 0, dy: 0, dz: 0 }] })),
    }));
    expect(badTemplate.response.status).toBe(400);
  });

  // Found during a broader backlog-exploration pass (#358): name had no
  // length cap at all, unlike authorLabel/buyerLabel (#337).
  it('rejects a bundle name over the length cap, on both create and rename', async () => {
    const builder = await signupBuilder('bundle-name-too-long');
    const rejectedCreate = await api('/bundles', builder.session({
      method: 'POST', body: JSON.stringify(bundleBody({ name: 'x'.repeat(101) })),
    }));
    expect(rejectedCreate.response.status).toBe(400);

    const created = await api('/bundles', builder.session({
      method: 'POST', body: JSON.stringify(bundleBody()),
    }));
    const rejectedRename = await api(`/bundles/${created.body.bundle.bundleId}`, builder.session({
      method: 'PATCH', body: JSON.stringify({ name: 'x'.repeat(101) }),
    }));
    expect(rejectedRename.response.status).toBe(400);
  });

  it('lists only the session builder\'s own bundles by default, defaulting builderId to the session', async () => {
    const owner = await signupBuilder('bundle-list-owner');
    const other = await signupBuilder('bundle-list-other');
    await api('/bundles', owner.session({ method: 'POST', body: JSON.stringify(bundleBody({ name: 'Owner bundle' })) }));
    await api('/bundles', other.session({ method: 'POST', body: JSON.stringify(bundleBody({ name: 'Other bundle' })) }));

    const ownerList = await api('/bundles', owner.session());
    expect(ownerList.body.bundles.map((b) => b.name)).toEqual(['Owner bundle']);

    const spoofed = await api(`/bundles?builderId=${other.builderId}`, owner.session());
    expect(spoofed.response.status).toBe(403);
  });

  it('lists every shared bundle across builders, unauthenticated, without leaking private ones', async () => {
    const alice = await signupBuilder('bundle-shared-alice');
    const bob = await signupBuilder('bundle-shared-bob');
    await api('/bundles', alice.session({
      method: 'POST', body: JSON.stringify(bundleBody({ name: 'Alice private', shared: false })),
    }));
    const aliceShared = await api('/bundles', alice.session({
      method: 'POST', body: JSON.stringify(bundleBody({ name: 'Alice shared', shared: true })),
    }));
    const bobShared = await api('/bundles', bob.session({
      method: 'POST', body: JSON.stringify(bundleBody({ name: 'Bob shared', shared: true })),
    }));

    // No session attached at all — the community tab is intentionally public.
    const shared = await api('/bundles?shared=true');
    expect(shared.response.status).toBe(200);
    const sharedIds = shared.body.bundles.map((b) => b.bundleId);
    expect(sharedIds).toContain(aliceShared.body.bundle.bundleId);
    expect(sharedIds).toContain(bobShared.body.bundle.bundleId);
    expect(shared.body.bundles.every((b) => b.shared === true)).toBe(true);

    // Alice's own private bundle still shows in her private list, alongside
    // the shared one — sharing doesn't move a bundle out of "my bundles".
    const aliceOwn = await api('/bundles', alice.session());
    expect(aliceOwn.body.bundles.map((b) => b.name).sort()).toEqual(['Alice private', 'Alice shared']);
  });

  it('updates name and shared independently on PATCH, and rejects another builder\'s bundle', async () => {
    const owner = await signupBuilder('bundle-patch-owner');
    const other = await signupBuilder('bundle-patch-other');
    const created = await api('/bundles', owner.session({ method: 'POST', body: JSON.stringify(bundleBody()) }));
    const bundleId = created.body.bundle.bundleId;

    const renamed = await api(`/bundles/${bundleId}`, owner.session({
      method: 'PATCH', body: JSON.stringify({ name: 'Renamed set' }),
    }));
    expect(renamed.response.status).toBe(200);
    expect(renamed.body.bundle).toMatchObject({ name: 'Renamed set', shared: false });

    const shared = await api(`/bundles/${bundleId}`, owner.session({
      method: 'PATCH', body: JSON.stringify({ shared: true }),
    }));
    expect(shared.response.status).toBe(200);
    // Renaming didn't get clobbered by a share-only PATCH, and vice versa.
    expect(shared.body.bundle).toMatchObject({ name: 'Renamed set', shared: true });

    const spoofed = await api(`/bundles/${bundleId}`, other.session({
      method: 'PATCH', body: JSON.stringify({ name: 'Hijacked' }),
    }));
    expect(spoofed.response.status).toBe(403);

    const missing = await api('/bundles/bundle-does-not-exist', owner.session({
      method: 'PATCH', body: JSON.stringify({ name: 'Whatever' }),
    }));
    expect(missing.response.status).toBe(404);
  });

  // #468: unlike the sequential test above, this fires a rename and a
  // share-toggle PATCH genuinely concurrently (Promise.all) — the actual
  // shape of the race, since the old code merged the omitted field in
  // from a snapshot read at the top of each request, so whichever request
  // resolved that read *last* still overwrote the other's just-written
  // field with a stale value once its own UPDATE landed. Both edits must
  // survive regardless of which request's DB read/write happens to
  // interleave first.
  it('does not let a concurrent rename and share-toggle clobber each other', async () => {
    const owner = await signupBuilder('bundle-patch-race-owner');
    const created = await api('/bundles', owner.session({ method: 'POST', body: JSON.stringify(bundleBody()) }));
    const bundleId = created.body.bundle.bundleId;

    const [renamed, shared] = await Promise.all([
      api(`/bundles/${bundleId}`, owner.session({
        method: 'PATCH', body: JSON.stringify({ name: 'Raced rename' }),
      })),
      api(`/bundles/${bundleId}`, owner.session({
        method: 'PATCH', body: JSON.stringify({ shared: true }),
      })),
    ]);
    expect(renamed.response.status).toBe(200);
    expect(shared.response.status).toBe(200);

    const list = await api('/bundles', owner.session());
    const final = list.body.bundles.find((b) => b.bundleId === bundleId);
    expect(final).toMatchObject({ name: 'Raced rename', shared: true });
  });

  it('deletes a bundle only for its owner, and 404s a nonexistent one', async () => {
    const owner = await signupBuilder('bundle-delete-owner');
    const other = await signupBuilder('bundle-delete-other');
    const created = await api('/bundles', owner.session({ method: 'POST', body: JSON.stringify(bundleBody()) }));
    const bundleId = created.body.bundle.bundleId;

    const spoofed = await api(`/bundles/${bundleId}`, other.session({ method: 'DELETE' }));
    expect(spoofed.response.status).toBe(403);

    const deleted = await api(`/bundles/${bundleId}`, owner.session({ method: 'DELETE' }));
    expect(deleted.response.status).toBe(200);
    expect(deleted.body).toEqual({ deleted: true });
    expect((await api(`/bundles/${bundleId}`, owner.session({ method: 'DELETE' }))).response.status).toBe(404);
  });
});

describe('Prohibited categories and digital goods', () => {
  it('rejects a listing whose name matches a prohibited phrase', async () => {
    const rejected = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'prohibited-name-listing',
        name: 'Realistic Handgun Replica',
        color: '#111111',
        dimensions: { width: 1, depth: 1, height: 1 },
      }),
    });
    expect(rejected.response.status).toBe(400);
    expect(rejected.body.error).toMatch(/prohibited-categories policy/);
  });

  it('rejects a listing whose category or subcategory matches a prohibited phrase', async () => {
    const byCategory = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'prohibited-category-listing',
        name: 'Ordinary Sounding Item',
        category: 'illegal drug paraphernalia',
        color: '#111111',
        dimensions: { width: 1, depth: 1, height: 1 },
      }),
    });
    expect(byCategory.response.status).toBe(400);

    const bySubcategory = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'prohibited-subcategory-listing',
        name: 'Ordinary Sounding Item Two',
        subcategory: 'counterfeit goods',
        color: '#111111',
        dimensions: { width: 1, depth: 1, height: 1 },
      }),
    });
    expect(bySubcategory.response.status).toBe(400);
  });

  it('does not false-positive on ordinary placeholder/furniture names', async () => {
    const allowed = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'ordinary-oak-chair',
        name: 'Oak Chair',
        category: 'furniture',
        subcategory: 'seating',
        color: '#8b5a2b',
        dimensions: { width: 0.5, depth: 0.5, height: 0.9 },
      }),
    });
    expect(allowed.response.status).toBe(201);
  });

  it('also rejects a prohibited rename via PATCH and a prohibited entry via batch create', async () => {
    const created = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'renamed-to-prohibited',
        name: 'Plain Table',
        color: '#111111',
        dimensions: { width: 1, depth: 1, height: 1 },
      }),
    });
    expect(created.response.status).toBe(201);
    const renamed = await api('/catalog/renamed-to-prohibited', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Illegal Drug Table' }),
    });
    expect(renamed.response.status).toBe(400);

    const batch = await api('/catalog/batch', {
      method: 'POST',
      body: JSON.stringify({
        templates: [{
          templateId: 'batch-prohibited-listing',
          name: 'Ammunition Box',
          color: '#111111',
          dimensions: { width: 1, depth: 1, height: 1 },
        }],
      }),
    });
    expect(batch.response.status).toBe(400);
  });

  async function uploadTestModel() {
    const form = new FormData();
    form.set('file', glbFile());
    const response = await SELF.fetch('https://higglehaven.test/api/models', { method: 'POST', body: form });
    return (await response.json()).modelUrl;
  }

  it('rejects an invalid digitalGoodDisclaimer key and accepts a valid one', async () => {
    const invalid = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'digital-good-invalid',
        name: 'Mystery Download',
        color: '#111111',
        dimensions: { width: 0.1, depth: 0.1, height: 0.1 },
        metadata: { digitalGoodDisclaimer: 'seller-made-up-wording' },
      }),
    });
    expect(invalid.response.status).toBe(400);
    expect(invalid.body.error).toMatch(/digitalGoodDisclaimer must be one of/);

    const modelUrl = await uploadTestModel();
    const valid = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'digital-good-valid',
        name: 'Downloadable Gift Card',
        color: '#111111',
        dimensions: { width: 0.1, depth: 0.1, height: 0.1 },
        modelUrl,
        metadata: { digitalGoodDisclaimer: 'gift-card' },
      }),
    });
    expect(valid.response.status).toBe(201);
    expect(valid.body.template.metadata.digitalGoodDisclaimer).toBe('gift-card');

    const fetched = await api('/catalog/digital-good-valid');
    expect(fetched.body.template.metadata.digitalGoodDisclaimer).toBe('gift-card');
  });

  // Found via backlog audit: docs/SPEC.md §4's digital-goods exception is
  // conditional on *both* (a) a representative 3D model and (b) a clear
  // disclaimer — modelUrl is optional for an ordinary template (a plain
  // colored box is a normal fallback look), so without this guard a
  // disclaimer alone was silently sufficient, satisfying only condition (b).
  it('rejects a digital-good listing with no representative 3D model', async () => {
    const rejected = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'digital-good-no-model',
        name: 'Modelless Download',
        color: '#111111',
        dimensions: { width: 0.1, depth: 0.1, height: 0.1 },
        metadata: { digitalGoodDisclaimer: 'art-file' },
      }),
    });
    expect(rejected.response.status).toBe(400);
    expect(rejected.body.error).toMatch(/must include modelUrl/);

    // Also enforced on update — flagging an existing modelUrl-less listing
    // as a digital good after the fact shouldn't be possible either.
    const plainListing = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'digital-good-retrofit',
        name: 'Plain Product',
        color: '#111111',
        dimensions: { width: 0.1, depth: 0.1, height: 0.1 },
      }),
    });
    expect(plainListing.response.status).toBe(201);
    const retrofitted = await api('/catalog/digital-good-retrofit', {
      method: 'PATCH',
      body: JSON.stringify({ metadata: { digitalGoodDisclaimer: 'art-file' } }),
    });
    expect(retrofitted.response.status).toBe(400);
  });

  it('lets a digital-good flag be cleared by omitting it from a metadata replace', async () => {
    const modelUrl = await uploadTestModel();
    await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'digital-good-to-clear',
        name: 'Temporary Digital Good',
        color: '#111111',
        dimensions: { width: 0.1, depth: 0.1, height: 0.1 },
        modelUrl,
        metadata: { digitalGoodDisclaimer: 'art-file' },
      }),
    });
    const cleared = await api('/catalog/digital-good-to-clear', {
      method: 'PATCH',
      body: JSON.stringify({ metadata: {} }),
    });
    expect(cleared.response.status).toBe(200);
    expect(cleared.body.template.metadata.digitalGoodDisclaimer).toBeUndefined();
  });
});

describe('Shipping', () => {
  it('rejects a non-boolean metadata.domesticOnly', async () => {
    const rejected = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'shipping-bad-domestic-only-template',
        name: 'Bad domestic-only product',
        color: '#123456',
        dimensions: { width: 1, depth: 1, height: 1 },
        metadata: { domesticOnly: 'yes' },
      }),
    });
    expect(rejected.response.status).toBe(400);
    expect(rejected.body.error).toMatch(/domesticOnly must be a boolean/);
  });

  it('accepts a valid metadata.domesticOnly and round-trips it through GET', async () => {
    const created = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'shipping-domestic-only-template',
        name: 'US-only product',
        color: '#123456',
        dimensions: { width: 1, depth: 1, height: 1 },
        metadata: { domesticOnly: true },
      }),
    });
    expect(created.response.status).toBe(201);
    expect(created.body.template.metadata.domesticOnly).toBe(true);

    const fetched = await api('/catalog/shipping-domestic-only-template');
    expect(fetched.body.template.metadata.domesticOnly).toBe(true);
  });

  it('defaults to shipping internationally when metadata.domesticOnly is absent', async () => {
    const created = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'shipping-default-template',
        name: 'Default-shipping product',
        color: '#123456',
        dimensions: { width: 1, depth: 1, height: 1 },
      }),
    });
    expect(created.response.status).toBe(201);
    expect(created.body.template.metadata.domesticOnly).toBeUndefined();
  });

  it('lets a domestic-only flag be cleared by omitting it from a metadata replace', async () => {
    await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'shipping-domestic-only-to-clear',
        name: 'Temporary US-only product',
        color: '#123456',
        dimensions: { width: 1, depth: 1, height: 1 },
        metadata: { domesticOnly: true },
      }),
    });
    const cleared = await api('/catalog/shipping-domestic-only-to-clear', {
      method: 'PATCH',
      body: JSON.stringify({ metadata: {} }),
    });
    expect(cleared.response.status).toBe(200);
    expect(cleared.body.template.metadata.domesticOnly).toBeUndefined();
  });
});

// #327 ("build the 3D Model > Flat image creation pathway") — a minimal,
// real 1x1 transparent PNG, same idiom as glbFile's synthetic-but-valid
// binary fixture, so these tests exercise the real base64-decode/R2-put
// path rather than mocking it away.
const ONE_PIXEL_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

describe('Product-image thumbnail (#327)', () => {
  async function createOwnedTemplate(templateId, seller) {
    return api('/catalog', seller.session({
      method: 'POST',
      body: JSON.stringify({
        templateId,
        name: 'Thumbnail test product',
        color: '#123456',
        dimensions: { width: 1, depth: 1, height: 1 },
        sellerId: seller.sellerId,
      }),
    }));
  }

  it('requires a session, and requires it to be the owning seller', async () => {
    const owner = await signupSeller('thumbnail-owner');
    const stranger = await signupSeller('thumbnail-stranger');
    const created = await createOwnedTemplate('thumbnail-auth-template', owner);
    expect(created.response.status).toBe(201);

    const noSession = await api('/catalog/thumbnail-auth-template/thumbnail', {
      method: 'POST',
      body: JSON.stringify({ imageDataUrl: ONE_PIXEL_PNG_DATA_URL }),
    });
    expect(noSession.response.status).toBe(401);

    const wrongSeller = await api('/catalog/thumbnail-auth-template/thumbnail', stranger.session({
      method: 'POST',
      body: JSON.stringify({ imageDataUrl: ONE_PIXEL_PNG_DATA_URL }),
    }));
    expect(wrongSeller.response.status).toBe(403);
  });

  it('rejects a thumbnail for a template with no owning seller', async () => {
    const created = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'thumbnail-unowned-template',
        name: 'Unowned thumbnail test product',
        color: '#123456',
        dimensions: { width: 1, depth: 1, height: 1 },
      }),
    });
    expect(created.response.status).toBe(201);

    const owner = await signupSeller('thumbnail-unowned-attempt-seller');
    const rejected = await api('/catalog/thumbnail-unowned-template/thumbnail', owner.session({
      method: 'POST',
      body: JSON.stringify({ imageDataUrl: ONE_PIXEL_PNG_DATA_URL }),
    }));
    expect(rejected.response.status).toBe(403);
    expect(rejected.body.error).toMatch(/no owning seller/);
  });

  it('returns 404 for a nonexistent template', async () => {
    const owner = await signupSeller('thumbnail-404-seller');
    const missing = await api('/catalog/thumbnail-does-not-exist/thumbnail', owner.session({
      method: 'POST',
      body: JSON.stringify({ imageDataUrl: ONE_PIXEL_PNG_DATA_URL }),
    }));
    expect(missing.response.status).toBe(404);
  });

  it('rejects a malformed or oversized imageDataUrl', async () => {
    const owner = await signupSeller('thumbnail-validation-seller');
    await createOwnedTemplate('thumbnail-validation-template', owner);

    const notADataUrl = await api('/catalog/thumbnail-validation-template/thumbnail', owner.session({
      method: 'POST',
      body: JSON.stringify({ imageDataUrl: 'https://example.com/cat.png' }),
    }));
    expect(notADataUrl.response.status).toBe(400);
    expect(notADataUrl.body.error).toMatch(/data URL/);

    const notBase64 = await api('/catalog/thumbnail-validation-template/thumbnail', owner.session({
      method: 'POST',
      body: JSON.stringify({ imageDataUrl: 'data:image/png;base64,not-valid-base64!!!' }),
    }));
    expect(notBase64.response.status).toBe(400);

    // ~440KB of base64, comfortably over the 300KB decoded-byte cap.
    const huge = 'data:image/png;base64,' + 'A'.repeat(600000);
    const tooBig = await api('/catalog/thumbnail-validation-template/thumbnail', owner.session({
      method: 'POST',
      body: JSON.stringify({ imageDataUrl: huge }),
    }));
    expect(tooBig.response.status).toBe(413);
  });

  it('rejects a malformed embedding', async () => {
    const owner = await signupSeller('thumbnail-embedding-validation-seller');
    await createOwnedTemplate('thumbnail-embedding-validation-template', owner);

    const notAnArray = await api('/catalog/thumbnail-embedding-validation-template/thumbnail', owner.session({
      method: 'POST',
      body: JSON.stringify({ imageDataUrl: ONE_PIXEL_PNG_DATA_URL, embedding: 'not-an-array' }),
    }));
    expect(notAnArray.response.status).toBe(400);

    const nonNumeric = await api('/catalog/thumbnail-embedding-validation-template/thumbnail', owner.session({
      method: 'POST',
      body: JSON.stringify({ imageDataUrl: ONE_PIXEL_PNG_DATA_URL, embedding: [0.1, 'x', 0.3] }),
    }));
    expect(nonNumeric.response.status).toBe(400);
  });

  it('stores the image and embedding, and serves the image back from /uploads/', async () => {
    const owner = await signupSeller('thumbnail-success-seller');
    await createOwnedTemplate('thumbnail-success-template', owner);
    const embedding = [0.1, 0.2, 0.3, 0.4];

    const uploaded = await api('/catalog/thumbnail-success-template/thumbnail', owner.session({
      method: 'POST',
      body: JSON.stringify({ imageDataUrl: ONE_PIXEL_PNG_DATA_URL, embedding }),
    }));
    expect(uploaded.response.status).toBe(200);
    expect(uploaded.body.imageUrl).toMatch(/^\/uploads\/thumbnails\/.+\.png$/);

    const fetched = await api('/catalog/thumbnail-success-template');
    expect(fetched.body.template.imageUrl).toBe(uploaded.body.imageUrl);
    expect(fetched.body.template.imageEmbedding).toEqual(embedding);

    const served = await SELF.fetch(`https://higglehaven.test${uploaded.body.imageUrl}`);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
  });

  it('does not persist an embedding when none is sent', async () => {
    const owner = await signupSeller('thumbnail-no-embedding-seller');
    await createOwnedTemplate('thumbnail-no-embedding-template', owner);

    const uploaded = await api('/catalog/thumbnail-no-embedding-template/thumbnail', owner.session({
      method: 'POST',
      body: JSON.stringify({ imageDataUrl: ONE_PIXEL_PNG_DATA_URL }),
    }));
    expect(uploaded.response.status).toBe(200);

    const fetched = await api('/catalog/thumbnail-no-embedding-template');
    expect(fetched.body.template.imageEmbedding).toBeNull();
  });

  it('deduplicates identical thumbnail bytes under the same content-addressed key', async () => {
    const owner = await signupSeller('thumbnail-dedup-seller');
    await createOwnedTemplate('thumbnail-dedup-template-a', owner);
    await createOwnedTemplate('thumbnail-dedup-template-b', owner);

    const first = await api('/catalog/thumbnail-dedup-template-a/thumbnail', owner.session({
      method: 'POST',
      body: JSON.stringify({ imageDataUrl: ONE_PIXEL_PNG_DATA_URL }),
    }));
    const second = await api('/catalog/thumbnail-dedup-template-b/thumbnail', owner.session({
      method: 'POST',
      body: JSON.stringify({ imageDataUrl: ONE_PIXEL_PNG_DATA_URL }),
    }));
    expect(first.body.imageUrl).toBe(second.body.imageUrl);
  });
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

  it('404s purchasing an instance that does not exist', async () => {
    const rejected = await api('/instances/purchase-missing-instance/purchase', { method: 'POST' });
    expect(rejected.response.status).toBe(404);
  });

  it('400s purchasing an unpriced product', async () => {
    const seller = await signupBuilder('purchase-unpriced-seller');
    await createGreenbeltLandletWithArea('purchase-unpriced-landlet', 1000);
    await claim('purchase-unpriced-landlet', seller);
    await createTemplate('purchase-unpriced-template');
    await placeInstance('purchase-unpriced-instance', 'purchase-unpriced-landlet', 'purchase-unpriced-template', seller);

    const rejected = await api('/instances/purchase-unpriced-instance/purchase', { method: 'POST' });
    expect(rejected.response.status).toBe(400);
  });

  it('400s purchasing an instance on an unclaimed lándlet', async () => {
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

    const rejected = await api('/instances/purchase-unclaimed-instance/purchase', { method: 'POST' });
    expect(rejected.response.status).toBe(400);
  });

  it('reads quantity and buyerLabel from the request body, defaulting to 1 and anonymous', async () => {
    const seller = await signupBuilder('purchase-body-seller');
    await createGreenbeltLandletWithArea('purchase-body-landlet', 1000);
    await claim('purchase-body-landlet', seller);
    await createTemplate('purchase-body-template', { priceCents: 1000 });
    await placeInstance('purchase-body-instance', 'purchase-body-landlet', 'purchase-body-template', seller);

    // No body at all — should default rather than 415/400.
    const defaulted = await api('/instances/purchase-body-instance/purchase', { method: 'POST' });
    expect(defaulted.response.status).toBe(201);
    expect(defaulted.body.purchase).toMatchObject({ quantity: 1, buyerLabel: null, unitPriceCents: 1000, totalCents: 1000 });

    const withBody = await api('/instances/purchase-body-instance/purchase', {
      method: 'POST',
      body: JSON.stringify({ quantity: 3, buyerLabel: 'A Shopper' }),
    });
    expect(withBody.response.status).toBe(201);
    expect(withBody.body.purchase).toMatchObject({ quantity: 3, buyerLabel: 'A Shopper', unitPriceCents: 1000, totalCents: 3000 });

    const badQuantity = await api('/instances/purchase-body-instance/purchase', {
      method: 'POST',
      body: JSON.stringify({ quantity: 0 }),
    });
    expect(badQuantity.response.status).toBe(400);

    // Found via backlog audit (#337): buyerLabel had no length cap at all.
    const badBuyerLabel = await api('/instances/purchase-body-instance/purchase', {
      method: 'POST',
      body: JSON.stringify({ buyerLabel: 'x'.repeat(101) }),
    });
    expect(badBuyerLabel.response.status).toBe(400);
  });

  it('rejects an absurd quantity rather than crediting an unbounded higgles amount', async () => {
    // This endpoint is deliberately unauthenticated (see docs/API.md's
    // "Simulated purchases"), so quantity is one of two guards (alongside
    // the rate limit below) against one request minting an arbitrary
    // higgles credit.
    const seller = await signupBuilder('purchase-quantity-cap-seller');
    await createGreenbeltLandletWithArea('purchase-quantity-cap-landlet', 1000);
    await claim('purchase-quantity-cap-landlet', seller);
    await createTemplate('purchase-quantity-cap-template', { priceCents: 1000 });
    await placeInstance('purchase-quantity-cap-instance', 'purchase-quantity-cap-landlet', 'purchase-quantity-cap-template', seller);

    const tooMany = await api('/instances/purchase-quantity-cap-instance/purchase', {
      method: 'POST',
      body: JSON.stringify({ quantity: 1001 }),
    });
    expect(tooMany.response.status).toBe(400);
    expect(tooMany.body).toEqual({ error: 'quantity must be 1000 or fewer' });

    const atCap = await api('/instances/purchase-quantity-cap-instance/purchase', {
      method: 'POST',
      body: JSON.stringify({ quantity: 1000 }),
    });
    expect(atCap.response.status).toBe(201);
    expect(atCap.body.purchase.quantity).toBe(1000);
  });

  it('rate-limits repeated purchases from the same client', async () => {
    // Unauthenticated on purpose (no shopper account exists to check
    // against), but a successful call credits a real builder balance and
    // earnings ledger entry, so it gets the same per-client throttle as
    // signup/password-reset/model-upload. A synthetic cf-connecting-ip
    // keeps this test's bucket from colliding with every other purchase
    // test in this file, which otherwise all share the same "unknown" IP
    // bucket (mirrors the model-upload rate-limit test's own approach).
    const seller = await signupBuilder('purchase-rate-limit-seller');
    await createGreenbeltLandletWithArea('purchase-rate-limit-landlet', 1000);
    await claim('purchase-rate-limit-landlet', seller);
    await createTemplate('purchase-rate-limit-template', { priceCents: 1000 });
    await placeInstance('purchase-rate-limit-instance', 'purchase-rate-limit-landlet', 'purchase-rate-limit-template', seller);

    const headers = { 'cf-connecting-ip': `test-${crypto.randomUUID()}` };
    for (let i = 0; i < 30; i++) {
      const attempt = await api('/instances/purchase-rate-limit-instance/purchase', { method: 'POST', headers });
      expect(attempt.response.status).not.toBe(429);
    }
    const limited = await api('/instances/purchase-rate-limit-instance/purchase', { method: 'POST', headers });
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
    const seller = await signupBuilder('purchase-rate-limit-burst-seller');
    await createGreenbeltLandletWithArea('purchase-rate-limit-burst-landlet', 1000);
    await claim('purchase-rate-limit-burst-landlet', seller);
    await createTemplate('purchase-rate-limit-burst-template', { priceCents: 1000 });
    await placeInstance('purchase-rate-limit-burst-instance', 'purchase-rate-limit-burst-landlet', 'purchase-rate-limit-burst-template', seller);

    const headers = { 'cf-connecting-ip': `test-${crypto.randomUUID()}` };
    const attempts = await Promise.all(
      Array.from({ length: 40 }, () => api('/instances/purchase-rate-limit-burst-instance/purchase', { method: 'POST', headers })),
    );
    const succeeded = attempts.filter((a) => a.response.status !== 429);
    const limited = attempts.filter((a) => a.response.status === 429);
    expect(succeeded).toHaveLength(30);
    expect(limited).toHaveLength(10);
  }, 45000);

  it('computes the 2% commission with a 50/50 split, crediting the builder\'s balance and earnings ledger', async () => {
    const seller = await signupBuilder('purchase-commission-seller');
    await createGreenbeltLandletWithArea('purchase-commission-landlet', 1000);
    await claim('purchase-commission-landlet', seller);
    await createTemplate('purchase-commission-template', { priceCents: 10000 }); // $100
    await placeInstance('purchase-commission-instance', 'purchase-commission-landlet', 'purchase-commission-template', seller);

    const before = await builderRow(seller.builderId);
    const purchased = await api('/instances/purchase-commission-instance/purchase', { method: 'POST' });
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
    const seller = await signupBuilder('purchase-floor-seller');
    await createGreenbeltLandletWithArea('purchase-floor-landlet', 1000);
    await claim('purchase-floor-landlet', seller);
    await createTemplate('purchase-floor-template', { priceCents: 100000 }); // $1000
    await placeInstance('purchase-floor-instance', 'purchase-floor-landlet', 'purchase-floor-template', seller);

    // $1000 * 2% = $20 commission; 50% of that is $10 (1000 cents), but the
    // 0.5% floor on the $1000 total is $5 (500 cents) — the 50% split
    // already clears the floor here, so this exercises the non-floor branch
    // with a large total to confirm rounding stays exact.
    const purchased = await api('/instances/purchase-floor-instance/purchase', { method: 'POST' });
    expect(purchased.body.purchase).toMatchObject({
      totalCents: 100000, commissionCents: 2000, builderShareCents: 1000, platformShareCents: 1000,
    });
  });

  it('lists a builder\'s purchase history via GET /api/purchases', async () => {
    const seller = await signupBuilder('purchase-list-seller');
    await createGreenbeltLandletWithArea('purchase-list-landlet', 1000);
    await claim('purchase-list-landlet', seller);
    await createTemplate('purchase-list-template', { priceCents: 500 });
    await placeInstance('purchase-list-instance', 'purchase-list-landlet', 'purchase-list-template', seller);

    await api('/instances/purchase-list-instance/purchase', { method: 'POST' });
    await api('/instances/purchase-list-instance/purchase', { method: 'POST' });

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
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json',
    });
    expect(rejected.status).toBe(400);
  });

  it('404s refunding a purchase that does not exist', async () => {
    const rejected = await api('/purchases/purchase-does-not-exist/refund', { method: 'POST' });
    expect(rejected.response.status).toBe(404);
  });

  it('refunds a purchase, clawing back exactly the builder\'s commission share (not the full total)', async () => {
    const seller = await signupBuilder('purchase-refund-seller');
    await createGreenbeltLandletWithArea('purchase-refund-landlet', 1000);
    await claim('purchase-refund-landlet', seller);
    await createTemplate('purchase-refund-template', { priceCents: 10000 }); // $100
    await placeInstance('purchase-refund-instance', 'purchase-refund-landlet', 'purchase-refund-template', seller);

    const purchased = await api('/instances/purchase-refund-instance/purchase', { method: 'POST' });
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
    expect(secondRefund.response.status).toBe(400);
    const afterSecondAttempt = await builderRow(seller.builderId);
    expect(afterSecondAttempt.higgles_balance_cents).toBe(after.higgles_balance_cents);
  });

  it('keeps a purchase record (with a nulled builderId) after the hosting builder deletes their account, and still allows a refund', async () => {
    const seller = await signupBuilder('purchase-builder-deleted-seller');
    await createGreenbeltLandletWithArea('purchase-builder-deleted-landlet', 1000);
    await claim('purchase-builder-deleted-landlet', seller);
    await createTemplate('purchase-builder-deleted-template', { priceCents: 4000 });
    await placeInstance('purchase-builder-deleted-instance', 'purchase-builder-deleted-landlet', 'purchase-builder-deleted-template', seller);

    const purchased = await api('/instances/purchase-builder-deleted-instance/purchase', { method: 'POST' });
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

  it('rejects refunding a purchase with no seller without an admin session', async () => {
    const seller = await signupBuilder('purchase-refund-no-seller-auth-seller');
    await createGreenbeltLandletWithArea('purchase-refund-no-seller-auth-landlet', 1000);
    await claim('purchase-refund-no-seller-auth-landlet', seller);
    await createTemplate('purchase-refund-no-seller-auth-template', { priceCents: 5000 });
    await placeInstance('purchase-refund-no-seller-auth-instance', 'purchase-refund-no-seller-auth-landlet', 'purchase-refund-no-seller-auth-template', seller);

    const purchased = await api('/instances/purchase-refund-no-seller-auth-instance/purchase', { method: 'POST' });
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
    const builder = await signupBuilder('purchase-refund-owner-builder');
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

    const purchased = await api('/instances/purchase-refund-owner-instance/purchase', { method: 'POST' });
    const { purchaseId } = purchased.body.purchase;

    const wrongSeller = await api(`/purchases/${purchaseId}/refund`, otherSeller.session({ method: 'POST' }));
    expect(wrongSeller.response.status).toBe(403);

    const refunded = await api(`/purchases/${purchaseId}/refund`, owningSeller.session({ method: 'POST' }));
    expect(refunded.response.status).toBe(200);
    expect(refunded.body.purchase.refundedAt).not.toBeNull();
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
    const builder = await signupBuilder('purchase-refund-deleted-seller-builder');
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

    const purchased = await api('/instances/purchase-refund-deleted-seller-instance/purchase', { method: 'POST' });
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
    const builder = await signupBuilder('purchase-list-owner-builder');
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
    const purchased = await api('/instances/purchase-list-owner-instance/purchase', { method: 'POST' });

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

  it('lets the clawback push a builder\'s higgles balance negative — there is no floor on a refund', async () => {
    const seller = await signupBuilder('purchase-refund-negative-seller');
    await createGreenbeltLandletWithArea('purchase-refund-negative-landlet', 1000);
    await claim('purchase-refund-negative-landlet', seller);
    await createTemplate('purchase-refund-negative-template', { priceCents: 10000 });
    await placeInstance('purchase-refund-negative-instance', 'purchase-refund-negative-landlet', 'purchase-refund-negative-template', seller);

    const purchased = await api('/instances/purchase-refund-negative-instance/purchase', { method: 'POST' });
    // Spend down the builder's balance below the commission they're about
    // to have clawed back, so the refund must push it negative.
    await env.DB.prepare('UPDATE builders SET higgles_balance_cents = 0 WHERE builder_id = ?').bind(seller.builderId).run();

    await api(`/purchases/${purchased.body.purchase.purchaseId}/refund`, adminSession({ method: 'POST' }));
    const after = await builderRow(seller.builderId);
    expect(after.higgles_balance_cents).toBe(-purchased.body.purchase.builderShareCents);
  });

  it('respects a seller\'s no-returns policy, rejecting the refund', async () => {
    const seller = await signupBuilder('purchase-no-returns-seller');
    await createGreenbeltLandletWithArea('purchase-no-returns-landlet', 1000);
    await claim('purchase-no-returns-landlet', seller);
    await createTemplate('purchase-no-returns-template', { priceCents: 500, metadata: { noReturns: true } });
    await placeInstance('purchase-no-returns-instance', 'purchase-no-returns-landlet', 'purchase-no-returns-template', seller);

    const purchased = await api('/instances/purchase-no-returns-instance/purchase', { method: 'POST' });
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
      const builder = await signupBuilder('checkout-fallback-builder');
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

      const purchased = await api('/instances/checkout-fallback-instance/purchase', { method: 'POST' });
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
      const seller = await signupBuilder('checkout-idempotent-seller');
      await createGreenbeltLandletWithArea('checkout-idempotent-landlet', 1000);
      await claim('checkout-idempotent-landlet', seller);
      await createTemplate('checkout-idempotent-template', { priceCents: 2000 });
      await placeInstance('checkout-idempotent-instance', 'checkout-idempotent-landlet', 'checkout-idempotent-template', seller);
      const purchased = await api('/instances/checkout-idempotent-instance/purchase', { method: 'POST' });
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
      const seller = await signupBuilder('real-refund-seller');
      await createGreenbeltLandletWithArea('real-refund-landlet', 1000);
      await claim('real-refund-landlet', seller);
      await createTemplate('real-refund-template', { priceCents: 8000 });
      await placeInstance('real-refund-instance', 'real-refund-landlet', 'real-refund-template', seller);
      const purchased = await api('/instances/real-refund-instance/purchase', { method: 'POST' });
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
  });
});
