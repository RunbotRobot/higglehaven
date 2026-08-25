-- Corrects migrations/0047's product reviews design: a review is inherently
-- about the underlying *product* (docs/SPEC.md §5's "Review incentives"),
-- not about wherever a particular placed copy of it happens to be
-- displayed. 0047 wrongly modeled this as a builder-controlled,
-- per-placement opt-in flag — the same pattern as community signs/calendar
-- — which put review moderation in Build mode under a builder who may not
-- even be the product's seller. Reviews attach to catalog_templates
-- instead, with no opt-in flag at all: every catalog template is already
-- product-like by definition (see docs/API.md's "Catalog templates"), so
-- every one of them is reviewable, the same way every real marketplace
-- listing can be reviewed regardless of who displays it.
DROP TABLE product_reviews;
ALTER TABLE placed_instances DROP COLUMN is_reviewable;

CREATE TABLE IF NOT EXISTS product_reviews (
  review_id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES catalog_templates(template_id) ON DELETE CASCADE,
  author_label TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  text TEXT CHECK (text IS NULL OR length(text) <= 280),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_product_reviews_template_id ON product_reviews(template_id, created_at);
