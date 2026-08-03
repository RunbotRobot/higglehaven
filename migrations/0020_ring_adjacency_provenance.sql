ALTER TABLE land_candidate_rings
ADD COLUMN adjacent_to_ring_id TEXT REFERENCES land_candidate_rings(ring_id);

CREATE UNIQUE INDEX idx_land_candidate_rings_adjacent_parent
ON land_candidate_rings(adjacent_to_ring_id)
WHERE adjacent_to_ring_id IS NOT NULL;

CREATE TRIGGER validate_land_candidate_ring_adjacency_parent
BEFORE INSERT ON land_candidate_rings
WHEN NEW.adjacent_to_ring_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM land_candidate_rings AS parent
  WHERE parent.ring_id = NEW.adjacent_to_ring_id
    AND ABS(parent.outer_radius_m - NEW.inner_radius_m) <= 0.0000001
    AND COALESCE(parent.boundary_signature, '') = COALESCE(NEW.boundary_signature, '')
)
BEGIN
  SELECT RAISE(ABORT, 'generated ring adjacency parent mismatch');
END;
