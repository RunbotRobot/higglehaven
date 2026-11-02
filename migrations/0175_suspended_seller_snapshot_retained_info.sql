-- #2988 (sub-issue 4/5 of #2305): the standing owner decision that a
-- builder is never left wondering "what did I used to have here?" -- the
-- product-identifying info of a suspended-seller removal (#2986) has to
-- outlive both the product itself (a seller's templates can be deleted,
-- and a permanently-closed seller's account is deleted outright) and the
-- chance of restoration. Until now the builder-facing view
-- (worker/lib/pending-restoration.js) only had a LEFT JOIN onto the live
-- catalog_templates row, which comes back empty the moment that template
-- is gone.
--
-- So the snapshot now carries its own copy of the name/category/image taken
-- at removal time, and permanent_at records the moment the seller's
-- suspension escalated to a permanent account closure (restoration is no
-- longer coming). A permanent slot is never auto-restored; it stays listed
-- until the builder clears it themselves (cleared_at, #2987).
ALTER TABLE suspended_seller_instance_snapshots ADD COLUMN template_name TEXT;
ALTER TABLE suspended_seller_instance_snapshots ADD COLUMN template_category TEXT;
ALTER TABLE suspended_seller_instance_snapshots ADD COLUMN template_image_url TEXT;
ALTER TABLE suspended_seller_instance_snapshots ADD COLUMN permanent_at TEXT;

-- Snapshots taken before this migration (from #2986) get their copy from
-- the template while it still exists.
UPDATE suspended_seller_instance_snapshots
SET template_name = (SELECT name FROM catalog_templates WHERE catalog_templates.template_id = suspended_seller_instance_snapshots.template_id),
    template_category = (SELECT category FROM catalog_templates WHERE catalog_templates.template_id = suspended_seller_instance_snapshots.template_id),
    template_image_url = (SELECT image_url FROM catalog_templates WHERE catalog_templates.template_id = suspended_seller_instance_snapshots.template_id)
WHERE template_name IS NULL;
