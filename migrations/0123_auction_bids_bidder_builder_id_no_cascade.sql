-- #1691: auction_bids.bidder_builder_id was declared `NOT NULL REFERENCES
-- builders(builder_id) ON DELETE CASCADE` (migrations/0045) -- so a
-- builder self-deleting their profile (DELETE /api/builders/:id, the
-- lighter-weight "give up my land" reset, not full account deletion)
-- cascade-deletes every bid row they ever placed, even on an auction that
-- has already fully resolved with no outstanding claim on that bid at
-- all. GET /api/auctions/:id/bids' returned list/totalCount and the
-- auction's own bidCount (src/main.js's bid-history UI) silently shrink
-- for the seller and every other bidder who can still see that auction,
-- even though nothing about the auction's own outcome changed -- the
-- auction's public record drifts for parties who took no action.
--
-- Same root cause, filed separately, as #1690 (direct_messages cascading
-- on either party's own self-delete) -- and the exact fix shape this
-- codebase already established for purchases.seller_id/
-- seller_feedback.seller_id (migrations/0051/0098's own comments: a
-- cross-party historical record must survive the OTHER party's account
-- going away). Kept NOT NULL (unlike those nullable examples) rather
-- than switched to ON DELETE SET NULL -- every bid row already always
-- has a real bidder id string at insert time, and losing that string
-- entirely on a self-delete would throw away real historical information
-- for no reason; it just stops being a live FK into builders.
--
-- SQLite can't ALTER a column's FK action in place, so this rebuilds the
-- table (SQLite's documented recipe, migrations/0062/0091/0121's own
-- precedent). Nothing holds a foreign key into auction_bids (confirmed:
-- no other migration declares `REFERENCES auction_bids(...)` anywhere in
-- this directory), so this rebuild only drops/recreates the referencing
-- table itself -- the same "safe to rebuild directly" case as #1645's
-- video_generation_jobs rebuild (migrations/0121), not the riskier case
-- 0091 found for rebuilding builders/sellers themselves.
CREATE TABLE auction_bids_new (
  bid_id TEXT PRIMARY KEY,
  auction_id TEXT NOT NULL REFERENCES auctions(auction_id) ON DELETE CASCADE,
  bidder_builder_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO auction_bids_new
  SELECT bid_id, auction_id, bidder_builder_id, amount_cents, created_at
  FROM auction_bids;

DROP TABLE auction_bids;
ALTER TABLE auction_bids_new RENAME TO auction_bids;

CREATE INDEX idx_auction_bids_auction_id ON auction_bids(auction_id, amount_cents DESC);

-- #1004 (migrations/0089) added this as a separate index on the same
-- column -- the rebuild above drops and recreates the whole table, so it
-- has to be recreated here too, or the hot-path lookups that index backs
-- (every bid placement's held-balance check; every builder self-delete's
-- money-strand guard) silently regress to an unindexed full scan.
CREATE INDEX idx_auction_bids_bidder_builder_id ON auction_bids(bidder_builder_id);
