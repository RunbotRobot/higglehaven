-- #3279 (owner decision, 2026-11-08): a seller removing an avatar/animation
-- product that any shopper owns DELISTS it instead of destroying it. The row
-- (and with it the model URL, the owned_avatars/owned_animations lookups and
-- the equipped-avatar join) stays, so everyone who bought it keeps it exactly
-- as it was; the listing just leaves browsing and the seller's own list, and
-- can no longer be bought or edited. A product nobody owns is still hard-
-- deleted, as before. NULL means listed; a timestamp is when it was delisted.
ALTER TABLE catalog_templates ADD COLUMN delisted_at TEXT;
