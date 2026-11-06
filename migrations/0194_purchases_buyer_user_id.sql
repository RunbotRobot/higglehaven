-- #3195 (1/5 of #2115, the buyer's "My Purchases" history): a purchase's buyer
-- is a person, so it keys on the account (AGENTS.md, "Anything about a person
-- as a person keys on the account"). The only link until now was
-- buyer_builder_id, declared ON DELETE SET NULL (migration 0099), so when a
-- builder profile is deleted or reset (#3121) every receipt it ever made lost
-- its buyer, and a list keyed on it would silently shrink. Each purchase now
-- also records the buyer's user_id at write time. No foreign key on purpose
-- (same reasoning as seller_user_id, 0190, and user_blocks, 0188): a receipt
-- is a permanent historical record that must outlive the other row.
-- Nullable: a purchase whose buyer had no resolvable account, and (below) a
-- pre-existing purchase whose buyer link was already gone, have none.
ALTER TABLE purchases ADD COLUMN buyer_user_id TEXT;

-- Backfill every existing row whose buyer builder still exists. Rows whose
-- buyer_builder_id was already nulled cannot be recovered (the link is gone)
-- and stay NULL.
UPDATE purchases
SET buyer_user_id = (SELECT user_id FROM builders WHERE builders.builder_id = purchases.buyer_builder_id)
WHERE buyer_user_id IS NULL AND buyer_builder_id IS NOT NULL;

CREATE INDEX idx_purchases_buyer_user_id ON purchases(buyer_user_id, created_at) WHERE buyer_user_id IS NOT NULL;
