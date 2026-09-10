-- #633 (sub-issue of #631, spun out of #522's own "should removing a level
-- lose the builder's work forever?" follow-up): a level removed via
-- DELETE /api/landlets/:id/levels/:levelIndex sweeps any placed_instances
-- left in its z-range out of active space (#522/#632) -- this snapshots
-- those exact rows first so the builder's work isn't lost outright, only
-- taken off active display, mirroring landlet_versions/version_instances'
-- own snapshot shape (0007_landlet_versions.sql) closely since it's the
-- same "freeze a set of placed_instances rows" idea.
--
-- Keyed to the BUILDER, not the landlet: a saved layout is meant to
-- outlive its source landlet (auctioned away, or hard-deleted via
-- DELETE /api/landlets/:id while unowned) per #631's own "reuse it in the
-- future... onto a different lándlet" framing, so source_landlet_id is
-- plain informational text here, not a foreign key -- the landlet's name
-- at save time is baked into the generated `name` column instead of
-- being looked up later from a row that might no longer exist.
CREATE TABLE IF NOT EXISTS saved_level_layouts (
  saved_layout_id TEXT PRIMARY KEY,
  builder_id TEXT NOT NULL REFERENCES builders(builder_id) ON DELETE CASCADE,
  source_landlet_id TEXT NOT NULL,
  source_level_index INTEGER NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Same column shape as version_instances (0007_landlet_versions.sql,
-- 0034_instance_crop.sql, 0036_instance_scale.sql,
-- 0060_version_instances_community_flags.sql) -- a saved layout is exactly
-- as much of a frozen placed_instances snapshot as a version is, just
-- triggered by level removal instead of a builder's own explicit save.
CREATE TABLE IF NOT EXISTS saved_layout_instances (
  saved_layout_id TEXT NOT NULL REFERENCES saved_level_layouts(saved_layout_id) ON DELETE CASCADE,
  source_instance_id TEXT NOT NULL,
  template_id TEXT NOT NULL REFERENCES catalog_templates(template_id) ON DELETE RESTRICT,
  x_m REAL NOT NULL,
  y_m REAL NOT NULL,
  z_m REAL NOT NULL,
  rotation_x_rad REAL NOT NULL DEFAULT 0,
  rotation_y_rad REAL NOT NULL DEFAULT 0,
  rotation_z_rad REAL NOT NULL,
  label TEXT,
  crop_json TEXT NOT NULL DEFAULT '{}',
  scale REAL NOT NULL DEFAULT 1,
  is_community_sign INTEGER NOT NULL DEFAULT 0,
  is_community_calendar INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (saved_layout_id, source_instance_id)
);

-- #634's own future listing endpoint reads "this builder's saved layouts,
-- newest first" -- indexed for that access pattern up front, the same way
-- 0007's own idx_landlet_versions_landlet_id was.
CREATE INDEX IF NOT EXISTS idx_saved_level_layouts_builder_id
ON saved_level_layouts(builder_id, created_at DESC);
