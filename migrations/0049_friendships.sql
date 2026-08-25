-- Friend requests (docs/SPEC.md §2: "Friend/group systems: standard friend
-- requests; social map shows friends' approximate location.") A friendship
-- is one row shared by both builders, direction preserved
-- (requester/recipient) so the frontend can tell "you sent this" from "you
-- received this" without a separate table, and status flips from pending to
-- accepted in place rather than deleting-and-recreating a row on accept.
-- Uniqueness of an unordered pair (A-B is the same relationship as B-A) is
-- enforced in application code, not a DB constraint — SQLite has no clean
-- way to express "unique regardless of column order" declaratively, and
-- this codebase already validates comparable invariants (e.g. duplicate
-- claims) in the Worker rather than in schema.
CREATE TABLE IF NOT EXISTS friendships (
  friendship_id TEXT PRIMARY KEY,
  requester_builder_id TEXT NOT NULL REFERENCES builders(builder_id) ON DELETE CASCADE,
  recipient_builder_id TEXT NOT NULL REFERENCES builders(builder_id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_friendships_requester ON friendships(requester_builder_id);
CREATE INDEX IF NOT EXISTS idx_friendships_recipient ON friendships(recipient_builder_id);
