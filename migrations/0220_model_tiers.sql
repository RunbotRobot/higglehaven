-- #3414 (Model tiers 2/7, part of #3412): a product can name simpler versions
-- of its own model, a "mid" one for middle distance and a "far" one for the
-- horizon, stored as ordinary uploaded models beside the full one. Both are
-- optional: an upload whose tier generation failed, and every product that
-- predates this migration (until the backfill leaf, #3415, runs), simply has
-- NULL here and the viewer falls back to the full model.
--
-- Same shape and meaning as model_url: a '/uploads/models/<hash>.glb' key into
-- the shared MODELS bucket. They live on products as well as catalog_templates
-- for the same reason model_url does: a listing is denormalized from its
-- product when "Sell this too" attaches one, and duplicating a product reads
-- the product row.
--
-- Because they are keys into the same bucket the orphan sweep walks, every
-- reader that decides whether an uploaded object is still referenced
-- (worker/lib/models.js) must count these columns too, or a tier would be
-- swept as unreferenced the first time the sweep ran.
ALTER TABLE catalog_templates ADD COLUMN model_mid_url TEXT;
ALTER TABLE catalog_templates ADD COLUMN model_far_url TEXT;
ALTER TABLE products ADD COLUMN model_mid_url TEXT;
ALTER TABLE products ADD COLUMN model_far_url TEXT;
