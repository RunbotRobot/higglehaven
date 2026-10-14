-- #1948 (sub-issue of #1947): foundational finite-stock tracking. NULL
-- means unlimited -- today's unchanged default for every existing and
-- future catalog_templates row unless a seller explicitly opts in by
-- setting a quantity (1 = one-of-a-kind). No backfill needed: NULL is
-- SQLite's own implicit default for a newly added column with no
-- DEFAULT clause, so every pre-existing row gets it automatically.
ALTER TABLE catalog_templates ADD COLUMN stock_quantity INTEGER;
