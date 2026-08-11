-- Dev-only reset: discard legacy annular geometry and placed-object history,
-- then give the original claimed land a real, exact-area organic polygon.

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
    polygon_json = '[{"x":17.650549,"y":-0.245902},{"x":18.118362,"y":7.251074},{"x":11.793775,"y":11.528813},{"x":7.141188,"y":16.948434},{"x":0.01906,"y":20.324168},{"x":-5.978521,"y":14.233539},{"x":-13.833546,"y":13.606703},{"x":-16.270311,"y":6.501376},{"x":-18.591956,"y":-0.245902},{"x":-15.365346,"y":-6.618332},{"x":-14.526176,"y":-14.791139},{"x":-5.978521,"y":-14.725344},{"x":0.01906,"y":-19.836446},{"x":6.766339,"y":-16.535274},{"x":11.793775,"y":-12.020617},{"x":17.213397,"y":-7.36803}]',
    generated_at = NULL,
    claimable_at = NULL,
    metadata_json = '{"generated":true,"generator":"organic-mosaic-v1","reset":"0030"}',
    active_version_id = NULL,
    max_world_radius_m = 20.324168,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE landlet_id = 'starter-landlet';
