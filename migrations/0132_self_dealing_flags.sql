-- #2019 (sub-issue of #1212, owner-settled shape 2026-10-13): a lighter,
-- non-fingerprinting self-dealing signal -- flag a purchase for admin
-- review when the buyer's and the seller's own on-file email match (the
-- same account, or two accounts sharing one real inbox, buying from
-- itself). Shipping-address matching and same-Stripe-customer-ID matching
-- from this sub-issue's own original scope are NOT implemented here --
-- see #2019's own closing comment: this codebase never captures a buyer
-- shipping address anywhere (confirmed by a direct code/schema search),
-- and never creates a Stripe Customer object on either side (only a
-- seller's Connect *account* id and a card fingerprint keyed to whichever
-- account first confirmed that physical card -- migrations/0104's own
-- comment), so neither signal has real data to compare. The issue's own
-- wording already hedged the Stripe-customer-ID piece ("if accessible");
-- shipping-address matching is split out into its own new, owner-judgment
-- sub-issue, since capturing an address at all is a real new data-capture/
-- privacy decision, not a one-line addition to this check.
--
-- purchase_id is deliberately NOT a foreign key -- same "permanent
-- trust-and-safety record, survives whatever it references later being
-- removed" reasoning as purchases' own instance_id/template_id/seller_id
-- (migrations/0051's comment). UNIQUE(purchase_id) keeps this a
-- one-row-per-purchase flag -- the check runs exactly once, at the purchase
-- row's own insert time, so there is never a legitimate second row to add.
CREATE TABLE IF NOT EXISTS self_dealing_flags (
  flag_id TEXT PRIMARY KEY,
  purchase_id TEXT NOT NULL UNIQUE,
  matched_signals TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  reviewed_at TEXT,
  reviewed_by_admin_user_id TEXT,
  review_notes TEXT CHECK (review_notes IS NULL OR length(review_notes) <= 280)
);

CREATE INDEX IF NOT EXISTS idx_self_dealing_flags_status ON self_dealing_flags(status, created_at);
