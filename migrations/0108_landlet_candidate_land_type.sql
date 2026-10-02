-- #1267 (surfaced during a backlog-exploration pass on world/terrain
-- generation): gives a land *candidate* the same land-type column
-- `migrations/0064_landlet_land_type.sql` gave a materialized `landlets`
-- row, so a water/non-buildable candidate can be queued and carried
-- through generation instead of only being producible by creating an
-- already-materialized landlet directly via the dev-only CRUD endpoint.
--
-- Same additive-column shape as 0064, for the same reason: `landlet_id`
-- is referenced by `landlet_candidate_rings` (`ring_id` back-reference) and
-- this table itself is the staging area for every real landlet, so a
-- rebuild-requiring approach carries the same real D1 risk 0064's own
-- comment documents for `landlets`. `ALTER TABLE ... ADD COLUMN` with its
-- own self-contained CHECK needs no rebuild and is fully backward
-- compatible: every existing row becomes 'buildable', matching today's
-- only-ever-buildable behavior exactly.
--
-- Nothing produces a 'water' candidate yet — this only makes the data
-- model capable of representing one, the same scope cut 0064 made for
-- `landlets` itself ("Nothing produces a 'water' landlet yet... This
-- issue only makes the data model capable of representing it").
ALTER TABLE landlet_candidates ADD COLUMN landlet_type TEXT NOT NULL DEFAULT 'buildable' CHECK (landlet_type IN ('buildable', 'water'));

CREATE INDEX IF NOT EXISTS idx_landlet_candidates_landlet_type ON landlet_candidates(landlet_type);

-- protect_landlet_candidate_ring_member_geometry (migrations/0084) already
-- locks a ring-generated candidate's geometry/classification columns
-- immutable post-generation (area_m2, center_x_m, center_y_m,
-- landlet_class, polygon_json, ring_id). landlet_type is the same kind of
-- per-plot classification landlet_class already is, so it gets the same
-- immutability rather than being left editable through the one column the
-- trigger doesn't know about yet.
DROP TRIGGER protect_landlet_candidate_ring_member_geometry;

CREATE TRIGGER protect_landlet_candidate_ring_member_geometry
BEFORE UPDATE OF area_m2, center_x_m, center_y_m, landlet_class, landlet_type, polygon_json, ring_id
ON landlet_candidates
WHEN OLD.ring_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'generated ring candidates are immutable');
END;
