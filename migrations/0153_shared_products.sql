-- #2746 (leaf of #2745, owner-greenlit shared-products redesign): today
-- `catalog_templates` conflates two things into one row -- the product
-- itself (model, name, category, dimensions, images, moderation state)
-- and one seller's own listing of it (seller_id, price_cents,
-- stock_quantity). There's no way for a second seller to list the same
-- product without re-uploading an identical model as their own row.
--
-- This migration is purely the foundational schema split -- #2747 (the
-- listing-creation endpoint), #2748 (its UI), and #2749 (the moderation
-- cascade) build on top of it, but none of them ship here. No existing
-- application code reads or writes either new column yet (confirmed:
-- worker/index.js's templateFromRow builds its API response as an
-- explicit field-by-field object, not a row spread, so a new raw column
-- on catalog_templates can't leak into any response), so this changes
-- nothing about today's behavior for any existing single-seller item.
--
-- `products` holds exactly the shared, non-seller-specific fields the
-- tracking issue's design sketch calls out (model, name, category,
-- dimensions, color, metadata, moderation state), plus the image/model-
-- introspection columns that are equally product-level, not listing-
-- level (image_url/image_embedding/model_size_bytes/skeleton_signature
-- describe the model itself, same as model_url). original_seller_id
-- records who originally uploaded the product -- per the tracking
-- issue's own framing, "owned by whoever originally uploaded it, but not
-- exclusively *sellable* by them once others attach to it" -- kept as
-- plain historical data with no live FK (same reasoning migrations/0147's
-- own comment gives for credit_orbs.collected_by_builder_id: a builder
-- can self-delete, and this column isn't resolved into any live response
-- today, so a dangling value is harmless and the alternative, blocking a
-- builder's self-delete over a product they once uploaded, is worse).
CREATE TABLE products (
  product_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'placeholder',
  subcategory TEXT,
  color TEXT NOT NULL,
  width_m REAL NOT NULL CHECK (width_m > 0),
  depth_m REAL NOT NULL CHECK (depth_m > 0),
  height_m REAL NOT NULL CHECK (height_m > 0),
  model_url TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  image_url TEXT,
  image_embedding TEXT,
  model_size_bytes INTEGER,
  skeleton_signature TEXT,
  is_test_model INTEGER NOT NULL DEFAULT 0,
  flagged_hidden_at TEXT,
  original_seller_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- `catalog_templates` becomes (per the tracking issue's own "become (or
-- reference)" framing) a per-seller *listing* that references a shared
-- product, rather than being rebuilt into one outright -- a table rebuild
-- (the migrations/0147/0124/0123/0091/0062 recipe) would force touching
-- every one of this table's many existing read/write call sites in the
-- same change that's supposed to be risk-free groundwork. Nullable (not
-- NOT NULL): SQLite can't add a NOT NULL column with no default to a
-- non-empty table, and there's no single sensible default product_id;
-- the backfill below populates it for every row that exists today, and
-- the invariant "every listing has a product_id" is enforced going
-- forward by whichever of #2747/#2748 starts actually writing it, not by
-- the database here. No ON DELETE clause: nothing deletes a `products`
-- row anywhere in this codebase yet, so there's no cascade behavior to
-- choose between until a future issue adds one.
ALTER TABLE catalog_templates ADD COLUMN product_id TEXT REFERENCES products(product_id);

-- #2749 (moderation cascade) will need "every listing of this product"
-- for an arbitrary product_id -- the same shape every other seller-
-- scoped lookup in this schema already indexes (migrations/0010/0021-
-- 0027/0145's own catalog listing indexes).
CREATE INDEX idx_catalog_templates_product_id ON catalog_templates(product_id);

-- Backfill: one 1:1 `products` row per existing `catalog_templates` row,
-- reusing template_id as product_id directly -- simplest possible
-- mapping for a migration-time backfill (no app-level id generation
-- available here), and it's exactly the "1:1 backing products row" the
-- tracking issue's design sketch asks for. A product_id collision is
-- impossible: products starts empty, and template_id is already this
-- table's own primary key, so every value is already unique.
INSERT INTO products (
  product_id, name, category, subcategory, color, width_m, depth_m, height_m,
  model_url, metadata_json, image_url, image_embedding, model_size_bytes,
  skeleton_signature, is_test_model, flagged_hidden_at, original_seller_id,
  created_at, updated_at
)
SELECT
  template_id, name, category, subcategory, color, width_m, depth_m, height_m,
  model_url, metadata_json, image_url, image_embedding, model_size_bytes,
  skeleton_signature, is_test_model, flagged_hidden_at, seller_id,
  created_at, updated_at
FROM catalog_templates;

UPDATE catalog_templates SET product_id = template_id;
