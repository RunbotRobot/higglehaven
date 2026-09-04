-- The `purchases` table (migrations/0051) indexed `builder_id` and
-- `instance_id` but not `template_id`, even though two hot paths filter on
-- it: the verified-purchase gate every product review POST runs
-- (`WHERE template_id = ? AND buyer_label = ? COLLATE NOCASE`, worker/
-- index.js's handleProductReviews) and the seller's "did my product sell"
-- listing (`GET /api/purchases?templateId=`). Both did a full table scan
-- without this.
--
-- Two indexes, not one: `(template_id, created_at)` serves the seller
-- listing's own `ORDER BY created_at DESC` directly, while
-- `(template_id, buyer_label)` serves the review gate's exact WHERE clause
-- (SQLite can't satisfy both access patterns equally well from a single
-- composite index here, and both queries run often enough — the review
-- gate on every review submission — to be worth their own index rather
-- than sharing one).
CREATE INDEX IF NOT EXISTS idx_purchases_template_id ON purchases(template_id, created_at);
CREATE INDEX IF NOT EXISTS idx_purchases_template_buyer ON purchases(template_id, buyer_label);
