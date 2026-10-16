-- #2241: GET /api/catalog's category/subcategory/color filters were made
-- case-insensitive by #2006 (`category = ? COLLATE NOCASE`, etc., matching
-- the free-text/seller-supplied reasoning already established for
-- `name`/`q` on this same endpoint) -- but the indexes meant to support
-- those filters were never updated to match. SQLite only uses an index for
-- a predicate when the predicate's declared collation matches the index's
-- declared collation on that column, so every category/subcategory/color-
-- filtered catalog browse has been doing a full `catalog_templates` table
-- scan this whole time despite "having" an index for it -- not a missing-
-- index gap, an existing-but-useless-index gap. Same fix migrations/0092
-- already applied to the name-sort index, just never extended to these
-- three filter columns.
--
-- Replaces (rather than adds alongside) the now-useless plain-collation
-- indexes from migrations/0021/0026/0092 -- each existed purely to support
-- these same filter queries, so there's no reason to keep a redundant,
-- unused duplicate around. Structure (a combined category+subcategory
-- composite, plus a subcategory-only index for a subcategory filter with
-- no category) mirrors migrations/0021's own original shape, since both
-- filters can be set together in the same request.
DROP INDEX IF EXISTS idx_catalog_templates_category_name_nocase;
DROP INDEX IF EXISTS idx_catalog_templates_category_subcategory_name;
DROP INDEX IF EXISTS idx_catalog_templates_subcategory_name;
DROP INDEX IF EXISTS idx_catalog_templates_color_name;

CREATE INDEX IF NOT EXISTS idx_catalog_templates_category_subcategory_nocase
ON catalog_templates(category COLLATE NOCASE, subcategory COLLATE NOCASE, name COLLATE NOCASE, template_id);

CREATE INDEX IF NOT EXISTS idx_catalog_templates_subcategory_nocase
ON catalog_templates(subcategory COLLATE NOCASE, name COLLATE NOCASE, template_id);

CREATE INDEX IF NOT EXISTS idx_catalog_templates_color_nocase
ON catalog_templates(color COLLATE NOCASE, name COLLATE NOCASE, template_id);
