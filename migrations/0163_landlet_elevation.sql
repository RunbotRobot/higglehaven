-- #2851 (leaf of #2373, sub-issue of #2368, Option C real terrain --
-- owner decision 2026-10-27): gives a landlet a place to hold a real,
-- already-baselined terrain-elevation offset, the same "primitive before
-- any consumer" shape migrations/0148 used for `biome` ahead of #2371's
-- own consumer. Computed once at generation time (worker/lib/
-- world-generation.js's applyRealElevationClassification, mirroring
-- applyRealBiomeClassification) from #2850's own elevationAt(db, x, y)
-- lookup, exactly as biome is computed once via biomeAt and then just
-- read back from this column by every later consumer -- never a live
-- per-render lookup.
--
-- Already baselined (elevationAt's raw meters-above-sea-level reading,
-- minus WORLD_ELEVATION_BASELINE_M, itself a frozen real reading at the
-- world's own origin (0,0) -- see that constant's own comment in
-- world-generation.js for why it's a fixed value, not a live query) --
-- so this column already holds the relative height-above-baseline value
-- every consumer (src/build/scene.js's applyLandletShape, src/world/
-- models.js's curveGroundGeometry) can add directly to a ground vertex's
-- local z before applying Earth-curvature sag, with no further math.
--
-- Nullable, same reasoning as `biome`: #2850's own elevation_m column is
-- nullable for "no sampled cell close enough" / "predates #2850, never
-- backfilled", and that nullability has to propagate here too -- there is
-- no safe non-null default (0 would silently claim "exactly at the
-- baseline," indistinguishable from a genuine real reading).
--
-- Additive column, same `ALTER TABLE ... ADD COLUMN` shape and rebuild-
-- avoidance reasoning migrations/0064/0108/0148 already established for
-- this exact pair of heavily-referenced tables.
ALTER TABLE landlets ADD COLUMN elevation_m REAL;
ALTER TABLE landlet_candidates ADD COLUMN elevation_m REAL;

-- Same immutability treatment migrations/0148 gave `biome` on a
-- ring-generated candidate: elevation is the same kind of per-plot,
-- generation-time-only classification already protected by this trigger
-- for landlet_class/landlet_type/biome, so it joins them.
DROP TRIGGER protect_landlet_candidate_ring_member_geometry;

CREATE TRIGGER protect_landlet_candidate_ring_member_geometry
BEFORE UPDATE OF area_m2, center_x_m, center_y_m, landlet_class, landlet_type, biome, elevation_m, polygon_json, ring_id
ON landlet_candidates
WHEN OLD.ring_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'generated ring candidates are immutable');
END;
