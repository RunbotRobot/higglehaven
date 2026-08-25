-- Land acquisition auctions (docs/SPEC.md §5's "simplified auction
-- system"). Distinct from land *cap* (a per-builder max-total-area limit
-- gated by demonstrated commission earnings) — that concept isn't
-- implemented anywhere in this codebase yet, since there's no real
-- commerce/checkout pipeline to earn commission from. This migration only
-- builds the auction *mechanism* itself: listings, bids, timers,
-- resolution, and land/dáller transfer. See docs/API.md's "Land
-- acquisition auctions" for the full scope note on what's deliberately
-- not simulated (balance-gated bidding, land cap, inactivity-triggered
-- auto-listing).
--
-- dallers_balance_cents is a real, persisted ledger (not a UI-only
-- number) so a winning seller's proceeds land somewhere meaningful, even
-- though nothing yet *requires* having a balance to bid — every builder
-- starts at 0 with no way to earn dállers except winning an auction as
-- the seller, so requiring a balance to bid would make the feature
-- untestable today.
ALTER TABLE builders ADD COLUMN dallers_balance_cents INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS auctions (
  auction_id TEXT PRIMARY KEY,
  landlet_id TEXT NOT NULL REFERENCES landlets(landlet_id) ON DELETE CASCADE,
  seller_builder_id TEXT NOT NULL REFERENCES builders(builder_id) ON DELETE CASCADE,
  -- "Starting bid defaults to $0 (no calculated-value formula, no reserve
  -- price)... A $0 starting bid = explicit willingness to relinquish for
  -- free if no bids arrive. A ≥$0.01 starting bid = builder wants to
  -- retain if unsold" — this is read directly off starting_bid_cents at
  -- resolution time (see resolveAuction in worker/index.js), not a
  -- separate flag.
  starting_bid_cents INTEGER NOT NULL DEFAULT 0 CHECK (starting_bid_cents >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  ends_at TEXT NOT NULL,
  winning_bid_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS auction_bids (
  bid_id TEXT PRIMARY KEY,
  auction_id TEXT NOT NULL REFERENCES auctions(auction_id) ON DELETE CASCADE,
  bidder_builder_id TEXT NOT NULL REFERENCES builders(builder_id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_auctions_landlet_id ON auctions(landlet_id);
CREATE INDEX IF NOT EXISTS idx_auctions_status_listing ON auctions(status, created_at, auction_id);
CREATE INDEX IF NOT EXISTS idx_auction_bids_auction_id ON auction_bids(auction_id, amount_cents DESC);
