-- #4648 (Disputes 1/3): one row per Stripe dispute on a purchase, written from the charge.dispute.funds_withdrawn and
-- funds_reinstated events the webhook already receives (data.object is the Dispute). dispute_id is Stripe's own id and
-- UNIQUE, so a redelivered event is a no-op, and last_event_at (Stripe's event time) keeps a late older event from
-- overwriting a newer one. Nothing here moves money: the clawback and its reversal stay in the purchase's own columns.
-- evidence_due_by is when Stripe stops accepting evidence; evidence_submitted_at and evidence_error belong to leaf 2
-- (#4650) and stay empty until it lands. outcome is 'open' (funds withdrawn) or 'won' (funds reinstated); a dispute
-- that is lost is the withdrawal standing, which needs no event.
CREATE TABLE IF NOT EXISTS purchase_disputes (
  dispute_id TEXT PRIMARY KEY,
  purchase_id TEXT NOT NULL,
  reason TEXT,
  amount_cents INTEGER,
  status TEXT,
  evidence_due_by TEXT,
  outcome TEXT NOT NULL DEFAULT 'open',
  opened_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_event_at INTEGER,
  evidence_submitted_at TEXT,
  evidence_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_purchase_disputes_purchase ON purchase_disputes(purchase_id);
