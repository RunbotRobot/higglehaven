-- #2182: product_flags' only index (idx_product_flags_template_status,
-- migration 0131) leads with template_id, but handleProductFlagsList's
-- admin-queue queries (worker/index.js) filter on status = 'pending'
-- alone, with no template_id filter -- so neither query can use that
-- index and both fall back to a full table scan. self_dealing_flags, the
-- sibling trust-and-safety queue added one migration later for the
-- identical shape, already has the matching idx_self_dealing_flags_status
-- (migration 0132); product_flags never got the equivalent.
CREATE INDEX IF NOT EXISTS idx_product_flags_status ON product_flags(status, created_at);
