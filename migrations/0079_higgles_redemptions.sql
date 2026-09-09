-- Redemption history for #625 (sub-issue of #349/#324) — a permanent
-- record of each real-money cash-out of a builder's higgles balance,
-- mirroring the "keep the record, drop the live reference" reasoning
-- purchases' own stripe_payout_id/paid_out_at columns already use for
-- sellers. Needed for reconciliation/support today, and likely for #616's
-- future 1099 generation once it exists.
CREATE TABLE IF NOT EXISTS higgles_redemptions (
  redemption_id TEXT PRIMARY KEY,
  builder_id TEXT NOT NULL REFERENCES builders(builder_id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  stripe_transfer_id TEXT NOT NULL,
  stripe_payout_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_higgles_redemptions_builder_id ON higgles_redemptions(builder_id, created_at);
