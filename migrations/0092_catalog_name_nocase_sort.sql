-- #1015: GET /api/catalog's default sort=name used SQLite's default
-- BINARY collation, putting every uppercase-initial name before every
-- lowercase-initial one (e.g. "Zen Fountain" before "apple crate") --
-- inconsistent with the sibling `q` search filter on this same column,
-- which is already case-insensitive (COLLATE NOCASE in its LIKE clause).
-- catalog_templates.name is free-text, seller-supplied, so mixed casing
-- is the normal case, not an edge case.
--
-- Not an ALTER TABLE ... COLLATE on the column itself: SQLite has no such
-- statement, and rebuilding the table (CREATE new / copy / DROP / RENAME)
-- to change a column's declared collation is exactly the pattern
-- migrations/0056's own comment found unsafe against real D1 (PRAGMA
-- foreign_keys OFF/ON doesn't survive D1's remote execution, and
-- catalog_templates has its own dependents -- purchases, owned_avatars,
-- etc. -- via template_id). A COLLATE NOCASE index plus explicit
-- COLLATE NOCASE in the query's own ORDER BY/cursor-comparison clauses
-- (worker/index.js, GET /api/catalog's sort === 'name' branch) gets the
-- same case-insensitive ordering without touching the table's identity
-- at all -- same reasoning 0056 landed on for username uniqueness, just
-- applied to sorting instead of a uniqueness constraint.
--
-- Replaces (rather than adds alongside) the two plain-collation indexes
-- from migrations/0010 -- both existed purely to support this same
-- name-sort/pagination query, so there's no reason to keep a
-- now-unused duplicate around.
DROP INDEX IF EXISTS idx_catalog_templates_name;
DROP INDEX IF EXISTS idx_catalog_templates_category_name;

CREATE INDEX IF NOT EXISTS idx_catalog_templates_name_nocase
ON catalog_templates(name COLLATE NOCASE, template_id);

CREATE INDEX IF NOT EXISTS idx_catalog_templates_category_name_nocase
ON catalog_templates(category, name COLLATE NOCASE, template_id);
