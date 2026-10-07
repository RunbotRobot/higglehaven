-- #1441: GET /api/bundles (both the "my bundles" branch and the shared=true
-- community-tab branch) and GET /api/builders/me/saved-layouts each sort by
-- `created_at DESC, <id> DESC` for cursor pagination, but neither table's
-- existing index covers that sort -- same "schema-only change, add the
-- missing tiebreak column" shape as #1433's idx_notifications_builder_created
-- and #1434's idx_friendships_requester_created/idx_friendships_recipient_created.
--
-- idx_bundles_builder_id (builder_id, created_at) -- migrations/0039 -- and
-- idx_bundles_shared (created_at) WHERE shared = 1 -- migrations/0040 -- are
-- each a strict leftmost-prefix subset of their composite replacement below
-- (same leading column(s), nothing after it the composite doesn't already
-- cover), so -- same reasoning as #1434's migration -- they're dropped here
-- rather than left as dead weight on every bundle write.
CREATE INDEX IF NOT EXISTS idx_bundles_builder_created
  ON bundles(builder_id, created_at, bundle_id);
CREATE INDEX IF NOT EXISTS idx_bundles_shared_created
  ON bundles(created_at, bundle_id) WHERE shared = 1;
DROP INDEX IF EXISTS idx_bundles_builder_id;
DROP INDEX IF EXISTS idx_bundles_shared;

-- idx_saved_level_layouts_builder_id (builder_id, created_at DESC) --
-- migrations/0080 -- is likewise a strict leftmost-prefix subset of the
-- composite below once saved_layout_id is added; dropped for the same
-- reason.
CREATE INDEX IF NOT EXISTS idx_saved_level_layouts_builder_created
  ON saved_level_layouts(builder_id, created_at, saved_layout_id);
DROP INDEX IF EXISTS idx_saved_level_layouts_builder_id;
