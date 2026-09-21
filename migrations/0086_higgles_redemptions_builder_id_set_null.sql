-- #803: higgles_redemptions.builder_id was declared `NOT NULL REFERENCES
-- builders(builder_id) ON DELETE CASCADE` (migrations/0079) — but that
-- migration's own comment says this table is a *permanent* record of
-- real-money cash-outs, "mirroring the 'keep the record, drop the live
-- reference' reasoning purchases' own stripe_payout_id/paid_out_at columns
-- already use for sellers." Despite invoking that exact reasoning, this
-- table was never given the fix purchases.builder_id already got for the
-- identical problem: migrations/0062 switched purchases.builder_id from
-- CASCADE to SET NULL because builder self-deletion (DELETE
-- /api/builders/:id, an ordinary unprivileged action) was silently
-- destroying permanent financial records. A row here is only ever
-- inserted after both a Stripe transfers call and a Stripe payouts call
-- have already succeeded (handleBuilderRedeem) — every row is money that
-- has genuinely already left the platform — so losing it on self-delete
-- breaks reconciliation/support and any future 1099 generation (#616) for
-- a payout that actually happened.
--
-- higgles_earnings_events (migrations/0050) is deliberately NOT touched by
-- this migration — it's a live, actively-queried 30-day rolling ledger
-- that drives the land-cap mechanic for a *currently existing* builder,
-- not a permanent receipt, so cascading it away on delete is correct.
--
-- SQLite can't ALTER a column's FK action or nullability in place, so this
-- rebuilds the table — the exact recipe migrations/0062 already used for
-- purchases. Nothing holds a foreign key into higgles_redemptions, so the
-- D1-specific rebuild failure mode migration 0062's own comment describes
-- (and migration 0056 hit) doesn't apply here either.
CREATE TABLE higgles_redemptions_new (
  redemption_id TEXT PRIMARY KEY,
  builder_id TEXT REFERENCES builders(builder_id) ON DELETE SET NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  stripe_transfer_id TEXT NOT NULL,
  stripe_payout_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO higgles_redemptions_new
  SELECT redemption_id, builder_id, amount_cents, stripe_transfer_id, stripe_payout_id, created_at
  FROM higgles_redemptions;

DROP TABLE higgles_redemptions;
ALTER TABLE higgles_redemptions_new RENAME TO higgles_redemptions;

CREATE INDEX IF NOT EXISTS idx_higgles_redemptions_builder_id ON higgles_redemptions(builder_id, created_at);
