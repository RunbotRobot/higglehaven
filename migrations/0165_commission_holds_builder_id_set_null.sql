-- #2880: commission_holds.builder_id was declared `NOT NULL REFERENCES
-- builders(builder_id) ON DELETE CASCADE` (migrations/0164) -- an ordinary,
-- unprivileged builder self-delete (DELETE /api/builders/:id) silently
-- destroyed any still-outstanding escrowed hold right along with the
-- builder row, with no check for one at all. This is the same real-money
-- gap migrations/0062 (purchases.builder_id) and 0086
-- (higgles_redemptions.builder_id) already identified and fixed twice for
-- other tables -- CASCADE on a real-money-holding row destroys the record
-- of money that was never credited/refunded anywhere, with no trace it
-- ever existed. Switched to ON DELETE SET NULL (and the column made
-- nullable) so self-deletion no longer erases the hold.
--
-- What should actually happen to a null-builder hold's escrowed money on
-- release (auto-revoke to the platform? still resolve against the
-- purchase? something else?) is a genuine policy decision, not made here
-- -- see #2880's own body for the options. This migration only stops the
-- CASCADE from destroying the record; worker/lib/commission-caps.js's
-- releaseOrRevokeHold leaves a null-builder hold untouched (not released,
-- not revoked) rather than guessing, so it stays queryable/visible
-- pending that decision instead of either looping a swallowed NOT NULL
-- violation forever or silently resolving itself one way.
--
-- SQLite can't ALTER a column's FK action or nullability in place, so this
-- rebuilds the table (SQLite's documented recipe), same as 0062/0086.
-- Nothing holds a foreign key into commission_holds (confirmed via grep
-- for "REFERENCES commission_holds" across migrations/), so this rebuild
-- only drops/recreates the referencing table itself -- the same "no
-- cascade onto other live tables" situation 0062's own comment confirms
-- for purchases, not migration 0056's documented D1 rebuild failure mode.
CREATE TABLE commission_holds_new (
  hold_id TEXT PRIMARY KEY,
  purchase_id TEXT NOT NULL REFERENCES purchases(purchase_id) ON DELETE CASCADE,
  builder_id TEXT REFERENCES builders(builder_id) ON DELETE SET NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  release_at TEXT NOT NULL,
  released_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO commission_holds_new
  SELECT hold_id, purchase_id, builder_id, amount_cents, release_at,
         released_at, revoked_at, created_at
  FROM commission_holds;

DROP TABLE commission_holds;
ALTER TABLE commission_holds_new RENAME TO commission_holds;

CREATE INDEX idx_commission_holds_release ON commission_holds(released_at, revoked_at, release_at);
CREATE INDEX idx_commission_holds_purchase ON commission_holds(purchase_id);
