-- A shared, cross-device roster of seller identities — the same dev-mode
-- pattern 0032_builders.sql already established for builders (still not
-- real auth: anyone can list, create, rename, or delete any of these), but
-- a genuinely separate namespace from builders rather than reusing
-- builder_id as catalog_templates.seller_id. A seller owns no land, so
-- there's no ownership-release cleanup to mirror on delete the way
-- deleting a builder has.

CREATE TABLE sellers (
  seller_id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Backfill from existing catalog templates so nobody who already uploaded
-- products under the old builder-as-seller scheme disappears from the
-- roster or loses the products already tagged with their old ID.
INSERT INTO sellers (seller_id, label)
SELECT DISTINCT seller_id, 'Seller ' || substr(seller_id, 9, 8)
FROM catalog_templates
WHERE seller_id IS NOT NULL;
