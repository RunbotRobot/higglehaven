-- A ring reservation describes the complete immutable band. Individual member
-- geometry cannot move or disappear without invalidating that reservation.

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
