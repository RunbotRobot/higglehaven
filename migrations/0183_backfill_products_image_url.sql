-- #3110: nothing ever wrote products.image_url (migrations/0153 only copied it
-- once, at the time of the shared-products backfill), so any product whose
-- thumbnail was generated afterwards has no image of its own, and a listing
-- attached to it started with no thumbnail. The thumbnail route now writes
-- through to the product; this fills in the products that already exist from
-- their earliest listing that has an image. Idempotent: only touches rows
-- that still have no image.
UPDATE products
SET image_url = (
      SELECT ct.image_url FROM catalog_templates ct
      WHERE ct.product_id = products.product_id AND ct.image_url IS NOT NULL
      ORDER BY ct.created_at, ct.template_id LIMIT 1
    ),
    image_embedding = (
      SELECT ct.image_embedding FROM catalog_templates ct
      WHERE ct.product_id = products.product_id AND ct.image_url IS NOT NULL
      ORDER BY ct.created_at, ct.template_id LIMIT 1
    )
WHERE image_url IS NULL
  AND EXISTS (
    SELECT 1 FROM catalog_templates ct
    WHERE ct.product_id = products.product_id AND ct.image_url IS NOT NULL
  );
