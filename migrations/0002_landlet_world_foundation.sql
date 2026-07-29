-- Landlet/world foundation for dev-only world-state APIs.
-- Plain "a" naming remains intentional for internal DB names.

CREATE TABLE IF NOT EXISTS world_settings (
  world_id TEXT PRIMARY KEY,
  radius_m REAL NOT NULL DEFAULT 31.6227766017 CHECK (radius_m >= 0),
  expansion_increment_m REAL NOT NULL DEFAULT 10 CHECK (expansion_increment_m > 0),
  greenbelt_min_ratio REAL NOT NULL DEFAULT 0.1 CHECK (greenbelt_min_ratio >= 0 AND greenbelt_min_ratio <= 1),
  coordinate_rotation_deg REAL NOT NULL DEFAULT 210,
  day_cycle_hours REAL NOT NULL DEFAULT 4 CHECK (day_cycle_hours > 0),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

ALTER TABLE landlets ADD COLUMN land_class INTEGER NOT NULL DEFAULT 1;
ALTER TABLE landlets ADD COLUMN polygon_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE landlets ADD COLUMN generated_at TEXT;
ALTER TABLE landlets ADD COLUMN claimable_at TEXT;
ALTER TABLE landlets ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_landlets_status ON landlets(status);
CREATE INDEX IF NOT EXISTS idx_landlets_owner_builder_id ON landlets(owner_builder_id);
CREATE INDEX IF NOT EXISTS idx_landlets_center ON landlets(center_x_m, center_y_m);

INSERT OR IGNORE INTO world_settings (world_id)
VALUES ('default-world');
