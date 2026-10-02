-- #1163 (sub-issue of #1161): ownership for purchased standalone
-- animations, mirroring owned_avatars (migration 0083) exactly -- a
-- buyer who purchases an "animation"-category catalog template gets a
-- row here, granted at the same point writePurchaseRow/
-- writeOrphanedPurchaseRow already grant owned_avatars. Equipping/
-- applying a purchased animation at runtime is #1165's own scope, not
-- this one's -- this table only tracks ownership, the same way
-- owned_avatars did before #680's own equip endpoint existed.
--
-- Includes purchase_id (owned_avatars' own migration 0085) and the
-- per-granting-purchase owned_animation_purchases side table
-- (owned_avatars' own migration 0094, closing the #1033 gap where a
-- second unrefunded purchase of the same template used to lose its
-- whole grant the moment any ONE of its backing purchases was
-- refunded) from the very first migration, rather than retrofitting
-- either across three more migrations the way owned_avatars' own
-- history did -- that shape is already known to be the right one.
CREATE TABLE IF NOT EXISTS owned_animations (
  builder_id TEXT NOT NULL REFERENCES builders(builder_id) ON DELETE CASCADE,
  template_id TEXT NOT NULL,
  purchased_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  purchase_id TEXT REFERENCES purchases(purchase_id) ON DELETE SET NULL,
  PRIMARY KEY (builder_id, template_id)
);

CREATE INDEX IF NOT EXISTS idx_owned_animations_purchase_id ON owned_animations(purchase_id) WHERE purchase_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS owned_animation_purchases (
  purchase_id TEXT PRIMARY KEY REFERENCES purchases(purchase_id) ON DELETE CASCADE,
  builder_id TEXT NOT NULL REFERENCES builders(builder_id) ON DELETE CASCADE,
  template_id TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_owned_animation_purchases_builder_template
ON owned_animation_purchases(builder_id, template_id);
