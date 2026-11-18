-- #3776: an order is its own record. A purchase kept only template_id/seller_id
-- (deliberately not foreign keys, migration 0051), so once a product's row was
-- gone My Purchases could only say "(removed product)". The order now carries a
-- copy of what was bought, written when the purchase is made (worker/lib/
-- purchase-creation.js), and every reader prefers it over the live row, so
-- nothing a seller or admin does to the product later changes what the order
-- says. unit_price_cents and quantity were already on the row.
ALTER TABLE purchases ADD COLUMN product_name TEXT;
ALTER TABLE purchases ADD COLUMN product_kind TEXT;
ALTER TABLE purchases ADD COLUMN seller_name TEXT;

-- Backfill 1: every order whose product / seller still exists.
UPDATE purchases
SET product_name = (SELECT t.name FROM catalog_templates t WHERE t.template_id = purchases.template_id),
    product_kind = (SELECT t.category FROM catalog_templates t WHERE t.template_id = purchases.template_id)
WHERE product_name IS NULL;

UPDATE purchases
SET seller_name = (SELECT s.label FROM sellers s WHERE s.seller_id = purchases.seller_id)
WHERE seller_name IS NULL AND seller_id IS NOT NULL;

-- Backfill 2: orders already orphaned. Two tables keep a product's name after
-- its row is gone (the sold-out markers of migration 0138 and the suspended-
-- seller snapshots of 0175); take the name from there where one survives. An
-- order nothing survives for stays NULL and reads as "a product the seller has
-- since deleted" (the order still has its date and price).
UPDATE purchases
SET product_name = COALESCE(
  (SELECT m.template_name FROM sold_out_markers m WHERE m.template_id = purchases.template_id AND m.template_name IS NOT NULL LIMIT 1),
  (SELECT s.template_name FROM suspended_seller_instance_snapshots s WHERE s.template_id = purchases.template_id AND s.template_name IS NOT NULL LIMIT 1)
)
WHERE product_name IS NULL;

UPDATE purchases
SET product_kind = (SELECT s.template_category FROM suspended_seller_instance_snapshots s WHERE s.template_id = purchases.template_id AND s.template_category IS NOT NULL LIMIT 1)
WHERE product_kind IS NULL;
