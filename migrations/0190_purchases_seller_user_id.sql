-- #835: the 1099-K aggregation joined purchases to sellers, so a seller who
-- deleted their profile (the sellers row goes; purchases keep a dangling
-- seller_id, #285) and re-created it under a fresh seller_id had all their
-- earlier real-money income silently drop out of the sum. The payee is an
-- account, not a seller profile, so each purchase now records the seller's
-- user_id at write time and the 1099-K query no longer depends on the
-- sellers row surviving. Nullable: a sale whose seller has no account, and
-- (below) a pre-existing sale whose seller was already deleted, have none.
ALTER TABLE purchases ADD COLUMN seller_user_id TEXT;

-- Backfill every existing row whose seller still exists. Rows whose seller
-- was already deleted before this migration cannot be recovered (the
-- seller_id -> user_id link is gone) and stay NULL.
UPDATE purchases
SET seller_user_id = (SELECT user_id FROM sellers WHERE sellers.seller_id = purchases.seller_id)
WHERE seller_user_id IS NULL AND seller_id IS NOT NULL;

CREATE INDEX idx_purchases_seller_user_id ON purchases(seller_user_id, created_at) WHERE seller_user_id IS NOT NULL;
