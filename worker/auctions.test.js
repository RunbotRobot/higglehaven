import {
  applyD1Migrations, env, createExecutionContext, createScheduledController, waitOnExecutionContext,
} from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import worker, {
  auctionSettlementEventId, warnInactiveLandletOwners,
} from './index.js';
import {
  api, signupBuilder, signupAdmin, createGreenbeltLandletAs,
} from './test-helpers.js';

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

  // #629: bidding now requires the bidder to actually hold enough
  // higgles_balance_cents to cover the bid (see handleAuctionBids/
  // resolveAuction in worker/index.js) — a fresh signupBuilder() starts at
  // 0, so every test below that places a real bid funds its bidder first.
  // A flat, generous default (== MAX_MONEY_CENTS) covers every bid amount
  // used in this file, including the at-cap boundary test; it SETs an
  // absolute balance (not additive), matching stripe-connect.test.js's own
  // creditHiggles helper.
  async function fundHiggles(builder, amountCents = 100_000_000) {
    await env.DB.prepare('UPDATE builders SET higgles_balance_cents = ? WHERE builder_id = ?')
      .bind(amountCents, builder.builderId).run();
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

  // #886: unlike every other authenticated, row-creating, repeatable POST
  // endpoint in this file, starting an auction had no rate limit at all.
  // Pre-seeding rate_limit_events directly rather than looping 20 real
  // auction starts keeps this fast and sidesteps the "one active auction
  // per landlet" invariant entirely -- same approach as the instance-write
  // and self-claim rate-limit tests' own direct table access.
  it('rate-limits repeated auction starts from the same builder', async () => {
    const owner = await signupBuilder('auction-start-rate-limit-owner');
    await createGreenbeltLandlet('auction-start-rate-limit-landlet');
    await claim('auction-start-rate-limit-landlet', owner);

    const bucketKey = `auction-start:${owner.builderId}`;
    const now = Date.now();
    await env.DB.batch(Array.from({ length: 19 }, () => env.DB.prepare(
      'INSERT INTO rate_limit_events (bucket_key, created_at) VALUES (?, ?)',
    ).bind(bucketKey, now)));

    const atLimit = await api('/landlets/auction-start-rate-limit-landlet/auction', owner.session({
      method: 'POST', body: JSON.stringify({}),
    }));
    expect(atLimit.response.status).toBe(201);

    const limited = await api('/landlets/auction-start-rate-limit-landlet/auction', owner.session({
      method: 'POST', body: JSON.stringify({}),
    }));
    expect(limited.response.status).toBe(429);
  });

  // #1290: unlike the auction-start POST above (and virtually every other
  // notification-firing mutation in this file -- friend requests/friendship
  // mutations, bundle mutations, catalog PATCHes), placing a bid itself had
  // no rate limit at all, despite notifyOfNewBid unconditionally notifying
  // the seller (and the previous high bidder, on an outbid) on every call.
  // Same pre-seeded-table approach as the auction-start test above --
  // sidesteps looping 20 real bids (each needing a strictly higher amount
  // than the last) just to prove the limiter itself fires.
  it('rate-limits repeated bids from the same builder', async () => {
    const owner = await signupBuilder('auction-bid-rate-limit-owner');
    const bidder = await signupBuilder('auction-bid-rate-limit-bidder');
    await fundHiggles(bidder);
    await createGreenbeltLandlet('auction-bid-rate-limit-landlet');
    await claim('auction-bid-rate-limit-landlet', owner);
    const started = await api('/landlets/auction-bid-rate-limit-landlet/auction', owner.session({
      method: 'POST', body: JSON.stringify({}),
    }));
    const auctionId = started.body.auction.auctionId;

    const bucketKey = `auction-bid:${bidder.builderId}`;
    const now = Date.now();
    await env.DB.batch(Array.from({ length: 19 }, () => env.DB.prepare(
      'INSERT INTO rate_limit_events (bucket_key, created_at) VALUES (?, ?)',
    ).bind(bucketKey, now)));

    const atLimit = await api(`/auctions/${auctionId}/bids`, bidder.session({
      method: 'POST', body: JSON.stringify({ amountCents: 100 }),
    }));
    expect(atLimit.response.status).toBe(201);

    const limited = await api(`/auctions/${auctionId}/bids`, bidder.session({
      method: 'POST', body: JSON.stringify({ amountCents: 200 }),
    }));
    expect(limited.response.status).toBe(429);
  });

  // #1741: unlike every other write-triggering endpoint on this resource
  // (auction-start above, bids above), the single-item GET and POST
  // .../resolve had no rate limit at all, despite resolveAuctionIfDue being
  // able to credit a real higgles balance, transfer land ownership, and fire
  // notifications to both parties the first time an ended auction is
  // observed. Both branches are unauthenticated, so this is IP-keyed (same
  // shape as EVENT_TRIGGER_RATE_LIMIT_MAX's own bucket) rather than
  // builder-keyed like auction-start/bids above — same pre-seeded-table
  // approach those tests use.
  it('rate-limits repeated single-item GET and POST .../resolve calls from the same IP', async () => {
    const owner = await signupBuilder('auction-resolve-rate-limit-owner');
    await createGreenbeltLandlet('auction-resolve-rate-limit-landlet');
    await claim('auction-resolve-rate-limit-landlet', owner);
    const started = await api('/landlets/auction-resolve-rate-limit-landlet/auction', owner.session({
      method: 'POST', body: JSON.stringify({}),
    }));
    const auctionId = started.body.auction.auctionId;

    const ip = `test-${crypto.randomUUID()}`;
    const bucketKey = `auction-resolve:${ip}`;
    const now = Date.now();
    await env.DB.batch(Array.from({ length: 19 }, () => env.DB.prepare(
      'INSERT INTO rate_limit_events (bucket_key, created_at) VALUES (?, ?)',
    ).bind(bucketKey, now)));

    const atLimit = await api(`/auctions/${auctionId}`, { headers: { 'cf-connecting-ip': ip } });
    expect(atLimit.response.status).toBe(200);

    const limitedGet = await api(`/auctions/${auctionId}`, { headers: { 'cf-connecting-ip': ip } });
    expect(limitedGet.response.status).toBe(429);

    const limitedResolve = await api(`/auctions/${auctionId}/resolve`, {
      method: 'POST', headers: { 'cf-connecting-ip': ip },
    });
    expect(limitedResolve.response.status).toBe(429);
  });

  // #1790: the list endpoint runs the same resolve-sweep as the single-item
  // GET/POST .../resolve branches above (just batched over up to
  // AUCTION_SWEEP_LIMIT auctions instead of one), but was missing a guard —
  // its own separate, more generous bucket/limit (auction-list, not
  // auction-resolve), since it's hit on every full Settings redraw while
  // the Build tab's auction section is showing, not just a rare explicit
  // resolve trigger.
  it('rate-limits repeated list calls from the same IP', async () => {
    const ip = `test-${crypto.randomUUID()}`;
    const bucketKey = `auction-list:${ip}`;
    const now = Date.now();
    await env.DB.batch(Array.from({ length: 199 }, () => env.DB.prepare(
      'INSERT INTO rate_limit_events (bucket_key, created_at) VALUES (?, ?)',
    ).bind(bucketKey, now)));

    const atLimit = await api('/auctions', { headers: { 'cf-connecting-ip': ip } });
    expect(atLimit.response.status).toBe(200);

    const limited = await api('/auctions', { headers: { 'cf-connecting-ip': ip } });
    expect(limited.response.status).toBe(429);
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
    await fundHiggles(bidder);
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
    await fundHiggles(bidderA);
    await fundHiggles(bidderB);
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
    expect(bids.body.totalCount).toBe(2);
  });

  it('accepts only one of two concurrent bids for the same amount, not both', async () => {
    const owner = await signupBuilder('bid-race-owner');
    const bidderA = await signupBuilder('bid-race-a');
    const bidderB = await signupBuilder('bid-race-b');
    await fundHiggles(bidderA);
    await fundHiggles(bidderB);
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

  // #1275: GET .../bids used to return only the capped `bids` array with no
  // way to tell it had been truncated at all -- same count-vs-length shape
  // already fixed for sign posts/calendar events (#356). Seeds 205 bids
  // directly via the DB (bypassing the increasing-bid rule, which isn't
  // what this test is about) so the cap actually bites.
  it('reports the true bid count past the list\'s own 200-row cap', async () => {
    const owner = await signupBuilder('bid-past-cap-owner');
    const bidder = await signupBuilder('bid-past-cap-bidder');
    await createGreenbeltLandlet('auction-bid-past-cap-landlet');
    await claim('auction-bid-past-cap-landlet', owner);
    const started = await api('/landlets/auction-bid-past-cap-landlet/auction', owner.session({
      method: 'POST', body: JSON.stringify({ startingBidCents: 0 }),
    }));
    const auctionId = started.body.auction.auctionId;

    const statements = Array.from({ length: 205 }, (_, i) =>
      env.DB.prepare(`
        INSERT INTO auction_bids (bid_id, auction_id, bidder_builder_id, amount_cents) VALUES (?, ?, ?, ?)
      `).bind(`bid-past-cap-${i}`, auctionId, bidder.builderId, i + 1));
    await env.DB.batch(statements);

    const bids = await api(`/auctions/${auctionId}/bids`);
    expect(bids.body.bids).toHaveLength(200);
    expect(bids.body.totalCount).toBe(205);
    // Highest-amount-first (ORDER BY amount_cents DESC) was already correct
    // pre-#1275 -- this fix is only about exposing totalCount, not about
    // which 200 rows survive the cap.
    expect(bids.body.bids[0].amountCents).toBe(205);
    expect(bids.body.bids[199].amountCents).toBe(6);
  });

  it('resolves a winning auction: ownership transfers, build clears, seller is paid in higgles', async () => {
    const owner = await signupBuilder('resolve-winner-owner');
    const bidder = await signupBuilder('resolve-winner-bidder');
    await fundHiggles(bidder);
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

    const sellerAfter = await api('/builders/me', owner.session());
    expect(sellerAfter.body.builder.higglesBalanceCents).toBe(2500);

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
    const sellerAfterSecondResolve = await api('/builders/me', owner.session());
    expect(sellerAfterSecondResolve.body.builder.higglesBalanceCents).toBe(2500);
    const earningsCount = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM higgles_earnings_events WHERE builder_id = ?',
    ).bind(owner.builderId).first();
    expect(earningsCount.n).toBe(1);
  });

  // #875: resolveAuction used to transfer ownership and debit the winner's
  // balance as one standalone write, then defer crediting the seller,
  // recording winningBidId, and clearing the old owner's build content into
  // a later, unrelated db.batch call — a Worker interruption between the two
  // left the land transferred with the seller never paid and the build never
  // cleared, and no retry could ever notice (the resolve guard only re-fires
  // while status is still 'active'). This reproduces exactly that stuck
  // state by hand (can't actually kill the Worker mid-request from a test),
  // then confirms the next /resolve call resumes and completes it instead of
  // silently no-opping forever.
  it('resumes a resolution stuck between the ownership transfer and settlement, instead of leaving it stranded', async () => {
    const owner = await signupBuilder('resolve-resume-owner');
    const bidder = await signupBuilder('resolve-resume-bidder');
    await fundHiggles(bidder);
    await createGreenbeltLandlet('auction-resolve-resume-landlet');
    await claim('auction-resolve-resume-landlet', owner);
    await api('/instances', owner.session({
      method: 'POST',
      body: JSON.stringify({ landletId: 'auction-resolve-resume-landlet', templateId: 'placeholder-tree', x: 1, y: 1 }),
    }));
    const started = await api('/landlets/auction-resolve-resume-landlet/auction', owner.session({
      method: 'POST', body: JSON.stringify({ startingBidCents: 0 }),
    }));
    const auctionId = started.body.auction.auctionId;
    const placedBid = await api(`/auctions/${auctionId}/bids`, bidder.session({
      method: 'POST', body: JSON.stringify({ amountCents: 3000 }),
    }));
    const bidId = placedBid.body.bid.bidId;
    await env.DB.prepare(`UPDATE auctions SET ends_at = '2000-01-01T00:00:00.000Z' WHERE auction_id = ?`).bind(auctionId).run();

    // Hand-reproduce exactly what the atomic transfer+winningBidId batch
    // (worker/index.js's resolveAuction) leaves committed, without ever
    // running the settlement batch that's supposed to follow it.
    await env.DB.prepare('UPDATE builders SET higgles_balance_cents = higgles_balance_cents - ? WHERE builder_id = ?')
      .bind(3000, bidder.builderId).run();
    await env.DB.prepare(`UPDATE landlets SET owner_builder_id = ?, active_version_id = NULL WHERE landlet_id = ?`)
      .bind(bidder.builderId, 'auction-resolve-resume-landlet').run();
    await env.DB.prepare(`UPDATE auctions SET status = 'ended', winning_bid_id = ? WHERE auction_id = ?`)
      .bind(bidId, auctionId).run();

    // Confirm the stuck state actually looks stuck before resuming it.
    const stuckSeller = await api('/builders/me', owner.session());
    expect(stuckSeller.body.builder.higglesBalanceCents).toBe(0);
    const stuckInstances = await api('/instances?landletId=auction-resolve-resume-landlet');
    expect(stuckInstances.body.instances).not.toEqual([]);
    const stuckEarnings = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM higgles_earnings_events WHERE event_id = ?',
    ).bind(auctionSettlementEventId(auctionId)).first();
    expect(stuckEarnings.n).toBe(0);

    const resumed = await api(`/auctions/${auctionId}/resolve`, { method: 'POST' });
    expect(resumed.response.status).toBe(200);
    expect(resumed.body.auction.status).toBe('ended');
    expect(resumed.body.auction.winningBidId).toBe(bidId);

    const landlet = await api('/landlets/auction-resolve-resume-landlet');
    expect(landlet.body.landlet.ownerBuilderId).toBe(bidder.builderId);
    const instances = await api('/instances?landletId=auction-resolve-resume-landlet');
    expect(instances.body.instances).toEqual([]);
    const sellerAfter = await api('/builders/me', owner.session());
    expect(sellerAfter.body.builder.higglesBalanceCents).toBe(3000);
    const sellerNotices = await api('/notifications', owner.session());
    expect(sellerNotices.body.notifications.some((n) => n.message.includes('sold for $30.00'))).toBe(true);

    // Resuming again (e.g. a second sweep before anyone notices) must not
    // double-credit the seller — the earnings-event row is the resumability
    // marker as well as the dedupe guard.
    const resumedAgain = await api(`/auctions/${auctionId}/resolve`, { method: 'POST' });
    expect(resumedAgain.response.status).toBe(200);
    const sellerAfterSecondResume = await api('/builders/me', owner.session());
    expect(sellerAfterSecondResume.body.builder.higglesBalanceCents).toBe(3000);
    const earningsCount = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM higgles_earnings_events WHERE builder_id = ?',
    ).bind(owner.builderId).first();
    expect(earningsCount.n).toBe(1);
  });

  it('auctionSettlementEventId is stable for the same auction and differs across auctions', () => {
    expect(auctionSettlementEventId('auction-abc')).toBe(auctionSettlementEventId('auction-abc'));
    expect(auctionSettlementEventId('auction-abc')).not.toBe(auctionSettlementEventId('auction-xyz'));
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
    await fundHiggles(bidder);
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
    await fundHiggles(bidder);
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
    await fundHiggles(bidder);
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
    await fundHiggles(bidder);
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
    await fundHiggles(bidder);
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
    await fundHiggles(bidder);
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

  // #456: the update test above only exercises the "instance stays on the
  // same landlet" path — this one specifically exercises the second
  // requireOwnedLandlet branch (instance.landletId !== existing.landlet_id),
  // moving an instance from a landlet the owner keeps onto one that's
  // concurrently transferred away, to confirm the write-time guard also
  // re-checks the *destination* landlet's ownership, not just the source.
  it('does not let a concurrent instance update move content onto a landlet once an auction transfers it', async () => {
    const owner = await signupBuilder('instance-update-move-race-owner');
    const priorTargetOwner = await signupBuilder('instance-update-move-race-prior-owner');
    const bidder = await signupBuilder('instance-update-move-race-bidder');
    await fundHiggles(owner);
    await fundHiggles(bidder);
    await createGreenbeltLandlet('instance-update-move-race-target');
    await createGreenbeltLandlet('instance-update-move-race-source');
    await claim('instance-update-move-race-source', owner);
    const createdOnSource = await api('/instances', owner.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'instance-update-move-race-instance', landletId: 'instance-update-move-race-source',
        templateId: 'placeholder-tree', x: 1, y: 1,
      }),
    }));
    expect(createdOnSource.response.status).toBe(201);

    // A builder can only ever have one landlet claimed directly (see
    // POST .../claim's own "one claimed landlet per builder" invariant),
    // so the only legitimate way for `owner` to also come to own the
    // target landlet here is to win it at auction — same as any other
    // builder accumulating a second landlet in the real app.
    await claim('instance-update-move-race-target', priorTargetOwner);
    const firstAuction = await api('/landlets/instance-update-move-race-target/auction', priorTargetOwner.session({
      method: 'POST', body: JSON.stringify({ startingBidCents: 0 }),
    }));
    const firstAuctionId = firstAuction.body.auction.auctionId;
    // owner already owns instance-update-move-race-source, so bidding on a
    // second landlet here now needs land-cap headroom (#489) — same
    // "grant plenty via a real earnings event" pattern the
    // resolve-existing-owner test above uses; what's under test is the
    // instance-move race, not the cap gate itself.
    await env.DB.prepare(`
      INSERT INTO higgles_earnings_events (event_id, builder_id, amount_cents) VALUES (?, ?, ?)
    `).bind(`headroom-${crypto.randomUUID()}`, owner.builderId, 100000000).run();
    await api('/builders');
    const firstBid = await api(`/auctions/${firstAuctionId}/bids`, owner.session({
      method: 'POST', body: JSON.stringify({ amountCents: 1000 }),
    }));
    expect(firstBid.response.status).toBe(201);
    await env.DB.prepare(`UPDATE auctions SET ends_at = '2000-01-01T00:00:00.000Z' WHERE auction_id = ?`).bind(firstAuctionId).run();
    const firstResolve = await api(`/auctions/${firstAuctionId}/resolve`, { method: 'POST' });
    expect(firstResolve.response.status).toBe(200);

    const started = await api('/landlets/instance-update-move-race-target/auction', owner.session({
      method: 'POST', body: JSON.stringify({ startingBidCents: 0 }),
    }));
    const auctionId = started.body.auction.auctionId;
    await api(`/auctions/${auctionId}/bids`, bidder.session({
      method: 'POST', body: JSON.stringify({ amountCents: 1500 }),
    }));
    await env.DB.prepare(`UPDATE auctions SET ends_at = '2000-01-01T00:00:00.000Z' WHERE auction_id = ?`).bind(auctionId).run();

    // Owner still owns both landlets at the moment this fires — the race
    // is entirely in the gap between handleInstances' own ownership checks
    // and its write, not in the request's own legitimacy at send time.
    const [moved] = await Promise.all([
      api('/instances/instance-update-move-race-instance', owner.session({
        method: 'PATCH', body: JSON.stringify({ landletId: 'instance-update-move-race-target' }),
      })),
      api(`/auctions/${auctionId}/resolve`, { method: 'POST' }),
    ]);
    // 403 is also legitimate here: the initial requireOwnedLandlets check
    // can itself lose the race and reject before ever reaching the new
    // write-time guard.
    expect([200, 403, 409]).toContain(moved.response.status);

    const targetLandlet = await api('/landlets/instance-update-move-race-target');
    expect(targetLandlet.body.landlet.ownerBuilderId).toBe(bidder.builderId);
    const targetInstances = await api('/instances?landletId=instance-update-move-race-target');
    expect(targetInstances.body.instances).toEqual([]);
  });

  // #809: resolveAuction's transfer/greenbelt-release is the true, final
  // say on a landlet's ownership changing — but a racing POST .../auction
  // from the old seller can still legitimately commit its own INSERT in
  // the genuinely-still-seller-owned window between resolveAuction's own
  // earlier `status = 'ended'` write and this transfer (the atomic guard
  // above only ever sees a consistent snapshot, never that exact instant).
  // Unlike placed_instances/landlet_versions/landlet_levels, an active
  // auction row isn't touched by the transfer at all otherwise, so it
  // would survive forever as an orphaned active auction under a seller
  // who no longer owns the land. Simulates that legitimately-created
  // second auction directly (the same outcome a real race could produce,
  // without needing to force a genuine interleave) and drives the real
  // resolveAuction code via the actual /resolve endpoint to confirm its
  // own cleanup closes it.
  it('ends a stray active auction left by a race, the moment the winning auction it raced against actually resolves', async () => {
    const seller = await signupBuilder('auction-resolve-cleanup-seller');
    const bidder = await signupBuilder('auction-resolve-cleanup-bidder');
    await fundHiggles(bidder);
    await createGreenbeltLandlet('auction-resolve-cleanup-landlet');
    await claim('auction-resolve-cleanup-landlet', seller);
    const started = await api('/landlets/auction-resolve-cleanup-landlet/auction', seller.session({
      method: 'POST', body: JSON.stringify({ startingBidCents: 0 }),
    }));
    const auctionId = started.body.auction.auctionId;
    await api(`/auctions/${auctionId}/bids`, bidder.session({
      method: 'POST', body: JSON.stringify({ amountCents: 1500 }),
    }));
    await env.DB.prepare(`UPDATE auctions SET ends_at = '2000-01-01T00:00:00.000Z' WHERE auction_id = ?`).bind(auctionId).run();

    // The stray second auction a racing POST would have created while the
    // landlet was still genuinely seller-owned, just before this resolve.
    const strayAuctionId = `auction-${crypto.randomUUID()}`;
    await env.DB.prepare(`
      INSERT INTO auctions (auction_id, landlet_id, seller_builder_id, starting_bid_cents, ends_at)
      VALUES (?, ?, ?, 0, ?)
    `).bind(strayAuctionId, 'auction-resolve-cleanup-landlet', seller.builderId, new Date(Date.now() + 3600_000).toISOString()).run();

    const resolved = await api(`/auctions/${auctionId}/resolve`, { method: 'POST' });
    expect(resolved.response.status).toBe(200);

    const landlet = await api('/landlets/auction-resolve-cleanup-landlet');
    expect(landlet.body.landlet.ownerBuilderId).toBe(bidder.builderId);

    const stray = await env.DB.prepare('SELECT status FROM auctions WHERE auction_id = ?').bind(strayAuctionId).first();
    expect(stray.status).toBe('ended');
  });

  it('resolves a winning auction even when the bidder already owns a claimed landlet, without poisoning the list endpoint', async () => {
    const owner = await signupBuilder('resolve-existing-owner-owner');
    const bidder = await signupBuilder('resolve-existing-owner-bidder');
    await fundHiggles(bidder);
    await createGreenbeltLandlet('auction-bidder-own-landlet');
    await claim('auction-bidder-own-landlet', bidder);
    await createGreenbeltLandlet('auction-resolve-existing-owner-landlet');
    await claim('auction-resolve-existing-owner-landlet', owner);
    const started = await api('/landlets/auction-resolve-existing-owner-landlet/auction', owner.session({
      method: 'POST', body: JSON.stringify({ startingBidCents: 0 }),
    }));
    const auctionId = started.body.auction.auctionId;
    // The bidder here already owns a claimed landlet (this test's whole
    // point), so bidding on a second one now needs land-cap headroom —
    // see #489. What's being tested is auction resolution mechanics, not
    // the cap gate, so grant plenty of it via a real earnings event.
    await env.DB.prepare(`
      INSERT INTO higgles_earnings_events (event_id, builder_id, amount_cents) VALUES (?, ?, ?)
    `).bind(`headroom-${crypto.randomUUID()}`, bidder.builderId, 100000000).run();
    await api('/builders');
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
    const versioned = await api('/landlets/auction-relinquish-landlet/versions', owner.session({
      method: 'POST', body: JSON.stringify({ name: 'Pre-relinquish version' }),
    }));
    const versionId = versioned.body.version.versionId;
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

    // #1257: a voluntary $0 auction is the seller's own deliberate choice
    // (unlike an inactivity-triggered one — see that describe block's own
    // regression test) — it keeps the original full wipe, never archived.
    const liveVersions = await api('/landlets/auction-relinquish-landlet/versions');
    expect(liveVersions.body.versions).toEqual([]);
    const archived = await env.DB.prepare(
      'SELECT * FROM archived_landlet_versions WHERE version_id = ?',
    ).bind(versionId).first();
    expect(archived).toBeNull();
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
    await fundHiggles(bidderA);
    await fundHiggles(bidderB);
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
    await fundHiggles(bidder);
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
    await fundHiggles(bidder);
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

  // #629 (owner-confirmed, 2026-09-10): the exploit this closes — a
  // winning bid used to credit the seller with the full amount regardless
  // of whether the bidder ever held it, which #625 turned into a real,
  // unbacked-cash extraction path. These tests exercise the fix directly:
  // bidding now holds higgles until outbid or the auction closes, and
  // resolution never credits a seller with money the winner didn't
  // actually have at settlement time.
  describe('Balance holding (#629)', () => {
    it("rejects a bid once it plus the bidder's currently-leading bid on another auction would exceed their higgles balance", async () => {
      const sellerA = await signupBuilder('hold-higgles-seller-a');
      const sellerB = await signupBuilder('hold-higgles-seller-b');
      const bidder = await signupBuilder('hold-higgles-bidder');
      await fundHiggles(bidder, 1000);
      // Generous land-cap headroom so only the higgles-balance check below
      // is under test — two default 1000m² landlets would otherwise also
      // trip the (separately-tested) land-cap hold.
      await api(`/builders/${bidder.builderId}/land-cap-grants`, adminSession({
        method: 'POST', body: JSON.stringify({ amountCents: 100_000_000 }),
      }));
      await createGreenbeltLandlet('hold-higgles-landlet-a');
      await createGreenbeltLandlet('hold-higgles-landlet-b');
      await claim('hold-higgles-landlet-a', sellerA);
      await claim('hold-higgles-landlet-b', sellerB);
      const auctionA = await api('/landlets/hold-higgles-landlet-a/auction', sellerA.session({
        method: 'POST', body: JSON.stringify({}),
      }));
      const auctionB = await api('/landlets/hold-higgles-landlet-b/auction', sellerB.session({
        method: 'POST', body: JSON.stringify({}),
      }));

      const firstBid = await api(`/auctions/${auctionA.body.auction.auctionId}/bids`, bidder.session({
        method: 'POST', body: JSON.stringify({ amountCents: 700 }),
      }));
      expect(firstBid.response.status).toBe(201);

      // Only 300 left after the 700 already held on auction A.
      const tooMuch = await api(`/auctions/${auctionB.body.auction.auctionId}/bids`, bidder.session({
        method: 'POST', body: JSON.stringify({ amountCents: 400 }),
      }));
      expect(tooMuch.response.status).toBe(400);
      expect(tooMuch.body.error).toMatch(/available/i);

      const withinRemaining = await api(`/auctions/${auctionB.body.auction.auctionId}/bids`, bidder.session({
        method: 'POST', body: JSON.stringify({ amountCents: 300 }),
      }));
      expect(withinRemaining.response.status).toBe(201);
    });

    it('releases a held bid once the bidder is outbid, freeing their balance for a new bid elsewhere', async () => {
      const sellerA = await signupBuilder('release-higgles-seller-a');
      const sellerB = await signupBuilder('release-higgles-seller-b');
      const bidder = await signupBuilder('release-higgles-bidder');
      const outbidder = await signupBuilder('release-higgles-outbidder');
      await fundHiggles(bidder, 1000);
      await fundHiggles(outbidder, 2000);
      // Generous land-cap headroom so only the higgles-balance hold below
      // is under test — see the same note on the test above.
      await api(`/builders/${bidder.builderId}/land-cap-grants`, adminSession({
        method: 'POST', body: JSON.stringify({ amountCents: 100_000_000 }),
      }));
      await api(`/builders/${outbidder.builderId}/land-cap-grants`, adminSession({
        method: 'POST', body: JSON.stringify({ amountCents: 100_000_000 }),
      }));
      await createGreenbeltLandlet('release-higgles-landlet-a');
      await createGreenbeltLandlet('release-higgles-landlet-b');
      await claim('release-higgles-landlet-a', sellerA);
      await claim('release-higgles-landlet-b', sellerB);
      const auctionA = await api('/landlets/release-higgles-landlet-a/auction', sellerA.session({
        method: 'POST', body: JSON.stringify({}),
      }));
      const auctionB = await api('/landlets/release-higgles-landlet-b/auction', sellerB.session({
        method: 'POST', body: JSON.stringify({}),
      }));
      const auctionAId = auctionA.body.auction.auctionId;

      await api(`/auctions/${auctionAId}/bids`, bidder.session({
        method: 'POST', body: JSON.stringify({ amountCents: 1000 }),
      }));
      const blockedWhileLeading = await api(`/auctions/${auctionB.body.auction.auctionId}/bids`, bidder.session({
        method: 'POST', body: JSON.stringify({ amountCents: 500 }),
      }));
      expect(blockedWhileLeading.response.status).toBe(400);

      const outbid = await api(`/auctions/${auctionAId}/bids`, outbidder.session({
        method: 'POST', body: JSON.stringify({ amountCents: 1001 }),
      }));
      expect(outbid.response.status).toBe(201);

      // The full original balance is available again now that the first
      // auction no longer counts against it.
      const nowAllowed = await api(`/auctions/${auctionB.body.auction.auctionId}/bids`, bidder.session({
        method: 'POST', body: JSON.stringify({ amountCents: 1000 }),
      }));
      expect(nowAllowed.response.status).toBe(201);
    });

    // The bid-time check above is a best-effort, non-atomic-across-
    // auctions guard (see handleAuctionBids' own comment) — this is what
    // actually enforces the invariant: resolution atomically debits the
    // winner, falling through to the next-highest bidder if the leading
    // one can no longer actually cover it, rather than ever crediting a
    // seller with money nobody really had.
    it("falls through to the next-highest bidder at resolution if the leading bidder's balance no longer covers their bid", async () => {
      const seller = await signupBuilder('fallthrough-seller');
      const leadingBidder = await signupBuilder('fallthrough-leading-bidder');
      const secondBidder = await signupBuilder('fallthrough-second-bidder');
      await fundHiggles(leadingBidder, 1000);
      await fundHiggles(secondBidder, 1000);
      await createGreenbeltLandlet('fallthrough-landlet');
      await claim('fallthrough-landlet', seller);
      const started = await api('/landlets/fallthrough-landlet/auction', seller.session({
        method: 'POST', body: JSON.stringify({}),
      }));
      const auctionId = started.body.auction.auctionId;

      await api(`/auctions/${auctionId}/bids`, secondBidder.session({
        method: 'POST', body: JSON.stringify({ amountCents: 500 }),
      }));
      await api(`/auctions/${auctionId}/bids`, leadingBidder.session({
        method: 'POST', body: JSON.stringify({ amountCents: 800 }),
      }));

      // Something spends the leading bidder's balance out from under their
      // held bid before resolution (e.g. an admin/refund adjustment, or in
      // production another of their own auctions resolving first in the
      // same sweep) — simulated directly here since what's under test is
      // resolution's own atomic response to it, not what caused it.
      await env.DB.prepare('UPDATE builders SET higgles_balance_cents = 0 WHERE builder_id = ?')
        .bind(leadingBidder.builderId).run();
      await env.DB.prepare(`UPDATE auctions SET ends_at = '2000-01-01T00:00:00.000Z' WHERE auction_id = ?`).bind(auctionId).run();

      const resolved = await api(`/auctions/${auctionId}/resolve`, { method: 'POST' });
      expect(resolved.response.status).toBe(200);
      expect(resolved.body.auction.winningBidId).not.toBeNull();

      const landlet = await api('/landlets/fallthrough-landlet');
      // The second-highest bidder wins instead, since they can actually pay.
      expect(landlet.body.landlet.ownerBuilderId).toBe(secondBidder.builderId);

      const sellerAfter = await api('/builders/me', seller.session());
      // Credited the second bidder's own 500, never the drained leader's 800.
      expect(sellerAfter.body.builder.higglesBalanceCents).toBe(500);
      const secondBidderAfter = await api('/builders/me', secondBidder.session());
      expect(secondBidderAfter.body.builder.higglesBalanceCents).toBe(500); // 1000 - 500
    });

    // #2290: the balance-shortfall fall-through test just above pins down
    // resolveAuction's first candidate-skip gate (the debit's conditional
    // UPDATE affecting 0 rows) -- this is the symmetric test for its other,
    // independent gate (#785's land-cap-conditioned ownership-transfer
    // UPDATE affecting 0 rows), which had no test of its own exercising a
    // single auction's fall-through, refund, and skip-notification.
    it("falls through to the next-highest bidder at resolution if the leading bidder's land cap no longer covers it", async () => {
      const seller = await signupBuilder('cap-fallthrough-seller');
      const leadingBidder = await signupBuilder('cap-fallthrough-leading-bidder');
      const secondBidder = await signupBuilder('cap-fallthrough-second-bidder');
      await fundHiggles(leadingBidder, 1000);
      await fundHiggles(secondBidder, 1000);
      await createGreenbeltLandlet('cap-fallthrough-landlet');
      await claim('cap-fallthrough-landlet', seller);
      const started = await api('/landlets/cap-fallthrough-landlet/auction', seller.session({
        method: 'POST', body: JSON.stringify({}),
      }));
      const auctionId = started.body.auction.auctionId;

      await api(`/auctions/${auctionId}/bids`, secondBidder.session({
        method: 'POST', body: JSON.stringify({ amountCents: 500 }),
      }));
      await api(`/auctions/${auctionId}/bids`, leadingBidder.session({
        method: 'POST', body: JSON.stringify({ amountCents: 800 }),
      }));

      // The leading bidder's balance is untouched and fully covers their
      // bid -- what's simulated here is their land cap dropping out from
      // under them before resolution (e.g. they claimed or won other land
      // in between bidding and this auction closing), the same "simulate
      // directly, since what's under test is resolution's own atomic
      // response to it" reasoning the balance-path test above uses.
      await env.DB.prepare('UPDATE builders SET land_cap_m2 = 0 WHERE builder_id = ?')
        .bind(leadingBidder.builderId).run();
      await env.DB.prepare(`UPDATE auctions SET ends_at = '2000-01-01T00:00:00.000Z' WHERE auction_id = ?`).bind(auctionId).run();

      const resolved = await api(`/auctions/${auctionId}/resolve`, { method: 'POST' });
      expect(resolved.response.status).toBe(200);
      expect(resolved.body.auction.winningBidId).not.toBeNull();

      const landlet = await api('/landlets/cap-fallthrough-landlet');
      // The second-highest bidder wins instead, since the leader's own cap
      // can't actually fit the land.
      expect(landlet.body.landlet.ownerBuilderId).toBe(secondBidder.builderId);

      const sellerAfter = await api('/builders/me', seller.session());
      // Credited the second bidder's own 500, never the capped-out leader's 800.
      expect(sellerAfter.body.builder.higglesBalanceCents).toBe(500);
      const secondBidderAfter = await api('/builders/me', secondBidder.session());
      expect(secondBidderAfter.body.builder.higglesBalanceCents).toBe(500); // 1000 - 500
      // The skipped leader's held 800 is refunded back, not silently lost.
      const leadingBidderAfter = await api('/builders/me', leadingBidder.session());
      expect(leadingBidderAfter.body.builder.higglesBalanceCents).toBe(1000);

      // Same "could no longer be honored" skip notification the balance-
      // path gate already sends (#883, worker/land.test.js).
      const { results: leaderNotifications } = await env.DB.prepare(
        'SELECT message FROM notifications WHERE builder_id = ? ORDER BY created_at',
      ).bind(leadingBidder.builderId).all();
      expect(leaderNotifications.some((n) => /could no longer be honored/.test(n.message))).toBe(true);
    });

    it('keeps the land with the seller if no bidder can actually cover their bid by resolution time', async () => {
      const seller = await signupBuilder('nobody-can-pay-seller');
      const bidder = await signupBuilder('nobody-can-pay-bidder');
      await fundHiggles(bidder, 1000);
      await createGreenbeltLandlet('nobody-can-pay-landlet');
      await claim('nobody-can-pay-landlet', seller);
      const started = await api('/landlets/nobody-can-pay-landlet/auction', seller.session({
        method: 'POST', body: JSON.stringify({ startingBidCents: 500 }),
      }));
      const auctionId = started.body.auction.auctionId;
      await api(`/auctions/${auctionId}/bids`, bidder.session({
        method: 'POST', body: JSON.stringify({ amountCents: 500 }),
      }));
      await env.DB.prepare('UPDATE builders SET higgles_balance_cents = 0 WHERE builder_id = ?')
        .bind(bidder.builderId).run();
      await env.DB.prepare(`UPDATE auctions SET ends_at = '2000-01-01T00:00:00.000Z' WHERE auction_id = ?`).bind(auctionId).run();

      const resolved = await api(`/auctions/${auctionId}/resolve`, { method: 'POST' });
      expect(resolved.response.status).toBe(200);
      expect(resolved.body.auction.winningBidId).toBeNull();

      const landlet = await api('/landlets/nobody-can-pay-landlet');
      expect(landlet.body.landlet.ownerBuilderId).toBe(seller.builderId);
      expect(landlet.body.landlet.status).toBe('claimed');
    });
  });

  // #1004: auctions.seller_builder_id and auction_bids.bidder_builder_id
  // were the only two builder_id-referencing columns in this codebase with
  // no index of their own, despite both being filtered on directly in hot
  // paths (every bid placement's held-balance check; every builder
  // self-delete's money-strand guard). Schema-only change with no
  // app-observable behavior difference, so the meaningful regression check
  // here is that the indexes actually exist, not a request/response
  // assertion.
  it('indexes auctions.seller_builder_id and auction_bids.bidder_builder_id', async () => {
    const auctionsIndexes = (await env.DB.prepare('PRAGMA index_list(auctions)').all()).results;
    expect(auctionsIndexes.some((idx) => idx.name === 'idx_auctions_seller_builder_id')).toBe(true);

    const bidsIndexes = (await env.DB.prepare('PRAGMA index_list(auction_bids)').all()).results;
    expect(bidsIndexes.some((idx) => idx.name === 'idx_auction_bids_bidder_builder_id')).toBe(true);
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

  async function notificationsFor(builderId) {
    return (await env.DB.prepare(
      'SELECT message FROM notifications WHERE builder_id = ? ORDER BY created_at',
    ).bind(builderId).all()).results;
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

    // #783: the owner should learn their land was auto-auctioned at
    // creation time, not only (up to 24h later) at resolution.
    const notifications = await notificationsFor(owner.builderId);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].message).toContain('inactivity-landlet-a');
    expect(notifications[0].message).toContain('automatically put up for a $0 starting-bid auction');
    expect(notifications[0].message).not.toContain('bid to keep it'); // no cancel/reclaim path exists
  });

  // #1257 (owner-confirmed): unlike a voluntary $0 auction's own no-bid
  // release (see "releases an unsold $0-starting-bid auction to
  // greenbelt" above, which still fully wipes landlet_versions), an
  // inactivity-triggered release wasn't the owner's choice -- their
  // version history must survive, just moved off the landlet (keyed to
  // them instead, per migrations/0140's own comment) rather than left in
  // place or deleted outright.
  it('archives the owner\'s version history instead of deleting it when an inactivity-triggered auction resolves with no bids', async () => {
    const owner = await signupBuilder('inactive-preserve-owner');
    await createGreenbeltLandlet('inactivity-preserve-landlet');
    await claim('inactivity-preserve-landlet', owner);
    const versioned = await api('/landlets/inactivity-preserve-landlet/versions', owner.session({
      method: 'POST', body: JSON.stringify({ name: 'Pre-inactivity version' }),
    }));
    expect(versioned.response.status).toBe(201);
    const versionId = versioned.body.version.versionId;
    await backdateLastActive(owner.builderId, 31);

    await runScheduled();
    const auction = await activeAuctionFor('inactivity-preserve-landlet');
    expect(auction.inactivity_triggered).toBe(1);
    await env.DB.prepare(`UPDATE auctions SET ends_at = '2000-01-01T00:00:00.000Z' WHERE auction_id = ?`).bind(auction.auction_id).run();

    const resolved = await api(`/auctions/${auction.auction_id}/resolve`, { method: 'POST' });
    expect(resolved.response.status).toBe(200);

    const landlet = await api('/landlets/inactivity-preserve-landlet');
    expect(landlet.body.landlet.status).toBe('greenbelt');
    expect(landlet.body.landlet.ownerBuilderId).toBeNull();

    // The original is gone from the landlet (it's released, no longer
    // attached to anyone's active build)...
    const liveVersions = await api('/landlets/inactivity-preserve-landlet/versions');
    expect(liveVersions.body.versions).toEqual([]);

    // ...but survived, re-parented to the owner rather than destroyed.
    const archived = await env.DB.prepare(
      'SELECT * FROM archived_landlet_versions WHERE version_id = ?',
    ).bind(versionId).first();
    expect(archived).not.toBeNull();
    expect(archived.builder_id).toBe(owner.builderId);
    expect(archived.source_landlet_id).toBe('inactivity-preserve-landlet');
    expect(archived.name).toBe('Pre-inactivity version');

    const archivedInstanceCount = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM archived_version_instances WHERE version_id = ?',
    ).bind(versionId).first();
    expect(archivedInstanceCount.n).toBe(0); // no instances were placed before saving this version — just confirming the join didn't error
  });

  // #1694: fireNotifications' own all-or-nothing loop used to rethrow (and
  // abort) on any non-FK error, silently skipping the notification for
  // every builder processed after the failing one in the same tick — the
  // auction itself is unaffected either way (already committed by the
  // single atomic INSERT...RETURNING above), only the FYI notification was
  // at risk. A real FK error wouldn't exercise this at all (fireNotification
  // already swallows those per #1122, with or without this fix), so this
  // forces a genuine non-FK D1 write failure for one specific builder via a
  // real SQLite trigger (same RAISE(ABORT, ...) idiom migrations/0018
  // already uses), not an application-level mock.
  it('one builder\'s failed notification does not block the auction itself or the next builder\'s notification', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failingOwner = await signupBuilder('notify-fails-owner');
    const okOwner = await signupBuilder('notify-ok-owner');
    await createGreenbeltLandlet('inactivity-landlet-fail');
    await createGreenbeltLandlet('inactivity-landlet-ok');
    await claim('inactivity-landlet-fail', failingOwner);
    await claim('inactivity-landlet-ok', okOwner);
    await backdateLastActive(failingOwner.builderId, 31);
    await backdateLastActive(okOwner.builderId, 31);

    await env.DB.prepare(`
      CREATE TRIGGER simulate_notify_failure_1694
      BEFORE INSERT ON notifications
      WHEN NEW.builder_id = '${failingOwner.builderId}'
      BEGIN SELECT RAISE(ABORT, 'simulated transient failure'); END
    `).run();
    try {
      await runScheduled();
    } finally {
      await env.DB.prepare('DROP TRIGGER simulate_notify_failure_1694').run();
    }

    expect(await activeAuctionFor('inactivity-landlet-fail')).toBeTruthy();
    expect(await activeAuctionFor('inactivity-landlet-ok')).toBeTruthy();
    expect(await notificationsFor(failingOwner.builderId)).toHaveLength(0);
    const okNotifications = await notificationsFor(okOwner.builderId);
    expect(okNotifications).toHaveLength(1);
    expect(okNotifications[0].message).toContain('automatically put up for a $0 starting-bid auction');
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
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

  // #783: the owner's own expansion of this issue beyond its original
  // ask — a warning sent while there's still time to log in and reset
  // the inactivity clock, not just a report after the land is already
  // gone (the auction-creation notification covered above).
  describe('advance warning before the inactivity cutoff', () => {
    it('warns an owner within the 3-day window before the 30-day cutoff', async () => {
      const owner = await signupBuilder('about-to-be-inactive-owner');
      await createGreenbeltLandlet('inactivity-warning-landlet-a');
      await claim('inactivity-warning-landlet-a', owner);
      await backdateLastActive(owner.builderId, 28); // 2 days left before day 30

      await runScheduled();

      expect(await activeAuctionFor('inactivity-warning-landlet-a')).toBeNull();
      const notifications = await notificationsFor(owner.builderId);
      expect(notifications).toHaveLength(1);
      expect(notifications[0].message).toContain('inactive for 27 days');
      expect(notifications[0].message).toContain('within 3 days');
    });

    it('does not warn an owner who is not yet within the warning window', async () => {
      const owner = await signupBuilder('comfortably-active-owner');
      await createGreenbeltLandlet('inactivity-warning-landlet-b');
      await claim('inactivity-warning-landlet-b', owner);
      await backdateLastActive(owner.builderId, 10); // nowhere near either cutoff

      await runScheduled();

      expect(await notificationsFor(owner.builderId)).toHaveLength(0);
    });

    it('does not re-warn an owner who was already warned this inactivity cycle', async () => {
      const owner = await signupBuilder('already-warned-owner');
      await createGreenbeltLandlet('inactivity-warning-landlet-c');
      await claim('inactivity-warning-landlet-c', owner);
      await backdateLastActive(owner.builderId, 28);

      await runScheduled();
      await runScheduled(); // the next */10 cron tick, same inactivity window

      expect(await notificationsFor(owner.builderId)).toHaveLength(1);
    });

    it('warns again on a later inactivity cycle after the owner was active in between', async () => {
      const owner = await signupBuilder('returned-then-left-again-owner');
      await createGreenbeltLandlet('inactivity-warning-landlet-d');
      await claim('inactivity-warning-landlet-d', owner);
      await backdateLastActive(owner.builderId, 28);
      await runScheduled();
      expect(await notificationsFor(owner.builderId)).toHaveLength(1);

      // Real activity (any resolved builder profile, per #325) clears
      // inactivity_warning_sent_at (migrations/0109) along with bumping
      // last_active_at back to "now" — see getOrCreateBuilderForUser.
      await api('/builders/me', owner.session());
      await backdateLastActive(owner.builderId, 28); // inactive again, a new cycle

      await runScheduled();

      expect(await notificationsFor(owner.builderId)).toHaveLength(2);
    });

    it('does not warn once the owner has crossed into the auto-auction cutoff itself', async () => {
      const owner = await signupBuilder('past-cutoff-owner');
      await createGreenbeltLandlet('inactivity-warning-landlet-e');
      await claim('inactivity-warning-landlet-e', owner);
      await backdateLastActive(owner.builderId, 31); // past 30 days — autoAuctionInactiveLandlets' own job, not this one

      await runScheduled();

      const notifications = await notificationsFor(owner.builderId);
      expect(notifications).toHaveLength(1); // the auction-creation notification, not a warning
      expect(notifications[0].message).toContain('automatically put up for a $0 starting-bid auction');
    });

    it('does not warn an owner whose land already has an active auction', async () => {
      const owner = await signupBuilder('already-auctioning-owner');
      await createGreenbeltLandlet('inactivity-warning-landlet-f');
      await claim('inactivity-warning-landlet-f', owner);
      const started = await api('/landlets/inactivity-warning-landlet-f/auction', owner.session({
        method: 'POST', body: JSON.stringify({ startingBidCents: 500 }),
      }));
      expect(started.response.status).toBe(201);
      await backdateLastActive(owner.builderId, 28);

      await runScheduled();

      expect(await notificationsFor(owner.builderId)).toHaveLength(0);
    });

    // #1693: the UPDATE claiming inactivity_warning_sent_at used to commit
    // for every matching builder before any notification was attempted --
    // one builder's notification failing aborted fireNotifications' shared
    // loop outright, permanently un-warning every builder after it in that
    // tick (their guard was already flipped, with no retry path). Calls
    // warnInactiveLandletOwners directly (rather than through
    // runScheduled()) with env.DB.prepare temporarily wrapped so only the
    // notifications INSERT for one specific builder fails -- scoping the
    // simulated failure to this one test without affecting the other
    // scheduled() jobs runScheduled() would otherwise also invoke.
    it('#1693: one builder\'s failed notification does not cascade to the rest, and re-arms for a retry', async () => {
      const ownerA = await signupBuilder('notify-fail-cascade-a');
      const ownerB = await signupBuilder('notify-fail-cascade-b');
      await createGreenbeltLandlet('inactivity-warning-landlet-g');
      await createGreenbeltLandlet('inactivity-warning-landlet-h');
      await claim('inactivity-warning-landlet-g', ownerA);
      await claim('inactivity-warning-landlet-h', ownerB);
      await backdateLastActive(ownerA.builderId, 28);
      await backdateLastActive(ownerB.builderId, 28);

      const originalPrepare = env.DB.prepare.bind(env.DB);
      env.DB.prepare = (sql) => {
        const stmt = originalPrepare(sql);
        if (!sql.includes('INSERT INTO notifications')) return stmt;
        return {
          bind: (...args) => {
            const bound = stmt.bind(...args);
            if (args[1] !== ownerA.builderId) return bound;
            return new Proxy(bound, {
              get(target, prop) {
                if (prop === 'run') return async () => { throw new Error('simulated transient D1 failure'); };
                const value = target[prop];
                return typeof value === 'function' ? value.bind(target) : value;
              },
            });
          },
        };
      };
      try {
        await expect(warnInactiveLandletOwners(env.DB)).resolves.toBeUndefined();
      } finally {
        env.DB.prepare = originalPrepare;
      }

      // Owner B's notification still went out despite owner A's failure --
      // the old code let that failure abort the whole loop.
      expect(await notificationsFor(ownerB.builderId)).toHaveLength(1);

      // Owner A's own guard was re-armed (not left permanently poisoned),
      // so a later tick retries them rather than silently skipping them
      // all the way to the auto-auction with no warning ever delivered.
      const ownerARow = await env.DB.prepare(
        'SELECT inactivity_warning_sent_at FROM builders WHERE builder_id = ?',
      ).bind(ownerA.builderId).first();
      expect(ownerARow.inactivity_warning_sent_at).toBeNull();

      await runScheduled();
      expect(await notificationsFor(ownerA.builderId)).toHaveLength(1);
    });
  });
});
