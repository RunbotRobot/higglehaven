-- Planned puzzle pieces stay lightweight until the world circle first overlaps them.

CREATE TABLE IF NOT EXISTS landlet_candidates (
  landlet_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  area_m2 REAL NOT NULL CHECK (area_m2 > 0),
  center_x_m REAL NOT NULL,
  center_y_m REAL NOT NULL,
  land_class INTEGER NOT NULL DEFAULT 1 CHECK (land_class > 0),
  polygon_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  materialized_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_landlet_candidates_pending
ON landlet_candidates(materialized_at, center_x_m, center_y_m);
