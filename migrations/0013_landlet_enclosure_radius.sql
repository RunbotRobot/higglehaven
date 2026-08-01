-- Precompute the world-circle radius that fully encloses each landlet.
-- NULL preserves existing rows as conservative exact-check fallbacks.

ALTER TABLE landlets
ADD COLUMN max_world_radius_m REAL CHECK (max_world_radius_m IS NULL OR max_world_radius_m >= 0);

CREATE INDEX IF NOT EXISTS idx_landlets_generation_enclosure
ON landlets(status, generated_at, max_world_radius_m);
