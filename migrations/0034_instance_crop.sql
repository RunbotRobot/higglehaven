-- Lets a builder shorten a product along a seller-declared "extensible"
-- axis (e.g. cutting a brick or a lumber board to fit a gap) without
-- stretching its geometry: the seller uploads the item at its maximum
-- size and flags which axis can be cropped via catalog_templates'
-- existing metadata_json ({"extensible": {"x": {"minM": 0.05}}} — no
-- schema change needed there, that column already round-trips arbitrary
-- seller data). This column stores the per-instance override actually in
-- effect, e.g. '{"x":0.15}' meaning "cropped to 0.15m along local x";
-- an axis missing from the object renders at the template's full size.
ALTER TABLE placed_instances ADD COLUMN crop_json TEXT NOT NULL DEFAULT '{}';

-- Same reasoning 0007_landlet_versions.sql already applied to rotation:
-- a published snapshot shouldn't silently un-crop an instance back to its
-- template's full size just because it went through a version save/restore.
ALTER TABLE version_instances ADD COLUMN crop_json TEXT NOT NULL DEFAULT '{}';
