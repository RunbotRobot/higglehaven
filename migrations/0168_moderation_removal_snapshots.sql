-- #2388 (owner decision 2026-10-20): closes the asymmetry
-- user_content_edit_history (migrations/0129) left open -- that table
-- snapshots a row only when its own AUTHOR edits/deletes it ("in case of
-- disputes"); a moderator/admin removing someone else's sign_posts/
-- calendar_events/product_reviews row left no record anywhere of what
-- was actually removed, only (on the admin-override paths) a bare
-- admin_action_log row with a NULL detail_json.
--
-- Deliberately a separate table from user_content_edit_history, not a
-- shared one, per the owner's own reasoning: different actor/intent (a
-- moderator/admin acting on someone else's content, vs. an author's own
-- self-edit), different visibility (this must never surface to the
-- original author or to whoever reported the content -- admin-only,
-- unlike edit history which the frontend's own dispute-review UI may
-- eventually need to show the content's own author), and an
-- independently adjustable retention policy the category split below
-- needs.
--
-- removed_category drives retention directly, per the owner's own
-- category-based split: 'sexual_content' means snapshot_json stays NULL
-- forever -- "not in a snapshot, not even as a text fragment... no
-- exceptions" -- every other category gets a real snapshot, same
-- dispute-retention spirit as user_content_edit_history. The five
-- categories are the owner's own suggested set, open to refinement
-- later; CHECK enforces it's always one of them, never free text.
--
-- No FK on (source_table, source_id), same reasoning
-- user_content_edit_history's own migration gives for its identical
-- pair -- deliberately generic across content tables, and this row must
-- survive regardless of what later happens to the (already-deleted) live
-- row it describes.
CREATE TABLE moderation_removal_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  source_table TEXT NOT NULL,
  source_id TEXT NOT NULL,
  removed_category TEXT NOT NULL CHECK (removed_category IN ('harassment', 'spam', 'scam', 'sexual_content', 'other')),
  -- NULL exactly when removed_category = 'sexual_content' -- enforced in
  -- application code (worker/lib/content-moderation.js), not a CHECK
  -- here, since SQLite CHECK constraints can't cross-reference another
  -- column's value against a fixed string this cleanly without a more
  -- fragile expression.
  snapshot_json TEXT,
  -- ON DELETE SET NULL, not CASCADE -- same reasoning
  -- user_content_edit_history.actor_user_id already uses: a user row is
  -- never hard-deleted, and this record's whole point is to survive
  -- regardless of what happens to the account that performed the removal.
  removed_by_user_id TEXT REFERENCES users(user_id) ON DELETE SET NULL,
  removed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Same "looking up every removal for one specific row" access pattern
-- user_content_edit_history's own index serves.
CREATE INDEX idx_moderation_removal_snapshots_source ON moderation_removal_snapshots (source_table, source_id, removed_at);
