-- #2224: handlePurchaseDispute's "established buyer, zero prior refunds"
-- eligibility check was a plain SELECT taken fresh at the top of each
-- independent call, with no atomic fold against a concurrent dispute from
-- the same buyer -- two or more disputes for different low-value
-- purchases, fired concurrently, could all observe refundedCount === 0
-- before any of their own refunds committed, each passing eligibility and
-- each getting auto-refunded (not just the one no-questions-asked pass the
-- design intended, each also clawing back a seller's commission and
-- reversing a real Stripe charge). One row per builder who has
-- successfully used their one-time auto-resolve pass -- claimed via an
-- atomic INSERT ... WHERE NOT EXISTS before the real refund is attempted
-- (same idiom as idx_didit_verification_sessions_one_pending_per_user/
-- video_generation_jobs' own per-builder claim), released only if the
-- refund attempt itself fails or throws so the pass isn't burned for
-- nothing. Never deleted on success -- it's the permanent record that
-- this buyer has already had their pass, closing the race independently
-- of whether purchases.refunded_at has durably committed yet.
CREATE TABLE dispute_auto_resolve_claims (
  builder_id TEXT PRIMARY KEY REFERENCES builders(builder_id) ON DELETE CASCADE,
  purchase_id TEXT NOT NULL,
  claimed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
