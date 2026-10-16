-- #2297: credit_orbs.collected_by_builder_id (migrations/0136) was declared
-- `TEXT REFERENCES builders(builder_id)` with no ON DELETE clause at all --
-- SQLite's default is effectively "block the delete," so DELETE FROM
-- builders (handleBuilders' own self-delete route, worker/index.js) throws
-- a foreign key constraint error for any builder who has ever collected a
-- credit orb, surfacing as a generic 409 "Referenced resource does not
-- exist or is still in use" with nothing pointing at the real cause.
-- Reproduced directly: a builder who collected one orb cannot self-delete
-- at all.
--
-- Same root cause and same fix shape already established in this exact
-- codebase for the identical "a historical record must survive one
-- specific party's own account going away" problem -- auctions.
-- seller_builder_id (#1704, migrations/0124), auction_bids.
-- bidder_builder_id (#1691, migrations/0123), purchases.seller_id/
-- seller_feedback.seller_id (migrations/0051/0098's own comments): drop
-- the live FK entirely via a table rebuild, keep the column's own value
-- (a real id string at insert time) as plain historical data rather than
-- cascading the delete or nulling it out. Not ON DELETE SET NULL for the
-- same reasoning #1691's own comment gives: the id is still meaningful
-- history (which builder collected this specific orb) even once that
-- builder is gone, and GET /api/credit-orbs never resolves a live label
-- from this column server-side (credit_orbs rows aren't returned to
-- clients at all once collected -- see handleCreditOrbs' own "active
-- (uncollected) orbs" filter), so nothing reads it as a live FK target.
--
-- SQLite can't ALTER a column's FK action in place, so this rebuilds the
-- table (the same documented recipe migrations/0062/0091/0121/0123/0124
-- already used).
CREATE TABLE credit_orbs_new (
  orb_id TEXT PRIMARY KEY,
  landlet_id TEXT NOT NULL,
  x_m REAL NOT NULL,
  y_m REAL NOT NULL,
  z_m REAL NOT NULL DEFAULT 0,
  spawned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  collected_at TEXT,
  collected_by_builder_id TEXT
);

INSERT INTO credit_orbs_new
  SELECT orb_id, landlet_id, x_m, y_m, z_m, spawned_at, collected_at, collected_by_builder_id
  FROM credit_orbs;

DROP TABLE credit_orbs;
ALTER TABLE credit_orbs_new RENAME TO credit_orbs;

-- Recreated exactly as migrations/0136 defined them -- the rebuild above
-- drops and recreates the whole table, so these need re-adding or the
-- reads they back (the active-orbs listing; spawnCreditOrbIfDue's own
-- "last spawn time" anchor) silently regress to an unindexed full scan.
CREATE INDEX idx_credit_orbs_collected_at ON credit_orbs(collected_at);
CREATE INDEX idx_credit_orbs_spawned_at ON credit_orbs(spawned_at);
