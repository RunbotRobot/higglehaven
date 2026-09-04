-- purchases.builder_id was declared `NOT NULL REFERENCES builders(builder_id)
-- ON DELETE CASCADE` (migrations/0051) — the one reference that migration's
-- own header comment doesn't mention, and the one that contradicts its
-- stated design principle ("a purchase is a permanent historical receipt,
-- not cascade-deleted if the instance, template, or seller it references is
-- later removed"). Builder self-deletion (DELETE /api/builders/:id, an
-- ordinary unprivileged action) was silently destroying every purchases row
-- that builder ever hosted a commission on — including a *different*
-- seller's only sales-history record for a product placed on that builder's
-- lándlet. Switched to ON DELETE SET NULL (and the column made nullable) so
-- deleting the host builder's account no longer erases someone else's
-- receipt; worker/index.js's handlePurchaseRefund guards the now-possible
-- null builder_id (nothing to claw back a balance from, and
-- notifications.builder_id is itself NOT NULL).
--
-- SQLite can't ALTER a column's FK action or nullability in place, so this
-- rebuilds the table (SQLite's documented recipe) rather than editing it.
-- Unlike migration 0056's own documented failure rebuilding `users` against
-- real Cloudflare D1 (which broke because *other* tables held foreign keys
-- INTO users, and D1 doesn't honor PRAGMA foreign_keys=OFF the way local
-- SQLite does), nothing holds a foreign key into `purchases` — this rebuild
-- only drops/recreates the referencing table itself, so that failure mode
-- doesn't apply here.
CREATE TABLE purchases_new (
  purchase_id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  builder_id TEXT REFERENCES builders(builder_id) ON DELETE SET NULL,
  seller_id TEXT,
  buyer_label TEXT,
  unit_price_cents INTEGER NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  total_cents INTEGER NOT NULL,
  commission_cents INTEGER NOT NULL,
  builder_share_cents INTEGER NOT NULL,
  platform_share_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  refunded_at TEXT
);

INSERT INTO purchases_new
  SELECT purchase_id, instance_id, template_id, builder_id, seller_id,
         buyer_label, unit_price_cents, quantity, total_cents,
         commission_cents, builder_share_cents, platform_share_cents,
         created_at, refunded_at
  FROM purchases;

DROP TABLE purchases;
ALTER TABLE purchases_new RENAME TO purchases;

CREATE INDEX IF NOT EXISTS idx_purchases_builder_id ON purchases(builder_id, created_at);
CREATE INDEX IF NOT EXISTS idx_purchases_instance_id ON purchases(instance_id, created_at);
CREATE INDEX IF NOT EXISTS idx_purchases_template_id ON purchases(template_id, created_at);
CREATE INDEX IF NOT EXISTS idx_purchases_template_buyer ON purchases(template_id, buyer_label);
