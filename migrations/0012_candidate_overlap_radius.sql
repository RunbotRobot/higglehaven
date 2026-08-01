-- Precompute the first world-circle radius that can overlap each candidate.
-- Existing rows use zero as a conservative fallback and remain eligible for
-- the Worker's exact geometry check on the next expansion.

ALTER TABLE landlet_candidates
ADD COLUMN min_world_radius_m REAL NOT NULL DEFAULT 0 CHECK (min_world_radius_m >= 0);

CREATE INDEX IF NOT EXISTS idx_landlet_candidates_overlap
ON landlet_candidates(materialized_at, min_world_radius_m);
