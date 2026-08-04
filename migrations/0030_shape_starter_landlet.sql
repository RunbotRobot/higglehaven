-- Give the original claimed plot real geometry instead of leaving it as the
-- polygonless bootstrap placeholder from 0001. The nine-sided outline is
-- centroided at the plot origin and has an area of 1,000 m2 (within the stored
-- decimal precision). It is intentionally a standalone central plot: annular
-- candidate rings remain independently gap-free bands rather than pretending
-- that a circular ring boundary can share this irregular outline.

UPDATE landlets
SET polygon_json = '[{"x":19.298255,"y":0.083298},{"x":13.466486,"y":10.279188},{"x":3.950273,"y":20.734521},{"x":-8.501981,"y":14.126593},{"x":-19.391884,"y":5.625503},{"x":-15.924690,"y":-7.312702},{"x":-8.211276,"y":-19.110675},{"x":6.212888,"y":-15.452342},{"x":17.353787,"y":-8.791467}]',
    max_world_radius_m = 21.107463,
    metadata_json = json_set(metadata_json, '$.geometry', 'designed-central-v1'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE landlet_id = 'starter-landlet'
  AND json_array_length(polygon_json) = 0;
