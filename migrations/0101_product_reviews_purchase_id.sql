-- #1113 (part of #893's design: product reviews should tie 1:1 to a real
-- purchase, not a spoofable free-text label match). Adds a real
-- purchase_id reference to product_reviews now that purchases.buyer_builder_id
-- (migrations/0099) gives every new review a real buyer identity to key off
-- of instead of the caller-supplied, non-unique, mutable author_label this
-- table used alone until now.
--
-- Nullable -- existing reviews keep purchase_id NULL rather than being
-- retroactively rewritten (there is no reliable way to map an old review
-- back to the exact purchase that backed it; author_label/buyer_label
-- matching, the very mechanism being replaced, is the only signal that
-- existed, and it's the spoofable one). ON DELETE SET NULL, same
-- "keep the record, drop the live reference" pattern purchases.buyer_label/
-- buyer_builder_id already use -- a review is a permanent record of what
-- someone said about a product; it must survive the purchase that granted
-- eligibility for it being gone (refund, or the purchase row's own cascade
-- path) the same way it already survives template/seller deletion.
--
-- Replaces the (template_id, author_label COLLATE NOCASE) uniqueness guard
-- (migrations/0059's idx_product_reviews_one_per_author) with a UNIQUE
-- index on purchase_id itself -- "one review per purchase" is strictly
-- tighter than "one review per label" and closes the spoofing vector
-- outright (a purchase_id can't be guessed or renamed into, unlike a
-- label). The old index must actually be dropped, not just superseded: a
-- buyer with two separate real purchases of the same product under the
-- same session label would otherwise still collide on it even though each
-- purchase is independently eligible for its own review under the new
-- one-per-purchase rule.
DROP INDEX idx_product_reviews_one_per_author;

ALTER TABLE product_reviews ADD COLUMN purchase_id TEXT REFERENCES purchases(purchase_id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_reviews_purchase_id ON product_reviews(purchase_id) WHERE purchase_id IS NOT NULL;
