-- Product reviews (docs/SPEC.md §5: "Review incentives: small dáller bonus
-- for genuine, substantive reviews, capped per account/period."). The
-- dáller-bonus half is explicitly out of scope here — there is no shopper
-- account/balance concept anywhere in this app to credit a bonus to (only
-- builders ever hold dállers, and only for their own commission earnings) —
-- this migration covers the reviewable-content half only.
--
-- Structurally a third clone of the community sign (migrations/0041) /
-- community calendar (migrations/0042) pattern: a builder opts a specific
-- placed instance into being reviewable, shoppers post to it, and that same
-- builder moderates whatever gets posted. Attaching reviews to the
-- *placement a builder chose to open up* rather than to the underlying
-- catalog template/seller is a deliberate choice, not an oversight — this
-- app has no seller-side moderation/trust infrastructure at all, and its
-- existing no-central-authority governance model (docs/SPEC.md §3: no
-- mechanism for anyone but the builder to control content on their own
-- land) already answers "who moderates this" the same way it does for signs
-- and calendars. See docs/API.md's "Product reviews" for the full reasoning.
ALTER TABLE placed_instances ADD COLUMN is_reviewable INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS product_reviews (
  review_id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES placed_instances(instance_id) ON DELETE CASCADE,
  author_label TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  text TEXT CHECK (text IS NULL OR length(text) <= 280),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_product_reviews_instance_id ON product_reviews(instance_id, created_at);
