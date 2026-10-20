-- #2495: a $0-winning auction bid (reachable via a $0 `startingBidCents`
-- auction with no outbidding -- including the inactivity-release cron's own
-- give-away auctions) crashes settlement on this table's own
-- CHECK (amount_cents > 0): buildAuctionWinnerSettlementStatements's
-- unconditional earnings-ledger INSERT violates it, rolling back the whole
-- batch and permanently stranding the auction mid-settlement (ownership
-- already transferred, but the old owner's build content never wiped and no
-- ledger row recorded). The admin land-cap-grant endpoint
-- (worker/index.js:3936, which already validates with
-- nonnegativeInteger -- allows 0) hits the identical crash independently.
--
-- Unlike #2439's own call sites, this table's rows are also
-- resolveAuction's/AUCTION_UNSETTLED_TRANSFER_SQL's (#875) sole
-- "has this auction already settled" signal, so skipping the INSERT for a
-- $0 winner (mirroring #2439's guard) would make the auction never
-- register as settled -- every cron tick and GET /api/auctions would
-- re-run the resume branch (and re-fire the winner notification) forever.
-- Relaxing the CHECK instead needs no application-code change: every
-- existing reader only ever does COALESCE(SUM(amount_cents), 0), so a $0
-- row is a pure no-op contribution. This also matches auction_bids'
-- own already-established CHECK (amount_cents >= 0) for the identical
-- "a $0 amount is legitimate here" concept.
--
-- higgles_earnings_events has no FK pointing into it (confirmed via grep
-- for "REFERENCES higgles_earnings_events" across migrations/) and is
-- itself only a child of builders (builder_id), never a parent of
-- anything else -- so, unlike 0093's rebuild of builders, dropping it
-- fires no cascade on any other live table and this can be a simple,
-- isolated single-table rebuild.

CREATE TABLE higgles_earnings_events_new (
  event_id TEXT PRIMARY KEY,
  builder_id TEXT NOT NULL REFERENCES builders(builder_id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO higgles_earnings_events_new SELECT event_id, builder_id, amount_cents, created_at FROM higgles_earnings_events;
DROP TABLE higgles_earnings_events;
ALTER TABLE higgles_earnings_events_new RENAME TO higgles_earnings_events;

CREATE INDEX idx_higgles_earnings_events_builder_id ON higgles_earnings_events(builder_id, created_at);
