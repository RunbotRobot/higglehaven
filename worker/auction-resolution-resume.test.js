import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { resolveDueAuctions } from './index.js';
import {
  api, signupBuilder, signupAdmin, createGreenbeltLandletAs,
} from './test-helpers.js';

let adminSession;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  adminSession = (await signupAdmin('resume-admin')).session;
});

const OLD = '2000-01-01T00:00:00.000Z';

async function setup(tag, bidAmounts) {
  const owner = await signupBuilder(`${tag}-owner`);
  const landletId = `auction-resume-${tag}`;
  await createGreenbeltLandletAs(adminSession, landletId);
  await api(`/landlets/${landletId}/claim`, owner.session({ method: 'POST' }));
  const started = await api(`/landlets/${landletId}/auction`, owner.session({
    method: 'POST', body: JSON.stringify({ startingBidCents: 0 }),
  }));
  const auctionId = started.body.auction.auctionId;
  const bidders = [];
  for (const [i, amount] of bidAmounts.entries()) {
    const b = await signupBuilder(`${tag}-b${i}`);
    await env.DB.prepare('UPDATE builders SET higgles_balance_cents = 100000 WHERE builder_id = ?').bind(b.builderId).run();
    const placed = await api(`/auctions/${auctionId}/bids`, b.session({ method: 'POST', body: JSON.stringify({ amountCents: amount }) }));
    bidders.push({ ...b, bidId: placed.body.bid.bidId, amount });
  }
  await env.DB.prepare('UPDATE auctions SET ends_at = ? WHERE auction_id = ?').bind(OLD, auctionId).run();
  return { owner, landletId, auctionId, bidders };
}

const balance = async (b) => (await env.DB.prepare('SELECT higgles_balance_cents AS n FROM builders WHERE builder_id = ?').bind(b.builderId).first()).n;
const auctionRow = (id) => env.DB.prepare('SELECT * FROM auctions WHERE auction_id = ?').bind(id).first();
const noticeCount = async (b, text) => {
  const r = await api('/notifications', b.session());
  return r.body.notifications.filter((n) => n.message.includes(text)).length;
};
const makeStale = (id) => env.DB.prepare(`UPDATE auctions SET resolving_at = ? WHERE auction_id = ?`).bind(OLD, id).run();

describe('#968 interrupted auction resolution is resumable', () => {
  it('resumes a no-bid limbo auction once: seller is notified once, never twice', async () => {
    const { owner, auctionId } = await setup('nobid', []);
    // Hand-reproduce the interrupted state: guard flip done, nothing else.
    await env.DB.prepare(`UPDATE auctions SET status = 'ended', resolving_at = ? WHERE auction_id = ?`).bind(OLD, auctionId).run();
    await resolveDueAuctions(env.DB);
    await resolveDueAuctions(env.DB);
    const row = await auctionRow(auctionId);
    expect(row.resolution_completed_at).not.toBeNull();
    expect(await noticeCount(owner, 'ended with no bids')).toBe(1);
  });

  it('does not re-run a legitimately resolved no-winner auction, nor an auction ended by other paths', async () => {
    const { owner, auctionId } = await setup('done', []);
    await api(`/auctions/${auctionId}/resolve`, { method: 'POST' });
    expect(await noticeCount(owner, 'ended with no bids')).toBe(1);
    await makeStale(auctionId);
    await resolveDueAuctions(env.DB);
    expect(await noticeCount(owner, 'ended with no bids')).toBe(1);

    const other = await setup('legacy', []);
    await env.DB.prepare(`UPDATE auctions SET status = 'ended' WHERE auction_id = ?`).bind(other.auctionId).run();
    await resolveDueAuctions(env.DB);
    expect((await auctionRow(other.auctionId)).resolution_completed_at).toBeNull();
    expect(await noticeCount(other.owner, 'ended with no')).toBe(0);
  });

  it('does not take over a resolver that is still fresh', async () => {
    const { owner, auctionId } = await setup('fresh', []);
    await env.DB.prepare(`UPDATE auctions SET status = 'ended', resolving_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE auction_id = ?`).bind(auctionId).run();
    await resolveDueAuctions(env.DB);
    expect((await auctionRow(auctionId)).resolution_completed_at).toBeNull();
    expect(await noticeCount(owner, 'ended with no')).toBe(0);
  });

  it('after a crash mid-loop (top bidder debited, no transfer), resume never double-debits and still settles', async () => {
    const { owner, landletId, auctionId, bidders } = await setup('mid', [2000, 3000]);
    const [second, top] = bidders;
    // Interrupted right after the top bidder's debit + marker landed.
    await env.DB.prepare(`UPDATE auctions SET status = 'ended', resolving_at = ? WHERE auction_id = ?`).bind(OLD, auctionId).run();
    await env.DB.prepare(`UPDATE auction_bids SET resolution = 'debited', resolution_token = 't' WHERE bid_id = ?`).bind(top.bidId).run();
    await env.DB.prepare('UPDATE builders SET higgles_balance_cents = higgles_balance_cents - 3000 WHERE builder_id = ?').bind(top.builderId).run();

    await resolveDueAuctions(env.DB);
    await resolveDueAuctions(env.DB);

    const row = await auctionRow(auctionId);
    expect(row.winning_bid_id).toBe(top.bidId);
    expect(await balance(top)).toBe(100000 - 3000);
    expect(await balance(second)).toBe(100000);
    expect(await balance(owner)).toBe(3000);
    const landlet = await api(`/landlets/${landletId}`);
    expect(landlet.body.landlet.ownerBuilderId).toBe(top.builderId);
    expect(await noticeCount(owner, 'sold for')).toBe(1);
  });

  it('a skipped bid stays skipped on resume and its bidder is told exactly once', async () => {
    const { owner, auctionId, bidders } = await setup('skip', [2000, 3000]);
    const [second, top] = bidders;
    // Top bidder can no longer afford it; first run skipped them then crashed.
    await env.DB.prepare('UPDATE builders SET higgles_balance_cents = 0 WHERE builder_id = ?').bind(top.builderId).run();
    await env.DB.prepare(`UPDATE auctions SET status = 'ended', resolving_at = ? WHERE auction_id = ?`).bind(OLD, auctionId).run();
    await env.DB.prepare(`UPDATE auction_bids SET resolution = 'skipped' WHERE bid_id = ?`).bind(top.bidId).run();
    // Funds return before the resume; the skipped decision must stand.
    await env.DB.prepare('UPDATE builders SET higgles_balance_cents = 100000 WHERE builder_id = ?').bind(top.builderId).run();

    await resolveDueAuctions(env.DB);
    await resolveDueAuctions(env.DB);

    expect((await auctionRow(auctionId)).winning_bid_id).toBe(second.bidId);
    expect(await balance(top)).toBe(100000);
    expect(await balance(second)).toBe(100000 - 2000);
    expect(await noticeCount(top, 'could no longer be honored')).toBe(1);
    expect(await noticeCount(owner, 'sold for')).toBe(1);
  });

  it('concurrent resolvers of a stuck auction debit and notify once', async () => {
    const { owner, auctionId, bidders } = await setup('conc', [3000]);
    await env.DB.prepare(`UPDATE auctions SET status = 'ended', resolving_at = ? WHERE auction_id = ?`).bind(OLD, auctionId).run();
    await Promise.all([resolveDueAuctions(env.DB), resolveDueAuctions(env.DB), api(`/auctions/${auctionId}/resolve`, { method: 'POST' })]);
    expect(await balance(bidders[0])).toBe(100000 - 3000);
    expect(await balance(owner)).toBe(3000);
    expect(await noticeCount(owner, 'sold for')).toBe(1);
  });

  it('a normal resolution still works and marks bids debited', async () => {
    const { auctionId, bidders } = await setup('norm', [4000]);
    const r = await api(`/auctions/${auctionId}/resolve`, { method: 'POST' });
    expect(r.body.auction.winningBidId).toBe(bidders[0].bidId);
    const bid = await env.DB.prepare('SELECT resolution FROM auction_bids WHERE bid_id = ?').bind(bidders[0].bidId).first();
    expect(bid.resolution).toBe('debited');
  });
});
