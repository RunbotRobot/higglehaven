-- Adjacent polygonal rings are gap-free only when their sampled angular seams
-- match. Unknown legacy signatures are conservatively incompatible.

ALTER TABLE land_candidate_rings
ADD COLUMN boundary_signature TEXT;

CREATE TRIGGER reject_mismatched_adjacent_land_candidate_ring
BEFORE INSERT ON land_candidate_rings
WHEN EXISTS (
  SELECT 1 FROM land_candidate_rings
  WHERE (ABS(outer_radius_m - NEW.inner_radius_m) <= 0.0000001
      OR ABS(inner_radius_m - NEW.outer_radius_m) <= 0.0000001)
    AND COALESCE(boundary_signature, '') <> COALESCE(NEW.boundary_signature, '')
)
BEGIN
  SELECT RAISE(ABORT, 'generated ring boundary mismatch');
END;
