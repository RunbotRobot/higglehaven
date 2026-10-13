-- #1946: owner request (direct conversation, 2026-10-13) -- the owner is
-- about to furnish real-looking 3D spaces with free downloaded models,
-- since there are no real for-sale products yet. None of today's
-- catalog_templates rows are real products the owner is trying to sell,
-- so they need a durable way to mark that, distinct from the existing
-- `category = 'placeholder'` convention (migrations/0035): that value
-- means "no real category was ever set / a generic dev-fixture box," is
-- freely seller-settable, and nothing filters on it today -- a different
-- concept from "this row is a downloaded demo model, not a real listing."
--
-- Boolean-column convention matches is_admin (migrations/0055)/is_pioneer
-- (migrations/0043)/is_digital_good (migrations/0072): INTEGER NOT NULL
-- DEFAULT 0, not folded into the free-form metadata_json blob the way
-- ordinary seller-settable product attributes (digitalGoodDisclaimer,
-- noReturns, domesticOnly) are -- this needs its own deliberate code path
-- so an ordinary seller can't set/unset it via POST/PATCH /api/catalog
-- the same way is_admin is never ordinary-self-service-settable either.
ALTER TABLE catalog_templates ADD COLUMN is_test_model INTEGER NOT NULL DEFAULT 0;

-- Backfill: every row that exists as of this migration predates any real
-- product listing, per the owner's own statement -- no WHERE needed since
-- every pre-existing row qualifies. Only rows created after this migration
-- (real listings going forward) default to 0.
--
-- Owner correction (direct conversation, 2026-10-13, after this issue's own
-- original filing): a test model must never carry a real price -- forced
-- to NULL here defensively alongside the flag itself, though every
-- pre-existing row already has one (no seed migration ever set a real
-- price_cents on these rows).
UPDATE catalog_templates SET is_test_model = 1, price_cents = NULL;
