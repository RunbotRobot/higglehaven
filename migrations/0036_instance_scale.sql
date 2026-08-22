-- Lets a builder apply a real uniform Resize to a placed instance — for a
-- model whose own source (e.g. an uploaded Sketchfab scan) came in at the
-- wrong physical size entirely, distinct from Trim's per-axis crop_json
-- above (which only ever shortens, never scales). 1 means "rendered at the
-- template's own declared size," matching how an instance with no
-- crop_json entry for an axis already renders at that axis's full size.
ALTER TABLE placed_instances ADD COLUMN scale REAL NOT NULL DEFAULT 1;

-- Same reasoning 0034_instance_crop.sql already applied to crop_json: a
-- published snapshot shouldn't silently un-resize an instance back to its
-- template's own declared size just because it went through a version
-- save/restore.
ALTER TABLE version_instances ADD COLUMN scale REAL NOT NULL DEFAULT 1;
