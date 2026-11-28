-- #4614 (Basket 4/7, part of #4604, under #4394): paying a basket. A basket is paid by ONE PaymentIntent on the
-- platform's own account (no destination), after which one Transfer per seller moves each seller's share; see the
-- design comment on #4604. Everything the finalize needs is kept in our own database, not in Stripe metadata (which
-- holds 50 keys of 500 characters, far too little for 20 lines): the PaymentIntent carries only `basketOrderId`.
--
-- basket_orders: one row per basket payment. `pending` until the PaymentIntent has succeeded and every line has been
-- recorded as an ordinary purchase; `paid` after; `cancelled` when an unpaid one is swept. No shipping address is kept
-- here: an address is read by its owner and by the buyer and seller of the order it was used for, so it stays on the
-- purchases (the order's own copy, #4599) and in the PaymentIntent's metadata until finalize copies it there.
-- Keyed on the account (user_id) as plain TEXT without a foreign key, like basket_lines (0249): these rows are the
-- financial record of a charge and must outlive a builder profile reset.
CREATE TABLE IF NOT EXISTS basket_orders (
  basket_order_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  buyer_builder_id TEXT,
  payment_intent_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'cancelled')),
  total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  paid_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_basket_orders_status ON basket_orders(status, created_at);
CREATE INDEX IF NOT EXISTS idx_basket_orders_user ON basket_orders(user_id, created_at);

-- basket_order_lines: each line's own snapshot, taken when the payment is created (price, split, what kind of good it
-- is), so a later change to the product or the landlet cannot change what was charged. One line is one placed item
-- (instance_id): the builder's commission follows the landlet the item stood on. The ids are plain TEXT, no foreign
-- keys: a line is a historical receipt and must survive the deletion of any of them (see purchases, 0093).
CREATE TABLE IF NOT EXISTS basket_order_lines (
  basket_order_id TEXT NOT NULL REFERENCES basket_orders(basket_order_id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL CHECK (line_no >= 1),
  instance_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  seller_id TEXT,
  landlet_owner_builder_id TEXT,
  product_name TEXT,
  buyer_label TEXT,
  quantity INTEGER NOT NULL CHECK (quantity >= 1),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
  commission_cents INTEGER NOT NULL CHECK (commission_cents >= 0),
  builder_share_cents INTEGER NOT NULL CHECK (builder_share_cents >= 0),
  platform_share_cents INTEGER NOT NULL CHECK (platform_share_cents >= 0),
  is_digital_good INTEGER NOT NULL DEFAULT 0,
  is_avatar_category INTEGER NOT NULL DEFAULT 0,
  is_animation_category INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (basket_order_id, line_no)
);

-- purchases: which basket order and line a purchase came from, and the Transfer that moved its seller's share. A
-- basket line has the same payment_intent_id as its siblings, so the UNIQUE index on it (0069, 0093) becomes unique per
-- (payment_intent_id, line): a purchase outside a basket has basket_line_no NULL, read as 0, so it is still unique per
-- PaymentIntent exactly as before, and the finalize race guard for the one-product path is unchanged.
-- stripe_transfer_id is NULL until the seller's Transfer exists; a basket line is not eligible for payout before that.
ALTER TABLE purchases ADD COLUMN basket_order_id TEXT;
ALTER TABLE purchases ADD COLUMN basket_line_no INTEGER;
ALTER TABLE purchases ADD COLUMN stripe_transfer_id TEXT;
DROP INDEX IF EXISTS idx_purchases_payment_intent_id;
CREATE UNIQUE INDEX idx_purchases_payment_intent_id ON purchases(payment_intent_id, COALESCE(basket_line_no, 0)) WHERE payment_intent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_purchases_basket_order ON purchases(basket_order_id) WHERE basket_order_id IS NOT NULL;
