-- Immutable layout snapshots and an active-version pointer for each landlet.
--
-- version_instances carries rotation_x_rad/rotation_y_rad alongside
-- rotation_z_rad (unlike the original design) so a published snapshot
-- doesn't silently flatten tilt on placed_instances rows that have it —
-- see 0004_add_rotation_xy.sql for why that tilt exists.

ALTER TABLE landlets ADD COLUMN active_version_id TEXT;

CREATE TABLE IF NOT EXISTS landlet_versions (
  version_id TEXT PRIMARY KEY,
  landlet_id TEXT NOT NULL REFERENCES landlets(landlet_id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  name TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (landlet_id, version_number)
);

CREATE TABLE IF NOT EXISTS version_instances (
  version_id TEXT NOT NULL REFERENCES landlet_versions(version_id) ON DELETE CASCADE,
  source_instance_id TEXT NOT NULL,
  template_id TEXT NOT NULL REFERENCES catalog_templates(template_id) ON DELETE RESTRICT,
  x_m REAL NOT NULL,
  y_m REAL NOT NULL,
  z_m REAL NOT NULL,
  rotation_x_rad REAL NOT NULL DEFAULT 0,
  rotation_y_rad REAL NOT NULL DEFAULT 0,
  rotation_z_rad REAL NOT NULL,
  label TEXT,
  PRIMARY KEY (version_id, source_instance_id)
);

CREATE INDEX IF NOT EXISTS idx_landlet_versions_landlet_id
ON landlet_versions(landlet_id, version_number DESC);
