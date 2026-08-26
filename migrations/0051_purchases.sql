-- Simulated purchases (docs/SPEC.md §5's "Universal commission formula" —
-- 2% standard commission for seller-listed products, split 50/50 platform/
-- builder with a 0.5% floor protecting builders on low-commission
-- affiliate products). This is a DEV-MODE SIMULATION, not real commerce —
-- no real payment is ever processed (this project's standing "no real
-- payments/Stripe" constraint) and a shopper is charged nothing. It exists
-- purely to demonstrate and exercise the actual commission math that
-- credits a builder's dállers balance (and thereby feeds their land cap,
-- migrations/0050) when a shopper "buys" a product placed on their
-- lándlet — the missing half of the loop land cap's own commentary flags:
-- this dev-mode backend otherwise has no real commerce/commission system
-- at all, only auction sale proceeds as a dáller source.
--
-- instance_id/template_id/seller_id are deliberately NOT foreign keys — a
-- purchase is a permanent historical receipt, not cascade-deleted if the
-- instance, template, or seller it references is later removed (same
-- "keep the record, drop the live reference" reasoning notifications
-- already use for templateId).
CREATE TABLE IF NOT EXISTS purchases (
  purchase_id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  builder_id TEXT NOT NULL REFERENCES builders(builder_id) ON DELETE CASCADE,
  seller_id TEXT,
  buyer_label TEXT,
  unit_price_cents INTEGER NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  total_cents INTEGER NOT NULL,
  commission_cents INTEGER NOT NULL,
  builder_share_cents INTEGER NOT NULL,
  platform_share_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_purchases_builder_id ON purchases(builder_id, created_at);
CREATE INDEX IF NOT EXISTS idx_purchases_instance_id ON purchases(instance_id, created_at);
