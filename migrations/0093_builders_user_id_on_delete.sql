-- #1014 (follow-up to #1019/0091, which closed the same gap for
-- sellers.user_id/didit_verification_sessions.user_id but deliberately left
-- builders.user_id untouched): builders.user_id is the last
-- `REFERENCES users(user_id)` FK in this schema with no explicit `ON DELETE`
-- behavior (SQLite/D1's default RESTRICT). Adding `ON DELETE SET NULL` here
-- -- an orphaned-but-still-referenced builder profile is the same
-- "keep the record, drop the live reference" shape 0062/0086/0091 already
-- chose for purchases.builder_id/higgles_redemptions.builder_id/
-- sellers.user_id.
--
-- Why this needed its own migration rather than reusing 0091's recipe
-- directly: unlike sellers, builders is the parent side of many other
-- foreign keys (notifications, bundles, auctions, auction_bids,
-- friendships x2, higgles_earnings_events (the renamed land_cap),
-- saved_level_layouts, owned_avatars all ON DELETE CASCADE; purchases and
-- higgles_redemptions ON DELETE SET NULL). Per SQLite's own documented
-- foreign-key semantics, `DROP TABLE` performs an implicit `DELETE FROM`
-- on the dropped table when foreign keys are enabled, firing every
-- CASCADE/SET NULL action any live table currently declares against it --
-- confirmed empirically (twice, against real, disposable Cloudflare D1
-- databases created and torn down for exactly this check) that naively
-- rebuilding `builders` alone the way 0091 rebuilt `sellers` runs
-- `DROP TABLE builders` with no error at all, while silently
-- cascade-deleting every dependent row for every existing builder.
--
-- The safe technique (also empirically verified against a real D1
-- instance, including the nested auctions->auction_bids and
-- purchases->owned_avatars dependency chains): before dropping the old
-- `builders` table, first re-point every dependent table's own foreign key
-- at a not-yet-renamed `builders_new`, one rebuild at a time. A table that
-- is itself both a child of builders AND a parent of another dependent
-- table (auctions, referenced by auction_bids; purchases, referenced by
-- owned_avatars) must be rebuilt before its own children, so the children
-- can point at ITS `_new` table rather than its old name. Once nothing in
-- the schema references the old `builders` (or old `auctions`/`purchases`)
-- by name, dropping it fires no cascade at all, and SQLite's own
-- ALTER-TABLE-RENAME semantics automatically rewrite every other table's
-- foreign key clause from `_new` to the final name once that final rename
-- happens -- confirmed by inspecting `sqlite_master` after the fact, not
-- assumed.
--
-- auction_bids.bidder_builder_id and higgles_earnings_events.builder_id
-- (the renamed `land_cap` from 0050) are two more `REFERENCES
-- builders(builder_id)` foreign keys than #1014's own body enumerated --
-- confirmed via `SELECT name FROM sqlite_master WHERE sql LIKE '%REFERENCES
-- builders%'` rather than trusting the issue text's list, since getting
-- this enumeration wrong here would mean silently leaving one more table
-- still pointed at the old `builders` table when it gets dropped below.

CREATE TABLE builders_new (
  builder_id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  pioneer_rank INTEGER,
  higgles_balance_cents INTEGER NOT NULL DEFAULT 0,
  land_cap_m2 INTEGER NOT NULL DEFAULT 1000,
  user_id TEXT REFERENCES users(user_id) ON DELETE SET NULL,
  last_active_at TEXT,
  stripe_account_id TEXT,
  stripe_onboarding_status TEXT NOT NULL DEFAULT 'not_started',
  stripe_requirements_due TEXT,
  stripe_updated_at TEXT,
  equipped_avatar_template_id TEXT
);
INSERT INTO builders_new SELECT builder_id, label, created_at, updated_at, pioneer_rank, higgles_balance_cents, land_cap_m2, user_id, last_active_at, stripe_account_id, stripe_onboarding_status, stripe_requirements_due, stripe_updated_at, equipped_avatar_template_id FROM builders;

-- auctions is both a child of builders and a parent of auction_bids, so it
-- must be rebuilt (pointed at builders_new) before auction_bids is rebuilt
-- (pointed at auctions_new), and before the old `auctions` is dropped.
CREATE TABLE auctions_new (
  auction_id TEXT PRIMARY KEY,
  landlet_id TEXT NOT NULL REFERENCES landlets(landlet_id) ON DELETE CASCADE,
  seller_builder_id TEXT NOT NULL REFERENCES builders_new(builder_id) ON DELETE CASCADE,
  starting_bid_cents INTEGER NOT NULL DEFAULT 0 CHECK (starting_bid_cents >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  ends_at TEXT NOT NULL,
  winning_bid_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO auctions_new SELECT auction_id, landlet_id, seller_builder_id, starting_bid_cents, status, ends_at, winning_bid_id, created_at, updated_at FROM auctions;

-- purchases is both a child of builders and a parent of owned_avatars, same
-- reasoning as auctions above.
CREATE TABLE purchases_new (
  purchase_id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  builder_id TEXT REFERENCES builders_new(builder_id) ON DELETE SET NULL,
  seller_id TEXT,
  buyer_label TEXT,
  unit_price_cents INTEGER NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  total_cents INTEGER NOT NULL,
  commission_cents INTEGER NOT NULL,
  builder_share_cents INTEGER NOT NULL,
  platform_share_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  refunded_at TEXT,
  payment_intent_id TEXT,
  is_digital_good INTEGER NOT NULL DEFAULT 0,
  shipped_at TEXT,
  delivery_confirmed_at TEXT,
  delivery_confirm_token_hash TEXT,
  paid_out_at TEXT,
  stripe_payout_id TEXT
);
INSERT INTO purchases_new SELECT purchase_id, instance_id, template_id, builder_id, seller_id, buyer_label, unit_price_cents, quantity, total_cents, commission_cents, builder_share_cents, platform_share_cents, created_at, refunded_at, payment_intent_id, is_digital_good, shipped_at, delivery_confirmed_at, delivery_confirm_token_hash, paid_out_at, stripe_payout_id FROM purchases;

CREATE TABLE auction_bids_new (
  bid_id TEXT PRIMARY KEY,
  auction_id TEXT NOT NULL REFERENCES auctions_new(auction_id) ON DELETE CASCADE,
  bidder_builder_id TEXT NOT NULL REFERENCES builders_new(builder_id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO auction_bids_new SELECT bid_id, auction_id, bidder_builder_id, amount_cents, created_at FROM auction_bids;

DROP TABLE auction_bids;
DROP TABLE auctions;
ALTER TABLE auctions_new RENAME TO auctions;
ALTER TABLE auction_bids_new RENAME TO auction_bids;

CREATE TABLE owned_avatars_new (
  builder_id TEXT NOT NULL REFERENCES builders_new(builder_id) ON DELETE CASCADE,
  template_id TEXT NOT NULL,
  purchased_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  purchase_id TEXT REFERENCES purchases_new(purchase_id) ON DELETE SET NULL,
  PRIMARY KEY (builder_id, template_id)
);
INSERT INTO owned_avatars_new SELECT builder_id, template_id, purchased_at, purchase_id FROM owned_avatars;

DROP TABLE owned_avatars;
DROP TABLE purchases;
ALTER TABLE purchases_new RENAME TO purchases;
ALTER TABLE owned_avatars_new RENAME TO owned_avatars;

CREATE TABLE notifications_new (
  notification_id TEXT PRIMARY KEY,
  builder_id TEXT NOT NULL REFERENCES builders_new(builder_id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  template_id TEXT REFERENCES catalog_templates(template_id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  read_at TEXT
);
INSERT INTO notifications_new SELECT notification_id, builder_id, message, template_id, created_at, read_at FROM notifications;
DROP TABLE notifications;
ALTER TABLE notifications_new RENAME TO notifications;

CREATE TABLE bundles_new (
  bundle_id TEXT PRIMARY KEY,
  builder_id TEXT NOT NULL REFERENCES builders_new(builder_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  items_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  shared INTEGER NOT NULL DEFAULT 0
);
INSERT INTO bundles_new SELECT bundle_id, builder_id, name, items_json, created_at, updated_at, shared FROM bundles;
DROP TABLE bundles;
ALTER TABLE bundles_new RENAME TO bundles;

CREATE TABLE friendships_new (
  friendship_id TEXT PRIMARY KEY,
  requester_builder_id TEXT NOT NULL REFERENCES builders_new(builder_id) ON DELETE CASCADE,
  recipient_builder_id TEXT NOT NULL REFERENCES builders_new(builder_id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO friendships_new SELECT friendship_id, requester_builder_id, recipient_builder_id, status, created_at FROM friendships;
DROP TABLE friendships;
ALTER TABLE friendships_new RENAME TO friendships;

CREATE TABLE higgles_earnings_events_new (
  event_id TEXT PRIMARY KEY,
  builder_id TEXT NOT NULL REFERENCES builders_new(builder_id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO higgles_earnings_events_new SELECT event_id, builder_id, amount_cents, created_at FROM higgles_earnings_events;
DROP TABLE higgles_earnings_events;
ALTER TABLE higgles_earnings_events_new RENAME TO higgles_earnings_events;

CREATE TABLE saved_level_layouts_new (
  saved_layout_id TEXT PRIMARY KEY,
  builder_id TEXT NOT NULL REFERENCES builders_new(builder_id) ON DELETE CASCADE,
  source_landlet_id TEXT REFERENCES landlets(landlet_id) ON DELETE SET NULL,
  source_level_index INTEGER NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO saved_level_layouts_new SELECT saved_layout_id, builder_id, source_landlet_id, source_level_index, name, created_at FROM saved_level_layouts;
DROP TABLE saved_level_layouts;
ALTER TABLE saved_level_layouts_new RENAME TO saved_level_layouts;

CREATE TABLE higgles_redemptions_new (
  redemption_id TEXT PRIMARY KEY,
  builder_id TEXT REFERENCES builders_new(builder_id) ON DELETE SET NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  stripe_transfer_id TEXT,
  stripe_payout_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO higgles_redemptions_new SELECT redemption_id, builder_id, amount_cents, stripe_transfer_id, stripe_payout_id, created_at FROM higgles_redemptions;
DROP TABLE higgles_redemptions;
ALTER TABLE higgles_redemptions_new RENAME TO higgles_redemptions;

-- Nothing references the old `builders` by name anymore (every dependent
-- table above now points at builders_new) -- safe to drop with no cascade.
DROP TABLE builders;
ALTER TABLE builders_new RENAME TO builders;

-- Every index dropped along with its old table above needs recreating
-- against the final table names (indexes aren't foreign keys, so they're
-- not auto-rewritten by the renames the way FK clauses are).
CREATE UNIQUE INDEX idx_builders_user_id ON builders(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_auctions_landlet_id ON auctions(landlet_id);
CREATE INDEX idx_auctions_status_listing ON auctions(status, created_at, auction_id);
CREATE INDEX idx_auctions_seller_builder_id ON auctions(seller_builder_id, status);
CREATE INDEX idx_auction_bids_auction_id ON auction_bids(auction_id, amount_cents DESC);
CREATE INDEX idx_auction_bids_bidder_builder_id ON auction_bids(bidder_builder_id);
CREATE INDEX idx_purchases_builder_id ON purchases(builder_id, created_at);
CREATE INDEX idx_purchases_instance_id ON purchases(instance_id, created_at);
CREATE INDEX idx_purchases_template_id ON purchases(template_id, created_at);
CREATE INDEX idx_purchases_template_buyer ON purchases(template_id, buyer_label);
CREATE UNIQUE INDEX idx_purchases_payment_intent_id ON purchases(payment_intent_id) WHERE payment_intent_id IS NOT NULL;
CREATE UNIQUE INDEX idx_purchases_delivery_confirm_token_hash ON purchases(delivery_confirm_token_hash) WHERE delivery_confirm_token_hash IS NOT NULL;
CREATE INDEX idx_purchases_seller_payout ON purchases(seller_id, paid_out_at);
CREATE INDEX idx_owned_avatars_purchase_id ON owned_avatars(purchase_id) WHERE purchase_id IS NOT NULL;
CREATE INDEX idx_notifications_builder_id ON notifications(builder_id, read_at);
CREATE INDEX idx_bundles_builder_id ON bundles(builder_id, created_at);
CREATE INDEX idx_bundles_shared ON bundles(created_at) WHERE shared = 1;
CREATE INDEX idx_friendships_requester ON friendships(requester_builder_id);
CREATE INDEX idx_friendships_recipient ON friendships(recipient_builder_id);
CREATE INDEX idx_higgles_earnings_events_builder_id ON higgles_earnings_events(builder_id, created_at);
CREATE INDEX idx_saved_level_layouts_builder_id ON saved_level_layouts(builder_id, created_at DESC);
CREATE INDEX idx_higgles_redemptions_builder_id ON higgles_redemptions(builder_id, created_at);
