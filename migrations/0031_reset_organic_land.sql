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

DELETE FROM version_instances;
DELETE FROM landlet_versions;
DELETE FROM placed_instances;
DELETE FROM landlet_candidates;
UPDATE land_candidate_rings SET adjacent_to_ring_id = NULL;
DELETE FROM land_candidate_rings;
DELETE FROM landlets WHERE landlet_id <> 'starter-landlet';

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
