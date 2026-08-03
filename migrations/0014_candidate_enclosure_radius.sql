-- Track both radial bounds so generation can reject annular bands that would
-- overlap already-planned land without scanning every candidate. NULL keeps
-- pre-migration rows in the conservative conflict set.

ALTER TABLE landlet_candidates
ADD COLUMN max_world_radius_m REAL CHECK (max_world_radius_m IS NULL OR max_world_radius_m >= 0);

UPDATE landlet_candidates
SET max_world_radius_m = CASE
  WHEN json_array_length(polygon_json) = 0 THEN
    sqrt(center_x_m * center_x_m + center_y_m * center_y_m) + sqrt(area_m2 / 3.141592653589793)
  ELSE (
    SELECT MAX(sqrt(
      (center_x_m + CAST(json_extract(point.value, '$.x') AS REAL))
        * (center_x_m + CAST(json_extract(point.value, '$.x') AS REAL))
      + (center_y_m + CAST(json_extract(point.value, '$.y') AS REAL))
        * (center_y_m + CAST(json_extract(point.value, '$.y') AS REAL))
    ))
    FROM json_each(landlet_candidates.polygon_json) AS point
  )
END;

CREATE INDEX IF NOT EXISTS idx_landlet_candidates_radial_bounds
ON landlet_candidates(min_world_radius_m, max_world_radius_m);
