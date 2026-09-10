-- #633 (sub-issue of #631) -- persists a removed level's instances as a
-- reusable record for the builder, per the owner's own Control Room answer
-- on #522/#631: "maintain a record of the builder's work so they can reuse
-- it in the future." Keyed to the BUILDER, not the landlet (unlike
-- landlet_versions/version_instances, whose parent is a landlet) -- a
-- saved layout needs to outlive its source landlet (which can later be
-- auctioned off, deleted, or otherwise change hands), since the whole
-- point is later pasting it onto a DIFFERENT landlet.
--
-- saved_layout_instances mirrors version_instances' own snapshot column
-- shape (migrations 0007, 0034, 0036, 0060) exactly -- a snapshot needs
-- every visual/interactive property an instance can carry, not just its
-- geometry.
CREATE TABLE IF NOT EXISTS saved_level_layouts (
  saved_layout_id TEXT PRIMARY KEY,
  builder_id TEXT NOT NULL REFERENCES builders(builder_id) ON DELETE CASCADE,
  -- Informational only (which landlet/level this came from) -- SET NULL
  -- rather than CASCADE, since the source landlet is very possibly deleted
  -- (auctioned away, admin-removed) long before this saved layout is ever
  -- used, and losing that history shouldn't destroy the saved work itself
  -- -- same "keep the record, drop the live reference" reasoning
  -- migrations/0062 already applied to purchases.builder_id.
  source_landlet_id TEXT REFERENCES landlets(landlet_id) ON DELETE SET NULL,
  source_level_index INTEGER NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS saved_layout_instances (
  saved_layout_id TEXT NOT NULL REFERENCES saved_level_layouts(saved_layout_id) ON DELETE CASCADE,
  source_instance_id TEXT NOT NULL,
  template_id TEXT NOT NULL REFERENCES catalog_templates(template_id) ON DELETE RESTRICT,
  x_m REAL NOT NULL,
  y_m REAL NOT NULL,
  z_m REAL NOT NULL,
  rotation_x_rad REAL NOT NULL DEFAULT 0,
  rotation_y_rad REAL NOT NULL DEFAULT 0,
  rotation_z_rad REAL NOT NULL DEFAULT 0,
  label TEXT,
  crop_json TEXT NOT NULL DEFAULT '{}',
  scale REAL NOT NULL DEFAULT 1,
  is_community_sign INTEGER NOT NULL DEFAULT 0,
  is_community_calendar INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (saved_layout_id, source_instance_id)
);

CREATE INDEX IF NOT EXISTS idx_saved_level_layouts_builder_id ON saved_level_layouts(builder_id, created_at DESC);
