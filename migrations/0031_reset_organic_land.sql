-- Dev-only reset: discard legacy annular geometry and placed-object history
-- for a fresh start on the new organic-mosaic layout.
--
-- starter-landlet's own shape is deliberately NOT hardcoded here. The
-- organic-mosaic-v1 template (worker/organicMosaicTemplate.js) always covers
-- the world origin as part of its 16-cell disc, so any independently
-- designed polygon placed here would permanently overlap whichever mosaic
-- cell lands on the origin. Instead, POST /api/land-candidates/generate-mosaic
-- detects that cell at request time and writes its polygon onto
-- 'starter-landlet' directly (see worker/index.js) — one shape at the
-- center by construction, not two overlapping ones. Until that endpoint is
-- called, starter-landlet reverts to the plain-square fallback the frontend
-- already renders for any landlet with an empty polygon.

-- migrations/0018_protect_ring_candidate_geometry.sql made ring-generated
-- candidate rows immutable (by design — a live ring reservation must not
-- have members move or disappear underneath it). This one-time reset needs
-- to clear them anyway, so the guard comes down for the duration of this
-- migration and goes back up identical to how 0018 left it, since the
-- legacy ring-generation endpoint remains in the Worker and any future ring
-- data should stay protected the same way.
DROP TRIGGER IF EXISTS protect_land_candidate_ring_member_delete;
DROP TRIGGER IF EXISTS protect_land_candidate_ring_member_geometry;

DELETE FROM version_instances;
DELETE FROM landlet_versions;
DELETE FROM placed_instances;
DELETE FROM landlet_candidates;
UPDATE land_candidate_rings SET adjacent_to_ring_id = NULL;
DELETE FROM land_candidate_rings;
DELETE FROM landlets WHERE landlet_id <> 'starter-landlet';

CREATE TRIGGER protect_land_candidate_ring_member_delete
BEFORE DELETE ON landlet_candidates
WHEN OLD.ring_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'generated ring candidates are immutable');
END;

CREATE TRIGGER protect_land_candidate_ring_member_geometry
BEFORE UPDATE OF area_m2, center_x_m, center_y_m, land_class, polygon_json, ring_id
ON landlet_candidates
WHEN OLD.ring_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'generated ring candidates are immutable');
END;

UPDATE landlets
SET name = 'Starter landlet',
    area_m2 = 1000,
    center_x_m = 0,
    center_y_m = 0,
    status = 'claimed',
    land_class = 1,
    polygon_json = '[]',
    generated_at = NULL,
    claimable_at = NULL,
    metadata_json = '{}',
    active_version_id = NULL,
    max_world_radius_m = NULL,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE landlet_id = 'starter-landlet';
