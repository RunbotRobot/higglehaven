-- #852: handleBuilderRedeem (worker/index.js's own POST /api/builders/me/
-- redeem) claimed the builder's balance before ever calling Stripe, but only
-- inserted the permanent higgles_redemptions record *after* both Stripe
-- calls succeeded -- so a concurrent DELETE /api/builders/:id landing in
-- that window has nothing to check against (no row exists yet) and slips
-- through, then the INSERT itself fails on the now-missing builder_id's FK
-- once Stripe has already moved real money, with no record left anywhere.
--
-- Same fix shape as #745/#748 (purchases.paid_out_at/stripe_payout_id):
-- persist the claim *before* the Stripe calls so a delete guard has
-- something to check. That means inserting this row before either Stripe
-- id is known, so both columns need to go from NOT NULL to nullable --
-- SQLite can't ALTER a column's nullability in place, so this rebuilds the
-- table (the exact recipe migrations/0062 and 0086 already used).
CREATE TABLE higgles_redemptions_new (
  redemption_id TEXT PRIMARY KEY,
  builder_id TEXT REFERENCES builders(builder_id) ON DELETE SET NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  stripe_transfer_id TEXT,
  stripe_payout_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO higgles_redemptions_new
  SELECT redemption_id, builder_id, amount_cents, stripe_transfer_id, stripe_payout_id, created_at
  FROM higgles_redemptions;

DROP TABLE higgles_redemptions;
ALTER TABLE higgles_redemptions_new RENAME TO higgles_redemptions;

CREATE INDEX IF NOT EXISTS idx_higgles_redemptions_builder_id ON higgles_redemptions(builder_id, created_at);
