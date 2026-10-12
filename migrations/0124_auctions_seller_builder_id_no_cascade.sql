-- #1704: auctions.seller_builder_id was declared `NOT NULL REFERENCES
-- builders(builder_id) ON DELETE CASCADE` (migrations/0045) -- so a seller
-- self-deleting their profile (DELETE /api/builders/:id, the lighter-weight
-- "give up my land" reset, not full account deletion) cascade-deletes the
-- ENTIRE auctions row the moment the existing #279/payout-pending guards
-- clear (once the winner's land transfer has completed, nothing blocks it
-- any longer). That in turn cascades through auction_bids.auction_id's own
-- ON DELETE CASCADE (migrations/0045/0123) and wipes every bid on that
-- auction -- the winner's winning bid and every losing bidder's bid alike,
-- not just the seller's own data. handleBuilders' own comment on this
-- cascade (worker/index.js) only reasoned about the still-active,
-- zero-bid case the #279 guard actually blocks; it never covered a fully
-- resolved auction, which the guards don't block at all.
--
-- Same root cause as #1690/#1691, and the exact fix shape this codebase
-- already used for auction_bids.bidder_builder_id itself (#1691,
-- migrations/0123) and purchases.seller_id/seller_feedback.seller_id
-- (migrations/0051/0098's own comments) before that: a cross-party
-- historical record must survive one specific party's own account going
-- away. Kept NOT NULL rather than switched to ON DELETE SET NULL -- same
-- reasoning #1691 gives: every auction row already always has a real
-- seller id string at insert time, and losing it on a self-delete would
-- throw away real historical information for no reason; it just stops
-- being a live FK into builders. The API never resolves a live seller
-- label from this column server-side (auctionShape in worker/index.js
-- returns the raw id only), so this needs no other code change.
--
-- SQLite can't ALTER a column's FK action in place, so this rebuilds the
-- table (SQLite's documented recipe, migrations/0062/0091/0121/0123's own
-- precedent). auction_bids.auction_id is the only FK into auctions
-- anywhere in this directory (confirmed via grep), so this rebuild only
-- drops/recreates the referencing table itself -- the same "safe to
-- rebuild directly" case #1691's own migration comment already found for
-- auction_bids, not the riskier case 0091 found for rebuilding
-- builders/sellers themselves.
CREATE TABLE auctions_new (
  auction_id TEXT PRIMARY KEY,
  landlet_id TEXT NOT NULL REFERENCES landlets(landlet_id) ON DELETE CASCADE,
  seller_builder_id TEXT NOT NULL,
  starting_bid_cents INTEGER NOT NULL DEFAULT 0 CHECK (starting_bid_cents >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  ends_at TEXT NOT NULL,
  winning_bid_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO auctions_new
  SELECT auction_id, landlet_id, seller_builder_id, starting_bid_cents, status,
         ends_at, winning_bid_id, created_at, updated_at
  FROM auctions;

DROP TABLE auctions;
ALTER TABLE auctions_new RENAME TO auctions;

CREATE INDEX idx_auctions_landlet_id ON auctions(landlet_id);
CREATE INDEX idx_auctions_status_listing ON auctions(status, created_at, auction_id);

-- #1004 (migrations/0089) added this as a composite index on
-- (seller_builder_id, status) -- the rebuild above drops and recreates the
-- whole table, so it has to be recreated here too, or the hot-path lookups
-- it backs (every builder self-delete's money-strand guard; any
-- seller-scoped auction listing) silently regress to an unindexed full
-- scan.
CREATE INDEX idx_auctions_seller_builder_id ON auctions(seller_builder_id, status);
