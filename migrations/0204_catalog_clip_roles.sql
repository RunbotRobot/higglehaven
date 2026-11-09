-- #3312 (part of #3301): which clip of an avatar model plays as idle, walk and
-- fly, as the SELLER chose it. A Mixamo export names every clip "mixamo.com",
-- so the file itself cannot say what motion a clip is (the name matcher in
-- src/avatarClipNames.js, #3290, can only guess); the upload wizard will let
-- the seller say. Stored as JSON {"idle": <clip name|null>, "walk": ...,
-- "fly": ...} with all three keys always present (worker/lib/catalog.js
-- normalises it). NULL means nobody chose, and consumers keep matching by name;
-- a stored value is authoritative, so a role set to null plays nothing.
--
-- On both tables for the reason skeleton_signature is (migrations/0105, 0153):
-- it describes the model file, so a second seller attaching their own listing
-- to a shared product (catalog.js "sell this too") must inherit it. Nothing
-- reads it yet, so this changes no existing behaviour.
ALTER TABLE catalog_templates ADD COLUMN clip_roles TEXT;
ALTER TABLE products ADD COLUMN clip_roles TEXT;
