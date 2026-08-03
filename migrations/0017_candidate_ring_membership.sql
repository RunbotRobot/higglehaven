ALTER TABLE landlet_candidates
ADD COLUMN ring_id TEXT REFERENCES land_candidate_rings(ring_id);

CREATE INDEX idx_landlet_candidates_ring_listing
ON landlet_candidates(ring_id, created_at, landlet_id);
