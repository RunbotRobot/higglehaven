-- Product-image pathway for #327 (owner direction from the Control Room,
-- doc zkjfwi4bbuj82uoavasv: "Please build the 3D Model > Flat image
-- creation pathway"). #327's own comment thread established there's no
-- server-side way to render a seller's GLB (Workers can't run WebGL) and
-- the owner ruled out requiring a second seller-provided photo upload
-- (adds friction) — so the client renders a flat PNG thumbnail from the
-- already-uploaded 3D model (reusing the existing renderCatalogThumbnailNow
-- canvas render already used for the catalog picker) and uploads it here.
ALTER TABLE catalog_templates ADD COLUMN image_url TEXT;
-- A cheap stand-in visual embedding for #327's own stated goal ("compute
-- and store a vector embedding per product image... reasonable to stub
-- with whatever's cheapest to get the pipeline working end-to-end first
-- ... swap in a better model later") — a flat JSON array of numbers,
-- computed client-side from the same rendered thumbnail with no external
-- provider dependency. Opaque to this column (length/meaning is entirely
-- up to whatever produced it), so a future swap to a real embedding model
-- needs no migration.
ALTER TABLE catalog_templates ADD COLUMN image_embedding TEXT;
