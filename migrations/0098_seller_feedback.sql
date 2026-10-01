-- Seller feedback (issue #1096, owner decision 2026-10-01 via Control Room):
-- distinct from product_reviews (migrations/0047/0048), which rate the
-- *product* and are shared across every seller who happens to list it.
-- This rates a specific seller's own service for one specific purchase
-- from them — accuracy of the listing, timeliness, communication — the
-- same "one to one with a purchase" shape the owner asked for, mirroring
-- the purchase-gating docs/API.md's "Product reviews" section already
-- documents, just scoped to the seller rather than the template.
--
-- purchase_id IS a real FK here (unlike purchases.instance_id/template_id/
-- seller_id, which migrations/0051's own comment explains are deliberately
-- NOT FKs because a purchase is a permanent historical receipt that must
-- survive the thing it references being deleted) — feedback has no
-- independent existence of its own; it is specifically about one purchase
-- row, so there's nothing meaningful left to keep once that purchase row
-- itself is gone. seller_id is deliberately NOT a FK, same reasoning as
-- purchases.seller_id itself: a purchase (and the feedback about it) is a
-- permanent record that must survive the seller later self-deleting.
CREATE TABLE IF NOT EXISTS seller_feedback (
  feedback_id TEXT PRIMARY KEY,
  purchase_id TEXT NOT NULL UNIQUE REFERENCES purchases(purchase_id) ON DELETE CASCADE,
  seller_id TEXT NOT NULL,
  author_label TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  text TEXT CHECK (text IS NULL OR length(text) <= 280),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_seller_feedback_seller_id ON seller_feedback(seller_id, created_at);
