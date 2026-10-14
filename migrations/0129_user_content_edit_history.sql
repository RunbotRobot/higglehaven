-- #1975 (owner decision, 2026-10-13): "I want all users to be able to
-- modify or delete any of their previous posts, comments, or feedback.
-- Maybe we should keep a record of the original content internally in
-- case of disputes." This is that record -- a single, generic table
-- shared across every free-text, user-authored content type this applies
-- to (product_reviews first, more to follow), rather than a bespoke
-- history table per content type. Modeled loosely on admin_action_log's
-- (migrations/0087) "one flexible table across kinds" shape, but storing
-- a full snapshot of the row as it existed right before the user's own
-- edit/delete, not just a description of the action.
--
-- No FK on (source_table, source_id) -- deliberately generic across
-- tables, the same reason admin_action_log's own target_type/target_id
-- pair isn't an FK either. snapshot_json captures the row's own columns
-- at that moment (JSON-serialized, not a live reference), so it survives
-- regardless of what later happens to the live row.
CREATE TABLE user_content_edit_history (
  history_id TEXT PRIMARY KEY,
  source_table TEXT NOT NULL,
  source_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('edit', 'delete')),
  snapshot_json TEXT NOT NULL,
  -- ON DELETE SET NULL, not CASCADE: a user row is never hard-deleted
  -- (migrations/0102's own comment), and this record's whole point is to
  -- survive regardless -- same reasoning sign_posts.user_id (0125) and
  -- purchases.buyer_builder_id already use for the same shape.
  actor_user_id TEXT REFERENCES users(user_id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Looking up every past version of one specific row (the actual "in case
-- of a dispute" access pattern) is the only query shape this table needs
-- to serve well.
CREATE INDEX idx_user_content_edit_history_source ON user_content_edit_history (source_table, source_id, created_at);
