-- POST /api/catalog/:templateId/reviews' verified-purchase gate
-- (`SELECT 1 FROM purchases WHERE template_id = ? AND buyer_label = ?
-- COLLATE NOCASE`) only ever checked "has this label ever bought it" — a
-- boolean, not a per-review consumption check — so a single purchase let
-- the same author_label post an unbounded number of reviews under one
-- template, directly skewing averageRating. docs/SPEC.md §5's review
-- incentives are explicitly "capped per account/period," and this app's
-- closest thing to an account here is the purchase-matched author_label,
-- so one review per matching purchaser label is the natural cap.
--
-- COLLATE NOCASE matches the review-gate query's own case-insensitive
-- author_label comparison (worker/index.js's handleProductReviews) — "A
-- Shopper" and "a shopper" are the same reviewer for this purpose, so they
-- shouldn't be able to double up just by changing case.
CREATE UNIQUE INDEX idx_product_reviews_one_per_author
  ON product_reviews(template_id, author_label COLLATE NOCASE);
