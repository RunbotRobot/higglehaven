-- Reserve each procedurally generated annular band as one database resource.
-- The trigger makes overlap prevention atomic across concurrent Worker requests;
-- the candidate-only preflight remains useful for manually queued geometry.

CREATE TABLE land_candidate_rings (
  ring_id TEXT PRIMARY KEY,
  inner_radius_m REAL NOT NULL CHECK (inner_radius_m >= 0),
  outer_radius_m REAL NOT NULL CHECK (outer_radius_m > inner_radius_m),
  candidate_count INTEGER NOT NULL CHECK (candidate_count BETWEEN 3 AND 100),
  distribution TEXT CHECK (distribution IS NULL OR distribution = 'power-law'),
  start_angle_rad REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_land_candidate_rings_bounds
ON land_candidate_rings(inner_radius_m, outer_radius_m);

CREATE TRIGGER reject_overlapping_land_candidate_ring
BEFORE INSERT ON land_candidate_rings
WHEN EXISTS (
  SELECT 1 FROM land_candidate_rings
  WHERE inner_radius_m < NEW.outer_radius_m - 0.0000001
    AND outer_radius_m > NEW.inner_radius_m + 0.0000001
)
BEGIN
  SELECT RAISE(ABORT, 'generated ring radial overlap');
END;
