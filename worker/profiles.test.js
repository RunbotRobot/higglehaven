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

// #629: placing a bid now requires the bidder to actually hold enough
// higgles_balance_cents to cover it (see worker/index.js's
// handleAuctionBids/resolveAuction) — a fresh signupBuilder() starts at 0,
// so every test below that places a real bid funds its bidder first. Same
// pattern as stripe-connect.test.js's own creditHiggles helper: this SETs
// an absolute balance, not additive.
function fundHiggles(builder, amountCents = 100_000_000) {
  return env.DB.prepare('UPDATE builders SET higgles_balance_cents = ? WHERE builder_id = ?')
    .bind(amountCents, builder.builderId).run();
}

describe('Builders', () => {
  it('creates, lists, renames, and validates builders', async () => {
    const created = await api('/builders', { method: 'POST', body: JSON.stringify({ label: 'Ada' }) });
    expect(created.response.status).toBe(201);
    expect(created.body.builder.label).toBe('Ada');
    expect(created.body.builder.builderId).toMatch(/^builder-/);

    const withId = await api('/builders', {
      method: 'POST', body: JSON.stringify({ builderId: 'builder-explicit-1', label: 'Grace' }),
    });
    expect(withId.response.status).toBe(201);
    expect(withId.body.builder.builderId).toBe('builder-explicit-1');

    const duplicate = await api('/builders', {
      method: 'POST', body: JSON.stringify({ builderId: 'builder-explicit-1', label: 'Grace again' }),
    });
    expect(duplicate.response.status).toBe(409);

    const list = await api('/builders');
    expect(list.response.status).toBe(200);
    expect(list.body.builders.map((b) => b.builderId)).toEqual(
      expect.arrayContaining([created.body.builder.builderId, 'builder-explicit-1']),
    );

    // Renaming requires a real session now — 'created' above is an
    // unlinked builder (no user account backs it), so there's no session
    // that could ever own it. A freshly signed-up builder exercises the
    // actual rename path instead.
    const renamer = await signupBuilder('rename-builder');
    const renamed = await api(`/builders/${renamer.builderId}`, renamer.session({
      method: 'PATCH', body: JSON.stringify({ label: 'Ada Lovelace' }),
    }));
    expect(renamed.response.status).toBe(200);
    expect(renamed.body.builder.label).toBe('Ada Lovelace');

    const unauthenticatedRename = await api(`/builders/${renamer.builderId}`, {
      method: 'PATCH', body: JSON.stringify({ label: 'Someone else' }),
    });
    expect(unauthenticatedRename.response.status).toBe(401);

    const renameMissing = await api('/builders/builder-does-not-exist', renamer.session({
      method: 'PATCH', body: JSON.stringify({ label: 'x' }),
    }));
    expect(renameMissing.response.status).toBe(404);
  });

  // #336/#325: prerequisite infrastructure for #325's inactivity-triggered
  // auctions — getOrCreateBuilderForUser bumps last_active_at every time a
  // session resolves *your* builder profile, mutation or not (per the
  // owner's #325 decision: "any login... even if only logging in for
  // shopping or selling" counts as activity). A builder created directly
  // via the DB (never through a real session, the way a pre-existing
  // dev-mode row or the pioneer-cohort filler rows above come to exist)
  // still reads as NULL — matching migrations/0067's own comment on why
  // that should never be backdated to a guess.
  it('bumps last_active_at on any resolved session (including a mere GET /builders/me), not on a DB-only row', async () => {
    const direct = await env.DB.prepare(
      "INSERT INTO builders (builder_id, label) VALUES ('builder-activity-test-direct', 'Direct row') RETURNING last_active_at",
    ).first();
    expect(direct.last_active_at).toBeNull();

    const builder = await signupBuilder('activity-test-builder'); // itself resolves /builders/me
    const afterSignup = await env.DB.prepare(
      'SELECT last_active_at FROM builders WHERE builder_id = ?',
    ).bind(builder.builderId).first();
    expect(afterSignup.last_active_at).not.toBeNull();
    expect(new Date(afterSignup.last_active_at).getTime()).toBeGreaterThan(Date.now() - 10000);
  });

  it('deleting a builder releases their claimed landlet and clears its build, keeping the shape', async () => {
    const builder = await signupBuilder('release-test-builder');

    await createGreenbeltLandlet('release-test-landlet');
    const claimed = await api('/landlets/release-test-landlet/claim', builder.session({ method: 'POST' }));
    expect(claimed.response.status).toBe(200);
    const originalPolygon = claimed.body.landlet.polygon;

    await api('/instances', builder.session({
      method: 'POST',
      body: JSON.stringify({ landletId: 'release-test-landlet', templateId: 'placeholder-tree', x: 1, y: 1 }),
    }));
    await api('/landlets/release-test-landlet/versions', builder.session({
      method: 'POST', body: JSON.stringify({ name: 'A build worth keeping' }),
    }));

    const deleted = await api(`/builders/${builder.builderId}`, builder.session({ method: 'DELETE' }));
    expect(deleted.response.status).toBe(200);
    expect(deleted.body.releasedLandletIds).toEqual(['release-test-landlet']);

    const released = await api('/landlets/release-test-landlet');
    expect(released.body.landlet.status).toBe('greenbelt');
    expect(released.body.landlet.ownerBuilderId).toBeNull();
    expect(released.body.landlet.activeVersionId).toBeNull();
    expect(released.body.landlet.polygon).toEqual(originalPolygon);

    const instances = await api('/instances?landletId=release-test-landlet');
    expect(instances.body.instances).toEqual([]);
    const versions = await api('/landlets/release-test-landlet/versions');
    expect(versions.body.versions).toEqual([]);

    const gone = await api(`/builders/${builder.builderId}`);
    expect(gone.response.status).toBe(404);

    const someoneElse = await signupBuilder('release-test-reclaimer');
    const reclaimed = await api('/landlets/release-test-landlet/claim', someoneElse.session({ method: 'POST' }));
    expect(reclaimed.response.status).toBe(200);
  });

  it('deleting a builder who owns nothing just removes them', async () => {
    const builder = await signupBuilder('owns-nothing-builder');
    const deleted = await api(`/builders/${builder.builderId}`, builder.session({ method: 'DELETE' }));
    expect(deleted.response.status).toBe(200);
    expect(deleted.body.releasedLandletIds).toEqual([]);
  });

  // #279: the owner's stated policy is that once an auction has bids, the
  // seller can no longer back out of it — including by deleting their own
  // account. This used to succeed (cascading the auction+bids away and
  // just notifying the bidder after the fact); it's blocked outright now.
  it('rejects deleting a builder while their own active auction has bids', async () => {
    const seller = await signupBuilder('auction-seller-deleted');
    const bidder = await signupBuilder('auction-seller-deleted-bidder');
    await fundHiggles(bidder);
    await createGreenbeltLandlet('auction-seller-deleted-landlet');
    await api('/landlets/auction-seller-deleted-landlet/claim', seller.session({ method: 'POST' }));
    const started = await api('/landlets/auction-seller-deleted-landlet/auction', seller.session({
      method: 'POST', body: JSON.stringify({ startingBidCents: 0, durationHours: 1 }),
    }));
    const auctionId = started.body.auction.auctionId;
    const bid = await api(`/auctions/${auctionId}/bids`, bidder.session({
      method: 'POST', body: JSON.stringify({ amountCents: 500 }),
    }));
    expect(bid.response.status).toBe(201);

    const deleted = await api(`/builders/${seller.builderId}`, seller.session({ method: 'DELETE' }));
    expect(deleted.response.status).toBe(409);
    expect(deleted.body).toEqual({ error: 'Cannot delete this builder while their own auction has bids' });

    // Nothing was touched — the auction, its bid, and the seller's builder
    // row all still exist.
    const auction = await api(`/auctions/${auctionId}`);
    expect(auction.response.status).toBe(200);
    expect(auction.body.auction.status).toBe('active');
    const bids = await api(`/auctions/${auctionId}/bids`);
    expect(bids.body.bids).toHaveLength(1);
    const stillThere = await env.DB.prepare('SELECT builder_id FROM builders WHERE builder_id = ?')
      .bind(seller.builderId).first();
    expect(stillThere).not.toBeNull();
  });

  it('allows deleting a builder whose own active auction has no bids yet', async () => {
    const seller = await signupBuilder('zero-bid-auction-seller-deleted');
    await createGreenbeltLandlet('zero-bid-auction-seller-deleted-landlet');
    await api('/landlets/zero-bid-auction-seller-deleted-landlet/claim', seller.session({ method: 'POST' }));
    const started = await api('/landlets/zero-bid-auction-seller-deleted-landlet/auction', seller.session({
      method: 'POST', body: JSON.stringify({ startingBidCents: 0, durationHours: 1 }),
    }));
    const auctionId = started.body.auction.auctionId;

    const deleted = await api(`/builders/${seller.builderId}`, seller.session({ method: 'DELETE' }));
    expect(deleted.response.status).toBe(200);
    expect(deleted.body.releasedLandletIds).toEqual(['zero-bid-auction-seller-deleted-landlet']);

    // No bids existed to protect — the auction cascades away same as before.
    const auction = await api(`/auctions/${auctionId}`);
    expect(auction.response.status).toBe(404);

    const landlet = await api('/landlets/zero-bid-auction-seller-deleted-landlet');
    expect(landlet.body.landlet.status).toBe('greenbelt');
  });

  it('does not touch an unrelated active auction when a different builder is deleted', async () => {
    const seller = await signupBuilder('auction-unrelated-seller');
    const bidder = await signupBuilder('auction-unrelated-bidder');
    const bystander = await signupBuilder('auction-unrelated-bystander');
    await fundHiggles(bidder);
    await createGreenbeltLandlet('auction-unrelated-landlet');
    await api('/landlets/auction-unrelated-landlet/claim', seller.session({ method: 'POST' }));
    const started = await api('/landlets/auction-unrelated-landlet/auction', seller.session({
      method: 'POST', body: JSON.stringify({ startingBidCents: 0, durationHours: 1 }),
    }));
    const auctionId = started.body.auction.auctionId;
    await api(`/auctions/${auctionId}/bids`, bidder.session({
      method: 'POST', body: JSON.stringify({ amountCents: 500 }),
    }));

    const deleted = await api(`/builders/${bystander.builderId}`, bystander.session({ method: 'DELETE' }));
    expect(deleted.response.status).toBe(200);

    const auction = await api(`/auctions/${auctionId}`);
    expect(auction.body.auction.status).toBe('active');
  });

  // #263: without this guard, deleting the builder would cascade through
  // auction_bids.bidder_builder_id and silently erase a bid that was
  // actively deterring every other bidder from bidding — at zero cost,
  // since a fresh builder profile is auto-provisioned on the next request.
  it('rejects deleting a builder while they hold the leading bid on an active auction', async () => {
    const seller = await signupBuilder('leading-bid-seller');
    const bidder = await signupBuilder('leading-bid-bidder');
    await fundHiggles(bidder);
    await createGreenbeltLandlet('leading-bid-landlet');
    await api('/landlets/leading-bid-landlet/claim', seller.session({ method: 'POST' }));
    const started = await api('/landlets/leading-bid-landlet/auction', seller.session({
      method: 'POST', body: JSON.stringify({ startingBidCents: 0, durationHours: 1 }),
    }));
    const auctionId = started.body.auction.auctionId;
    await api(`/auctions/${auctionId}/bids`, bidder.session({
      method: 'POST', body: JSON.stringify({ amountCents: 500 }),
    }));

    const deleted = await api(`/builders/${bidder.builderId}`, bidder.session({ method: 'DELETE' }));
    expect(deleted.response.status).toBe(409);
    expect(deleted.body).toEqual({
      error: 'Cannot delete this builder while holding the leading bid on an active auction',
    });

    // Nothing was touched — the bid and the builder row both still exist.
    const bids = await api(`/auctions/${auctionId}/bids`);
    expect(bids.body.bids).toHaveLength(1);
    const stillThere = await env.DB.prepare('SELECT builder_id FROM builders WHERE builder_id = ?')
      .bind(bidder.builderId).first();
    expect(stillThere).not.toBeNull();
  });

  it('allows deleting a builder whose bid on an active auction has since been outbid', async () => {
    const seller = await signupBuilder('outbid-deletion-seller');
    const firstBidder = await signupBuilder('outbid-deletion-first-bidder');
    const secondBidder = await signupBuilder('outbid-deletion-second-bidder');
    await fundHiggles(firstBidder);
    await fundHiggles(secondBidder);
    await createGreenbeltLandlet('outbid-deletion-landlet');
    await api('/landlets/outbid-deletion-landlet/claim', seller.session({ method: 'POST' }));
    const started = await api('/landlets/outbid-deletion-landlet/auction', seller.session({
      method: 'POST', body: JSON.stringify({ startingBidCents: 0, durationHours: 1 }),
    }));
    const auctionId = started.body.auction.auctionId;
    await api(`/auctions/${auctionId}/bids`, firstBidder.session({
      method: 'POST', body: JSON.stringify({ amountCents: 500 }),
    }));
    await api(`/auctions/${auctionId}/bids`, secondBidder.session({
      method: 'POST', body: JSON.stringify({ amountCents: 1000 }),
    }));

    const deleted = await api(`/builders/${firstBidder.builderId}`, firstBidder.session({ method: 'DELETE' }));
    expect(deleted.response.status).toBe(200);

    // The auction itself, and the still-leading bidder, are unaffected.
    const bids = await api(`/auctions/${auctionId}/bids`);
    expect(bids.body.bids.map((b) => b.bidderBuilderId)).toEqual([secondBidder.builderId]);
  });

  it('allows deleting a builder whose leading bid was on an auction that already ended', async () => {
    const seller = await signupBuilder('ended-auction-deletion-seller');
    const bidder = await signupBuilder('ended-auction-deletion-bidder');
    await fundHiggles(bidder);
    await createGreenbeltLandlet('ended-auction-deletion-landlet');
    await api('/landlets/ended-auction-deletion-landlet/claim', seller.session({ method: 'POST' }));
    const started = await api('/landlets/ended-auction-deletion-landlet/auction', seller.session({
      method: 'POST', body: JSON.stringify({ startingBidCents: 0, durationHours: 1 }),
    }));
    const auctionId = started.body.auction.auctionId;
    await api(`/auctions/${auctionId}/bids`, bidder.session({
      method: 'POST', body: JSON.stringify({ amountCents: 500 }),
    }));
    await env.DB.prepare(`UPDATE auctions SET ends_at = '2000-01-01T00:00:00.000Z' WHERE auction_id = ?`).bind(auctionId).run();
    await api(`/auctions/${auctionId}/resolve`, { method: 'POST' });

    const deleted = await api(`/builders/${bidder.builderId}`, bidder.session({ method: 'DELETE' }));
    expect(deleted.response.status).toBe(200);
  });

  // Backlog audit: resolveAuction's own "active" -> "ended" status flip
  // commits as its own call, separately from the batch that actually
  // transfers the landlet/credits the seller a few lines later (see
  // resolveAuction's own comment in worker/index.js) — so there's a real
  // window where the row already reads status: 'ended' but the payout
  // hasn't landed yet. The two tests below manufacture that exact window
  // directly (flip the row the same way resolveAuction's own guard UPDATE
  // does, without running its payout batch) rather than relying on timing,
  // since it's otherwise a genuine race between two concurrent requests.
  it('rejects deleting the winning bidder while their win on an ended auction is still pending payout', async () => {
    const seller = await signupBuilder('pending-payout-bidder-seller');
    const bidder = await signupBuilder('pending-payout-bidder-bidder');
    await fundHiggles(bidder);
    await createGreenbeltLandlet('pending-payout-bidder-landlet');
    await api('/landlets/pending-payout-bidder-landlet/claim', seller.session({ method: 'POST' }));
    const started = await api('/landlets/pending-payout-bidder-landlet/auction', seller.session({
      method: 'POST', body: JSON.stringify({ startingBidCents: 0, durationHours: 1 }),
    }));
    const auctionId = started.body.auction.auctionId;
    await api(`/auctions/${auctionId}/bids`, bidder.session({
      method: 'POST', body: JSON.stringify({ amountCents: 500 }),
    }));
    const bidRow = await env.DB.prepare('SELECT bid_id FROM auction_bids WHERE auction_id = ?').bind(auctionId).first();
    // Same status flip resolveAuction's own guard UPDATE performs, without
    // its follow-up payout batch — the landlet is deliberately left owned
    // by the seller, exactly as it would be mid-race.
    await env.DB.prepare(`UPDATE auctions SET status = 'ended', winning_bid_id = ? WHERE auction_id = ?`)
      .bind(bidRow.bid_id, auctionId).run();

    const deleted = await api(`/builders/${bidder.builderId}`, bidder.session({ method: 'DELETE' }));
    expect(deleted.response.status).toBe(409);
    expect(deleted.body).toEqual({
      error: 'Cannot delete this builder while their auction win is still being paid out',
    });
    const stillThere = await env.DB.prepare('SELECT builder_id FROM builders WHERE builder_id = ?')
      .bind(bidder.builderId).first();
    expect(stillThere).not.toBeNull();

    // Once the transfer actually lands (landlet ownership reflects the
    // win), deletion is allowed again — same as the already-resolved case
    // above.
    await env.DB.prepare('UPDATE landlets SET owner_builder_id = ? WHERE landlet_id = ?')
      .bind(bidder.builderId, 'pending-payout-bidder-landlet').run();
    const deletedAfterPayout = await api(`/builders/${bidder.builderId}`, bidder.session({ method: 'DELETE' }));
    expect(deletedAfterPayout.response.status).toBe(200);
  });

  it('rejects deleting the seller while their sold-and-ended auction is still pending payout', async () => {
    const seller = await signupBuilder('pending-payout-seller-seller');
    const bidder = await signupBuilder('pending-payout-seller-bidder');
    await fundHiggles(bidder);
    await createGreenbeltLandlet('pending-payout-seller-landlet');
    await api('/landlets/pending-payout-seller-landlet/claim', seller.session({ method: 'POST' }));
    const started = await api('/landlets/pending-payout-seller-landlet/auction', seller.session({
      method: 'POST', body: JSON.stringify({ startingBidCents: 0, durationHours: 1 }),
    }));
    const auctionId = started.body.auction.auctionId;
    await api(`/auctions/${auctionId}/bids`, bidder.session({
      method: 'POST', body: JSON.stringify({ amountCents: 500 }),
    }));
    const bidRow = await env.DB.prepare('SELECT bid_id FROM auction_bids WHERE auction_id = ?').bind(auctionId).first();
    await env.DB.prepare(`UPDATE auctions SET status = 'ended', winning_bid_id = ? WHERE auction_id = ?`)
      .bind(bidRow.bid_id, auctionId).run();

    const deleted = await api(`/builders/${seller.builderId}`, seller.session({ method: 'DELETE' }));
    expect(deleted.response.status).toBe(409);
    expect(deleted.body).toEqual({
      error: 'Cannot delete this builder while their auction sale is still being paid out',
    });
    const stillThere = await env.DB.prepare('SELECT builder_id FROM builders WHERE builder_id = ?')
      .bind(seller.builderId).first();
    expect(stillThere).not.toBeNull();

    // Once the transfer actually lands, the seller no longer owns the
    // landlet — deletion is allowed again.
    await env.DB.prepare('UPDATE landlets SET owner_builder_id = ? WHERE landlet_id = ?')
      .bind(bidder.builderId, 'pending-payout-seller-landlet').run();
    const deletedAfterPayout = await api(`/builders/${seller.builderId}`, seller.session({ method: 'DELETE' }));
    expect(deletedAfterPayout.response.status).toBe(200);
  });

  // #279's guard has to catch a bid on *any* of a seller's active auctions,
  // not just a single one — this sets up two, with the bid on only the
  // second, to prove the check isn't limited to "their one auction."
  it('rejects deleting a builder when only one of their several active auctions has a bid', async () => {
    const seller = await signupBuilder('multi-auction-seller-deleted');
    const donor = await signupBuilder('multi-auction-donor');
    const bidder = await signupBuilder('multi-auction-bidder');
    await fundHiggles(seller);
    await fundHiggles(bidder);

    // A builder can only ever *claim* one greenbelt landlet directly, but
    // docs/SPEC.md §0/§5's auctions let them acquire additional
    // already-claimed land on top of that (see "resolves a winning
    // auction even when the bidder already owns a claimed landlet" above)
    // — so the seller ends up owning two landlets this way, the only way
    // one builder can ever be running more than one active auction at once.
    await createGreenbeltLandlet('multi-auction-landlet-a');
    await api('/landlets/multi-auction-landlet-a/claim', seller.session({ method: 'POST' }));
    await createGreenbeltLandlet('multi-auction-landlet-b');
    await api('/landlets/multi-auction-landlet-b/claim', donor.session({ method: 'POST' }));
    const donorAuction = await api('/landlets/multi-auction-landlet-b/auction', donor.session({
      method: 'POST', body: JSON.stringify({ startingBidCents: 0 }),
    }));
    const donorAuctionId = donorAuction.body.auction.auctionId;
    // The seller already owns landlet-a (their claimed starter), so
    // bidding on landlet-b too now needs land-cap headroom (#489) — this
    // test is about the multi-auction-ownership/delete-guard mechanics,
    // not the cap gate, so grant plenty of it via a real earnings event.
    await env.DB.prepare(`
      INSERT INTO higgles_earnings_events (event_id, builder_id, amount_cents) VALUES (?, ?, ?)
    `).bind(`headroom-${crypto.randomUUID()}`, seller.builderId, 100000000).run();
    await api('/builders');
    await api(`/auctions/${donorAuctionId}/bids`, seller.session({
      method: 'POST', body: JSON.stringify({ amountCents: 100 }),
    }));
    await env.DB.prepare(`UPDATE auctions SET ends_at = '2000-01-01T00:00:00.000Z' WHERE auction_id = ?`).bind(donorAuctionId).run();
    await api(`/auctions/${donorAuctionId}/resolve`, { method: 'POST' });
    const wonLandlet = await api('/landlets/multi-auction-landlet-b');
    expect(wonLandlet.body.landlet.ownerBuilderId).toBe(seller.builderId);

    const startedA = await api('/landlets/multi-auction-landlet-a/auction', seller.session({
      method: 'POST', body: JSON.stringify({ startingBidCents: 0, durationHours: 1 }),
    }));
    const startedB = await api('/landlets/multi-auction-landlet-b/auction', seller.session({
      method: 'POST', body: JSON.stringify({ startingBidCents: 0, durationHours: 1 }),
    }));
    const auctionIdB = startedB.body.auction.auctionId;

    // Only auction B gets a bid — auction A stays at zero.
    await api(`/auctions/${auctionIdB}/bids`, bidder.session({
      method: 'POST', body: JSON.stringify({ amountCents: 700 }),
    }));

    const deleted = await api(`/builders/${seller.builderId}`, seller.session({ method: 'DELETE' }));
    expect(deleted.response.status).toBe(409);
    expect(deleted.body).toEqual({ error: 'Cannot delete this builder while their own auction has bids' });

    // Nothing was touched, including auction A which never had a bid.
    const auctionAAfter = await api(`/auctions/${startedA.body.auction.auctionId}`);
    expect(auctionAAfter.body.auction.status).toBe('active');
    const auctionBAfter = await api(`/auctions/${auctionIdB}`);
    expect(auctionBAfter.body.auction.status).toBe('active');
  });

  it('assigns sequential pioneer ranks to successive first-time claimers', async () => {
    // Earlier tests in this file already claimed landlets, so some
    // builders very likely already hold ranks by this point — reset
    // directly via the DB (not exposed over the HTTP API on purpose; a
    // test-only escape hatch) so this test's own outcome is deterministic
    // regardless of execution order.
    await env.DB.prepare('UPDATE builders SET pioneer_rank = NULL').run();

    const first = await signupBuilder('first-claimer');
    const second = await signupBuilder('second-claimer');
    await createGreenbeltLandlet('pioneer-first-landlet');
    await createGreenbeltLandlet('pioneer-second-landlet');

    await api('/landlets/pioneer-first-landlet/claim', first.session({ method: 'POST' }));
    await api('/landlets/pioneer-second-landlet/claim', second.session({ method: 'POST' }));

    const list = await api('/builders');
    const firstAfter = list.body.builders.find((b) => b.builderId === first.builderId);
    const secondAfter = list.body.builders.find((b) => b.builderId === second.builderId);
    expect(firstAfter.isPioneer).toBe(true);
    expect(firstAfter.pioneerRank).toBe(1);
    expect(secondAfter.isPioneer).toBe(true);
    expect(secondAfter.pioneerRank).toBe(2);

    // A second claim (after releasing the first, so no rank was granted
    // the first time around) still gets one, since it's this builder's
    // first landing in the ranked cohort — the rule is "not yet ranked,"
    // not "this exact claim is chronologically their first ever."
    const third = await signupBuilder('third-claimer');
    await createGreenbeltLandlet('pioneer-third-landlet');
    await api('/landlets/pioneer-third-landlet/claim', third.session({ method: 'POST' }));
    const thirdList = await api('/builders');
    const thirdAfter = thirdList.body.builders.find((b) => b.builderId === third.builderId);
    expect(thirdAfter.pioneerRank).toBe(3);
  });

  it('stops assigning pioneer ranks once the founding cohort is full', async () => {
    await env.DB.prepare('UPDATE builders SET pioneer_rank = NULL').run();
    // Fill the cohort with throwaway rows directly via the DB — cheap and
    // exact, versus actually claiming 100 real landlets through the API.
    const fillerValues = Array.from({ length: 100 }, (_, i) => `('builder-cohort-filler-${i}', 'Filler ${i}', ${i + 1})`).join(', ');
    await env.DB.prepare(`INSERT INTO builders (builder_id, label, pioneer_rank) VALUES ${fillerValues}`).run();

    const late = await signupBuilder('late-claimer');
    await createGreenbeltLandlet('pioneer-late-landlet');
    const lateClaim = await api('/landlets/pioneer-late-landlet/claim', late.session({ method: 'POST' }));
    expect(lateClaim.response.status).toBe(200);

    const list = await api('/builders');
    const lateAfter = list.body.builders.find((b) => b.builderId === late.builderId);
    expect(lateAfter.isPioneer).toBe(false);
    expect(lateAfter.pioneerRank).toBeNull();
  });

  // Found via backlog audit (#362): unlike every other public, repeatable
  // mutation in this file, POST /api/builders (unauthenticated on purpose
  // — see that handler's own comment) had no rate limit and no length cap
  // on label at all.
  it('rejects a label over the length cap', async () => {
    const rejected = await api('/builders', {
      method: 'POST', body: JSON.stringify({ label: 'x'.repeat(101) }),
    });
    expect(rejected.response.status).toBe(400);
    expect(rejected.body.error).toMatch(/label must be 100 characters or fewer/);
  });

  // #479: the create path above already rejected an over-long label, but
  // the rename path used plain stringValue with no cap at all — a rename
  // call could set an arbitrarily long label regardless of what the
  // create-time cap allowed.
  it('rejects a rename to a label over the length cap', async () => {
    const renamer = await signupBuilder('rename-cap-builder');
    const rejected = await api(`/builders/${renamer.builderId}`, renamer.session({
      method: 'PATCH', body: JSON.stringify({ label: 'x'.repeat(101) }),
    }));
    expect(rejected.response.status).toBe(400);
    expect(rejected.body.error).toMatch(/label must be 100 characters or fewer/);

    const stillFine = await api(`/builders/${renamer.builderId}`, renamer.session({
      method: 'PATCH', body: JSON.stringify({ label: 'x'.repeat(100) }),
    }));
    expect(stillFine.response.status).toBe(200);
    expect(stillFine.body.builder.label).toBe('x'.repeat(100));
  });

  it('rate-limits repeated builder creation from the same client', async () => {
    const headers = { 'cf-connecting-ip': `test-${crypto.randomUUID()}` };
    for (let i = 0; i < 20; i++) {
      const attempt = await api('/builders', {
        method: 'POST', headers, body: JSON.stringify({ label: `Rate Limit Builder ${i}` }),
      });
      expect(attempt.response.status).not.toBe(429);
    }
    const limited = await api('/builders', {
      method: 'POST', headers, body: JSON.stringify({ label: 'One too many' }),
    });
    expect(limited.response.status).toBe(429);
  });
});

describe('Sellers', () => {
  it('creates a seller and rejects a label over the length cap', async () => {
    const created = await api('/sellers', { method: 'POST', body: JSON.stringify({ label: 'A Seller' }) });
    expect(created.response.status).toBe(201);
    expect(created.body.seller.label).toBe('A Seller');
    expect(created.body.seller.sellerId).toMatch(/^seller-/);

    const rejected = await api('/sellers', {
      method: 'POST', body: JSON.stringify({ label: 'x'.repeat(101) }),
    });
    expect(rejected.response.status).toBe(400);
    expect(rejected.body.error).toMatch(/label must be 100 characters or fewer/);
  });

  // #479: same gap as the builder-rename fix above — this seller-rename
  // path used plain stringValue with no upper bound, unlike this same
  // endpoint's own create path just above.
  it('renames a seller and rejects a rename over the length cap', async () => {
    const renamer = await signupSeller('rename-cap-seller');
    const renamed = await api(`/sellers/${renamer.sellerId}`, renamer.session({
      method: 'PATCH', body: JSON.stringify({ label: 'Renamed Seller' }),
    }));
    expect(renamed.response.status).toBe(200);
    expect(renamed.body.seller.label).toBe('Renamed Seller');

    const rejected = await api(`/sellers/${renamer.sellerId}`, renamer.session({
      method: 'PATCH', body: JSON.stringify({ label: 'x'.repeat(101) }),
    }));
    expect(rejected.response.status).toBe(400);
    expect(rejected.body.error).toMatch(/label must be 100 characters or fewer/);
  });

  it('rate-limits repeated seller creation from the same client', async () => {
    const headers = { 'cf-connecting-ip': `test-${crypto.randomUUID()}` };
    for (let i = 0; i < 20; i++) {
      const attempt = await api('/sellers', {
        method: 'POST', headers, body: JSON.stringify({ label: `Rate Limit Seller ${i}` }),
      });
      expect(attempt.response.status).not.toBe(429);
    }
    const limited = await api('/sellers', {
      method: 'POST', headers, body: JSON.stringify({ label: 'One too many' }),
    });
    expect(limited.response.status).toBe(429);
  });
});

describe('Catalog creation limits', () => {
  it('rejects name, category, subcategory, and color over the length cap', async () => {
    const base = {
      templateId: 'catalog-label-cap-template',
      color: '#111111',
      dimensions: { width: 1, depth: 1, height: 1 },
    };
    const overLongName = await api('/catalog', {
      method: 'POST', body: JSON.stringify({ ...base, name: 'x'.repeat(101) }),
    });
    expect(overLongName.response.status).toBe(400);
    expect(overLongName.body.error).toMatch(/name must be 100 characters or fewer/);

    const overLongCategory = await api('/catalog', {
      method: 'POST', body: JSON.stringify({ ...base, name: 'Fine Name', category: 'x'.repeat(101) }),
    });
    expect(overLongCategory.response.status).toBe(400);
    expect(overLongCategory.body.error).toMatch(/category must be 100 characters or fewer/);

    const overLongSubcategory = await api('/catalog', {
      method: 'POST', body: JSON.stringify({ ...base, name: 'Fine Name', subcategory: 'x'.repeat(101) }),
    });
    expect(overLongSubcategory.response.status).toBe(400);
    expect(overLongSubcategory.body.error).toMatch(/subcategory must be 100 characters or fewer/);

    const overLongColor = await api('/catalog', {
      method: 'POST', body: JSON.stringify({ ...base, name: 'Fine Name', color: 'x'.repeat(101) }),
    });
    expect(overLongColor.response.status).toBe(400);
    expect(overLongColor.body.error).toMatch(/color must be 100 characters or fewer/);
  });
});

describe('Notifications', () => {
  async function claim(landletId, builder) {
    return api(`/landlets/${landletId}/claim`, builder.session({ method: 'POST' }));
  }

  // `suffix` keeps each call's builder usernames and landlet id unique —
  // signupBuilder's username comes straight from its label argument (no
  // randomization of its own, unlike its generated email), so two calls
  // with the same label from different tests would collide on the
  // uniqueness check the Authentication describe block covers elsewhere.
  async function seedNotifications(suffix) {
    const owner = await signupBuilder(`notif-owner-${suffix}`);
    const bidder = await signupBuilder(`notif-bidder-${suffix}`);
    await fundHiggles(bidder);
    const landletId = `notif-landlet-${suffix}`;
    await createGreenbeltLandlet(landletId);
    await claim(landletId, owner);
    const started = await api(`/landlets/${landletId}/auction`, owner.session({
      method: 'POST', body: JSON.stringify({ startingBidCents: 0, durationHours: 1 }),
    }));
    // Two bids: the owner is notified of each, giving this describe block
    // two of its own notifications to read/mark/filter without touching
    // any other test's data.
    await api(`/auctions/${started.body.auction.auctionId}/bids`, bidder.session({
      method: 'POST', body: JSON.stringify({ amountCents: 500 }),
    }));
    await api(`/auctions/${started.body.auction.auctionId}/bids`, bidder.session({
      method: 'POST', body: JSON.stringify({ amountCents: 1000 }),
    }));
    return { owner, bidder, auctionId: started.body.auction.auctionId };
  }

  it('lists only the session builder\'s own notifications, newest first', async () => {
    const { owner, bidder } = await seedNotifications('list');
    const ownerNotices = await api('/notifications', owner.session());
    expect(ownerNotices.body.notifications.length).toBeGreaterThanOrEqual(2);
    expect(ownerNotices.body.notifications.every((n) => n.builderId === owner.builderId)).toBe(true);
    const [first, second] = ownerNotices.body.notifications;
    expect(new Date(first.createdAt).getTime()).toBeGreaterThanOrEqual(new Date(second.createdAt).getTime());

    const bidderNotices = await api('/notifications', bidder.session());
    expect(bidderNotices.body.notifications).toHaveLength(0);
  });

  // Issue #320: the list was hardcoded to LIMIT 100 with no way to page
  // further — a builder with more notifications than that could never see
  // or individually mark read anything older than the newest 100.
  it('paginates the notifications list via cursor, newest first, with no gaps or duplicates', async () => {
    const owner = await signupBuilder('notif-page-owner');
    const bidder = await signupBuilder('notif-page-bidder');
    await fundHiggles(bidder);
    const landletId = 'notif-page-landlet';
    await createGreenbeltLandlet(landletId);
    await claim(landletId, owner);
    const started = await api(`/landlets/${landletId}/auction`, owner.session({
      method: 'POST', body: JSON.stringify({ startingBidCents: 0, durationHours: 1 }),
    }));
    // Three strictly increasing bids — three separate bid notifications
    // for the owner, enough to exercise a limit=1 page boundary twice.
    for (const amountCents of [500, 1000, 1500]) {
      await api(`/auctions/${started.body.auction.auctionId}/bids`, bidder.session({
        method: 'POST', body: JSON.stringify({ amountCents }),
      }));
    }
    const whole = await api('/notifications', owner.session());
    expect(whole.body.notifications.length).toBeGreaterThanOrEqual(3);
    expect(whole.body.nextCursor).toBeNull(); // under the default limit — nothing more to page to

    const seenIds = [];
    let cursor = null;
    for (let i = 0; i < whole.body.notifications.length; i++) {
      const page = await api(
        `/notifications?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        owner.session(),
      );
      expect(page.body.notifications).toHaveLength(1);
      seenIds.push(page.body.notifications[0].notificationId);
      cursor = page.body.nextCursor;
    }
    expect(cursor).toBeNull(); // exhausted after exactly as many pages as there are rows
    expect(seenIds).toEqual(whole.body.notifications.map((n) => n.notificationId)); // same order, one row at a time

    const invalidCursor = await api('/notifications?cursor=not-base64', owner.session());
    expect(invalidCursor.response.status).toBe(400);
    expect(invalidCursor.body).toEqual({ error: 'cursor is invalid' });
  });

  it('rejects listing another builder\'s notifications via a spoofed builderId', async () => {
    const { owner, bidder } = await seedNotifications('spoof');
    const spoofed = await api(`/notifications?builderId=${owner.builderId}`, bidder.session());
    expect(spoofed.response.status).toBe(403);
  });

  it('filters to unread-only when requested', async () => {
    const { owner } = await seedNotifications('unread-filter');
    const all = await api('/notifications', owner.session());
    expect(all.body.notifications.length).toBeGreaterThanOrEqual(2);
    await api(`/notifications/${all.body.notifications[0].notificationId}`, owner.session({
      method: 'PATCH', body: JSON.stringify({ read: true }),
    }));
    const unread = await api('/notifications?unreadOnly=true', owner.session());
    expect(unread.body.notifications.some((n) => n.notificationId === all.body.notifications[0].notificationId)).toBe(false);
    expect(unread.body.notifications.length).toBe(all.body.notifications.length - 1);
  });

  it('marks a single notification read, and 404s a nonexistent one', async () => {
    const { owner } = await seedNotifications('mark-single');
    const before = await api('/notifications', owner.session());
    const target = before.body.notifications[0];
    expect(target.readAt).toBeNull();

    const patched = await api(`/notifications/${target.notificationId}`, owner.session({
      method: 'PATCH', body: JSON.stringify({ read: true }),
    }));
    expect(patched.response.status).toBe(200);
    expect(patched.body.notification.readAt).not.toBeNull();

    const missing = await api('/notifications/notification-does-not-exist', owner.session({
      method: 'PATCH', body: JSON.stringify({ read: true }),
    }));
    expect(missing.response.status).toBe(404);
  });

  it('rejects marking another builder\'s notification read', async () => {
    const { owner, bidder } = await seedNotifications('mark-others');
    const ownerNotices = await api('/notifications', owner.session());
    const targetId = ownerNotices.body.notifications[0].notificationId;
    const asBidder = await api(`/notifications/${targetId}`, bidder.session({
      method: 'PATCH', body: JSON.stringify({ read: true }),
    }));
    expect(asBidder.response.status).toBe(403);
  });

  it('marks only the session builder\'s own unread notifications read via mark-all-read', async () => {
    const { owner, bidder, auctionId } = await seedNotifications('mark-all');
    const marked = await api('/notifications/mark-all-read', owner.session({ method: 'POST' }));
    expect(marked.response.status).toBe(200);
    expect(marked.body).toEqual({ ok: true });

    const ownerAfter = await api('/notifications?unreadOnly=true', owner.session());
    expect(ownerAfter.body.notifications).toHaveLength(0);

    // A third bid, notifying the owner again, proves mark-all-read didn't
    // touch anything belonging to the bidder (who had zero notifications
    // to begin with) or otherwise break future notifications from firing.
    await api(`/auctions/${auctionId}/bids`, bidder.session({
      method: 'POST', body: JSON.stringify({ amountCents: 1500 }),
    }));
    const ownerAfterNewBid = await api('/notifications?unreadOnly=true', owner.session());
    expect(ownerAfterNewBid.body.notifications).toHaveLength(1);
  });

  // Found via backlog audit: GET /notifications has no pagination, just a
  // flat LIMIT 100 — fine for the history list, but the unread badge used
  // to read straight off that capped list's own length
  // (refreshNotificationsBadge in src/main.js), silently undercounting
  // once a builder passed 100 unread (e.g. a popular auction's worth of
  // bid notifications). unread-count is a dedicated COUNT query instead.
  it('reports the true unread count past the notifications list\'s own 100-row cap', async () => {
    const owner = await signupBuilder('notif-count-owner');
    const statements = Array.from({ length: 105 }, (_, i) =>
      env.DB.prepare('INSERT INTO notifications (notification_id, builder_id, message) VALUES (?, ?, ?)')
        .bind(`notif-count-${i}`, owner.builderId, `Test notification ${i}`));
    await env.DB.batch(statements);

    const listed = await api('/notifications?unreadOnly=true', owner.session());
    expect(listed.body.notifications).toHaveLength(100);

    const count = await api('/notifications/unread-count', owner.session());
    expect(count.response.status).toBe(200);
    expect(count.body).toEqual({ count: 105 });

    // Marking one read drops the true count but not below what the capped
    // list alone could ever have shown.
    await api(`/notifications/notif-count-0`, owner.session({
      method: 'PATCH', body: JSON.stringify({ read: true }),
    }));
    const countAfter = await api('/notifications/unread-count', owner.session());
    expect(countAfter.body).toEqual({ count: 104 });
  });

  it('requires a session for unread-count and never counts another builder\'s notifications', async () => {
    const { owner } = await seedNotifications('unread-count-auth');
    const unauthenticated = await api('/notifications/unread-count');
    expect(unauthenticated.response.status).toBe(401);

    const other = await signupBuilder('notif-count-other');
    const otherCount = await api('/notifications/unread-count', other.session());
    expect(otherCount.body).toEqual({ count: 0 });

    const ownerCount = await api('/notifications/unread-count', owner.session());
    expect(ownerCount.body.count).toBeGreaterThanOrEqual(2);
  });
});

describe('Friendships', () => {
  async function claim(landletId, builder) {
    return api(`/landlets/${landletId}/claim`, builder.session({ method: 'POST' }));
  }

  it('rejects a request between a builder and themselves', async () => {
    const solo = await signupBuilder('friendship-solo');
    const rejected = await api('/friendships', solo.session({
      method: 'POST', body: JSON.stringify({ recipientBuilderId: solo.builderId }),
    }));
    expect(rejected.response.status).toBe(400);
  });

  it('rejects a request referencing a builder that does not exist', async () => {
    const real = await signupBuilder('friendship-real');
    const rejected = await api('/friendships', real.session({
      method: 'POST', body: JSON.stringify({ recipientBuilderId: 'builder-does-not-exist' }),
    }));
    expect(rejected.response.status).toBe(400);
  });

  it('sends, lists (with direction), accepts, and shows the accepted friend on both sides', async () => {
    const alice = await signupBuilder('friendship-alice');
    const bob = await signupBuilder('friendship-bob');
    await createGreenbeltLandlet('friendship-bob-landlet');
    await claim('friendship-bob-landlet', bob);

    const sent = await api('/friendships', alice.session({
      method: 'POST', body: JSON.stringify({ recipientBuilderId: bob.builderId }),
    }));
    expect(sent.response.status).toBe(201);
    expect(sent.body.friendship).toMatchObject({
      requesterBuilderId: alice.builderId,
      recipientBuilderId: bob.builderId,
      status: 'pending',
      otherBuilderId: bob.builderId,
      otherLabel: 'friendship-bob',
      direction: 'outgoing',
    });
    const friendshipId = sent.body.friendship.friendshipId;

    // Found via backlog audit (#319): a new request/its acceptance had no
    // passive way to reach the other side.
    const bobNoticesAfterRequest = await api('/notifications', bob.session());
    expect(bobNoticesAfterRequest.body.notifications.some(
      (n) => n.message === 'friendship-alice sent you a friend request.')).toBe(true);

    // Alice's own list shows it outgoing; Bob's shows the same row incoming.
    const aliceList = await api('/friendships', alice.session());
    expect(aliceList.body.friendships).toHaveLength(1);
    expect(aliceList.body.friendships[0].direction).toBe('outgoing');
    expect(aliceList.body.friendships[0].status).toBe('pending');
    // #610 (owner): a pending request shouldn't hand either side a
    // shortcut straight to the other's lándlet before they've actually
    // agreed to connect — Bob already claimed one above, but it stays
    // hidden from Alice's view of this still-pending request.
    expect(aliceList.body.friendships[0].otherLandlet).toBeNull();

    const bobList = await api('/friendships', bob.session());
    expect(bobList.body.friendships).toHaveLength(1);
    expect(bobList.body.friendships[0].direction).toBe('incoming');
    expect(bobList.body.friendships[0].otherLabel).toBe('friendship-alice');
    // Bob hasn't claimed anything yet at this point in the test — Alice
    // (the one being looked up from Bob's list) has no lándlet.
    expect(bobList.body.friendships[0].otherLandlet).toBeNull();

    // Only the recipient (Bob) can accept.
    const acceptedByRequester = await api(`/friendships/${friendshipId}`, alice.session({
      method: 'PATCH', body: JSON.stringify({ status: 'accepted' }),
    }));
    expect(acceptedByRequester.response.status).toBe(403);

    const accepted = await api(`/friendships/${friendshipId}`, bob.session({
      method: 'PATCH', body: JSON.stringify({ status: 'accepted' }),
    }));
    expect(accepted.response.status).toBe(200);
    expect(accepted.body.friendship.status).toBe('accepted');

    const aliceNoticesAfterAccept = await api('/notifications', alice.session());
    expect(aliceNoticesAfterAccept.body.notifications.some(
      (n) => n.message === 'friendship-bob accepted your friend request.')).toBe(true);

    // From Alice's side, the "approximate location" is Bob's claimed lándlet.
    const aliceListAfter = await api('/friendships', alice.session());
    expect(aliceListAfter.body.friendships[0].status).toBe('accepted');
    expect(aliceListAfter.body.friendships[0].otherLandlet).toMatchObject({
      landletId: 'friendship-bob-landlet',
    });
  });

  // #369: the existing-pair 409 guard only blocks a repeat against the
  // *same* recipient, so nothing stopped one account cycling through fresh
  // recipients to spam friend-request notifications with no limit at all.
  it('rate-limits repeated friend requests from the same builder, even against different recipients', async () => {
    const requester = await signupBuilder('friendship-rate-limit-requester');
    for (let i = 0; i < 20; i++) {
      const recipient = await signupBuilder(`friendship-rate-limit-recipient-${i}`);
      const attempt = await api('/friendships', requester.session({
        method: 'POST', body: JSON.stringify({ recipientBuilderId: recipient.builderId }),
      }));
      expect(attempt.response.status).not.toBe(429);
    }
    const oneMore = await signupBuilder('friendship-rate-limit-recipient-one-more');
    const limited = await api('/friendships', requester.session({
      method: 'POST', body: JSON.stringify({ recipientBuilderId: oneMore.builderId }),
    }));
    expect(limited.response.status).toBe(429);
  }, 45000); // 21 real signups (password hashing each time) plus 21 POSTs
  // reliably finishes well under 20s in isolation, but the same
  // scheduling-contention flake documented on the purchase rate-limit
  // test below (this whole file, 300+ tests, one process) applies here too
  // — matching its timeout rather than re-discovering the same flake.

  // #353: the accept UPDATE previously matched regardless of the row's
  // current status, so re-PATCHing an already-accepted friendship kept
  // re-sending the requester a duplicate notification with no limit.
  it('does not re-send a notification (or error) when accepting an already-accepted friendship', async () => {
    const alice = await signupBuilder('friendship-reaccept-alice');
    const bob = await signupBuilder('friendship-reaccept-bob');
    const sent = await api('/friendships', alice.session({
      method: 'POST', body: JSON.stringify({ recipientBuilderId: bob.builderId }),
    }));
    const friendshipId = sent.body.friendship.friendshipId;

    const firstAccept = await api(`/friendships/${friendshipId}`, bob.session({
      method: 'PATCH', body: JSON.stringify({ status: 'accepted' }),
    }));
    expect(firstAccept.response.status).toBe(200);
    expect(firstAccept.body.friendship.status).toBe('accepted');

    for (let i = 0; i < 4; i += 1) {
      const reaccept = await api(`/friendships/${friendshipId}`, bob.session({
        method: 'PATCH', body: JSON.stringify({ status: 'accepted' }),
      }));
      expect(reaccept.response.status).toBe(200);
      expect(reaccept.body.friendship.status).toBe('accepted');
    }

    const aliceNotices = await api('/notifications', alice.session());
    const acceptNotices = aliceNotices.body.notifications.filter(
      (n) => n.message === 'friendship-reaccept-bob accepted your friend request.',
    );
    expect(acceptNotices).toHaveLength(1);
  });

  it('rejects a second request between the same pair in either direction', async () => {
    const a = await signupBuilder('friendship-duplicate-a');
    const b = await signupBuilder('friendship-duplicate-b');
    await api('/friendships', a.session({ method: 'POST', body: JSON.stringify({ recipientBuilderId: b.builderId }) }));

    const sameDirection = await api('/friendships', a.session({
      method: 'POST', body: JSON.stringify({ recipientBuilderId: b.builderId }),
    }));
    expect(sameDirection.response.status).toBe(409);

    const reverseDirection = await api('/friendships', b.session({
      method: 'POST', body: JSON.stringify({ recipientBuilderId: a.builderId }),
    }));
    expect(reverseDirection.response.status).toBe(409);
  });

  it('accepts only one of two concurrent requests between the same pair, not both', async () => {
    const a = await signupBuilder('friendship-race-a');
    const b = await signupBuilder('friendship-race-b');

    // Fired together, not awaited one at a time — a read-then-insert
    // implementation could let both requests read "no existing friendship",
    // both pass the check, and both land as separate rows for the same
    // unordered pair, even though only one should ever exist (#259).
    const [first, second] = await Promise.all([
      api('/friendships', a.session({ method: 'POST', body: JSON.stringify({ recipientBuilderId: b.builderId }) })),
      api('/friendships', b.session({ method: 'POST', body: JSON.stringify({ recipientBuilderId: a.builderId }) })),
    ]);
    expect([first.response.status, second.response.status].sort()).toEqual([201, 409]);

    const aList = await api('/friendships', a.session());
    expect(aList.body.friendships).toHaveLength(1);
  });

  it('lets a request be declined (deleted while pending) or an accepted friendship removed', async () => {
    const a = await signupBuilder('friendship-decline-a');
    const b = await signupBuilder('friendship-decline-b');
    const sent = await api('/friendships', a.session({
      method: 'POST', body: JSON.stringify({ recipientBuilderId: b.builderId }),
    }));
    const friendshipId = sent.body.friendship.friendshipId;

    // Either party can decline/cancel a pending request — exercise the
    // recipient's side here since the requester's is covered by "resent".
    const declined = await api(`/friendships/${friendshipId}`, b.session({ method: 'DELETE' }));
    expect(declined.response.status).toBe(200);
    expect(declined.body).toEqual({ deleted: true });

    // Declining frees the pair up to request again — proves the DELETE
    // really removed the row rather than just marking it something else.
    const resent = await api('/friendships', a.session({
      method: 'POST', body: JSON.stringify({ recipientBuilderId: b.builderId }),
    }));
    expect(resent.response.status).toBe(201);

    // The lookup for a nonexistent friendship 404s before any ownership
    // check, so these stay unauthenticated on purpose.
    const deleteMissing = await api('/friendships/friendship-does-not-exist', { method: 'DELETE' });
    expect(deleteMissing.response.status).toBe(404);

    const patchMissing = await api('/friendships/friendship-does-not-exist', {
      method: 'PATCH', body: JSON.stringify({ status: 'accepted' }),
    });
    expect(patchMissing.response.status).toBe(404);
  });

  it('rejects an invalid status transition', async () => {
    const a = await signupBuilder('friendship-invalid-status-a');
    const b = await signupBuilder('friendship-invalid-status-b');
    const sent = await api('/friendships', a.session({
      method: 'POST', body: JSON.stringify({ recipientBuilderId: b.builderId }),
    }));
    // Must be the recipient to get past the ownership check to the status
    // validation this test is actually about.
    const rejected = await api(`/friendships/${sent.body.friendship.friendshipId}`, b.session({
      method: 'PATCH', body: JSON.stringify({ status: 'pending' }),
    }));
    expect(rejected.response.status).toBe(400);
  });
});
