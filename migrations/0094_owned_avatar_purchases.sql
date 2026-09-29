-- #1033: owned_avatars had exactly one nullable purchase_id column
-- (migrations/0085), set once via `INSERT OR IGNORE` on the buyer's
-- FIRST purchase of a given avatar template -- a second, independent
-- purchase of the same template (two separately-placed instances, both
-- bought) is a no-op against that column, so handlePurchaseRefund's
-- revocation lookup (`WHERE purchase_id = ?`) only ever matched the
-- first purchase. Refunding that first purchase wrongly revoked
-- ownership even when a second, unrefunded purchase for the exact same
-- template still legitimately backed it; refunding the second purchase
-- instead silently did nothing (right by accident, not by design).
--
-- Same "don't retrofit purchases itself" reasoning 0083/0085 already
-- established twice (buyer identity is deliberately not tracked on the
-- shared, high-traffic purchases table -- see 0083_avatar_ownership.sql's
-- own comment) -- this adds a second small, dedicated side table instead,
-- one row per granting purchase rather than one nullable column per
-- owned_avatars row, so a refund can correctly tell whether *any* other
-- unrefunded purchase still backs the same ownership before revoking it.
CREATE TABLE IF NOT EXISTS owned_avatar_purchases (
  purchase_id TEXT PRIMARY KEY REFERENCES purchases(purchase_id) ON DELETE CASCADE,
  builder_id TEXT NOT NULL REFERENCES builders(builder_id) ON DELETE CASCADE,
  template_id TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_owned_avatar_purchases_builder_template
ON owned_avatar_purchases(builder_id, template_id);
