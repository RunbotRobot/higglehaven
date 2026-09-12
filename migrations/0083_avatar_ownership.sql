-- #680 (sub-issue of #679, N53): "avatar" becomes a normal, sellable
-- catalog_templates category (no schema change needed there -- category
-- is already freeform text, migrations/0001) whose purchase grants the
-- buyer an equippable avatar, distinct from an ordinary decorative
-- placed-instance purchase.
--
-- Not derived from `purchases` itself: that table has never recorded
-- which authenticated account did the buying -- only a free-text
-- buyer_label (migrations/0051's own comment on why), and the real-money
-- path (#453/#472) doesn't either. That stays true even now that N44
-- requires every purchase to come from a real, verified session, so
-- there's nothing yet in `purchases` to derive ownership from without
-- retrofitting a buyer-account column through both the simulated and
-- Stripe checkout/finalize/orphaned-purchase paths -- a bigger, riskier
-- change than this feature needs. A dedicated table, granted once at the
-- same point each of those paths already writes its purchases row, is
-- simpler and keeps `purchases` itself exactly as-is.
CREATE TABLE IF NOT EXISTS owned_avatars (
  builder_id TEXT NOT NULL REFERENCES builders(builder_id) ON DELETE CASCADE,
  template_id TEXT NOT NULL,
  purchased_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (builder_id, template_id)
);

-- Which owned avatar (if any) this builder currently has equipped as
-- their own in-world character. NULL means the existing hardcoded
-- default avatar (createShopAvatar in src/main.js) -- equipping is a
-- settings/menu-time action, never blocking and never touching the
-- instant-default-avatar signup flow (#679's own "assigned instantly at
-- registration" note). Deliberately not a foreign key into
-- owned_avatars' own composite key -- validated in the handler instead
-- (GET/PUT /api/builders/me/avatar), the same "not every reference needs
-- FK enforcement" pattern this app already uses for e.g. notifications'
-- own templateId.
ALTER TABLE builders ADD COLUMN equipped_avatar_template_id TEXT;
