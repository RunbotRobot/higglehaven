-- #2017 (sub-issue of #1212, owner-settled shape 2026-10-13): a shopper-
-- facing "flag this listing as counterfeit" mechanism, the admin review
-- queue behind it, and the per-seller strike count an approved flag feeds.
--
-- product_flags: template_id/flagger_builder_id are deliberately NOT FKs,
-- same reasoning as purchases.template_id/seller_id (migrations/0051's own
-- comment) -- a flag is a permanent trust-and-safety record that must
-- survive the flagged template or the flagging builder later being
-- deleted, not disappear along with either. UNIQUE(template_id,
-- flagger_builder_id) is what makes "a threshold of distinct flaggers"
-- (the owner's own settled design) actually distinct -- the same builder
-- re-flagging the same listing can't inflate the count on their own.
CREATE TABLE IF NOT EXISTS product_flags (
  flag_id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL,
  flagger_builder_id TEXT NOT NULL,
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 280),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  resolved_at TEXT,
  resolved_by_admin_user_id TEXT,
  UNIQUE (template_id, flagger_builder_id)
);

CREATE INDEX IF NOT EXISTS idx_product_flags_template_status ON product_flags(template_id, status);

-- Set once a template's distinct-pending-flag count reaches the owner's
-- settled threshold (3), or an admin escalates sooner for obvious severity.
-- Deliberately does NOT remove the template from GET /api/catalog's list/
-- detail endpoints or Build mode's own "Add Item" picker -- #1946's own
-- comment on that same list query already explains why hiding a row there
-- breaks ordinary (non-admin) Build-mode placement for everyone, not just
-- the flagged seller. Checked only at purchase time (handleInstancePurchase)
-- instead, the same shape as that function's existing is_test_model guard.
ALTER TABLE catalog_templates ADD COLUMN flagged_hidden_at TEXT;

-- Incremented when an admin approves a flag (see product_flags above).
-- Ladder consequences (warning/suspension/ban) are explicitly out of scope
-- here -- see #2018, which depends on this column and on #1201's admin
-- suspension tool.
ALTER TABLE sellers ADD COLUMN strike_count INTEGER NOT NULL DEFAULT 0;
