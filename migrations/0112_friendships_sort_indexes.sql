-- #1434: GET /api/friendships' list query filters on
-- `(requester_builder_id = ? OR recipient_builder_id = ?)` and sorts by
-- `created_at DESC, friendship_id DESC` -- the existing single-column
-- idx_friendships_requester/idx_friendships_recipient (migrations/0049)
-- support the OR's two halves individually, but neither covers the sort,
-- so every call still needs a full scan of this builder's rows (from
-- whichever index/scan satisfies the OR) plus a temporary-b-tree sort.
-- Composite indexes covering each side's own sort key let both halves of
-- the OR walk pre-sorted and the subsequent merge/sort operate over just
-- this builder's own rows rather than the whole table -- same fix shape
-- as #1433's idx_notifications_builder_created, applied here once per
-- side of the OR rather than once, since this table's two-sided
-- requester/recipient filter (unlike notifications' single builder_id)
-- has no one column both halves share.
CREATE INDEX IF NOT EXISTS idx_friendships_requester_created
  ON friendships(requester_builder_id, created_at, friendship_id);
CREATE INDEX IF NOT EXISTS idx_friendships_recipient_created
  ON friendships(recipient_builder_id, created_at, friendship_id);

-- The old single-column indexes are now a strict leftmost-prefix subset of
-- the composite ones above (same leading column, nothing after it that the
-- composite doesn't already cover) -- unlike #1433's own notifications case,
-- where the kept (builder_id, read_at) index serves a genuinely different
-- query shape, there's no remaining query here these still uniquely serve.
-- Dropping them rather than leaving dead weight on every write.
DROP INDEX IF EXISTS idx_friendships_requester;
DROP INDEX IF EXISTS idx_friendships_recipient;
