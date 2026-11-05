-- #3145 (2/6 of #3141): friendships key on the account (users.user_id), not on
-- the resettable builder profile. Owner decision 2026-11-05 (AGENTS.md):
-- "Anything about a person as a person keys on the account". Follows the
-- pattern documented in docs/API.md, "Moving a table from builder ids to user
-- ids".
--
-- Why a rebuild and not just two new columns: the table's builder-id columns
-- were REFERENCES builders(builder_id) ON DELETE CASCADE (0049/0093), so
-- resetting a builder profile deleted that person's friendships. The old
-- columns are kept (plain TEXT, nullable, no foreign key, no cascade) only so
-- no row loses information; nothing reads or writes them any more, and 6/6
-- of #3141 drops them.
--
-- Backfill: each side's user id comes from builders.user_id. A row whose
-- builder has no account (user_id NULL) keeps its builder ids and gets a NULL
-- user id; it is not dropped (no silent loss), and is simply inert until 6/6
-- because every reader matches on the user-id columns. Builders only gain
-- friendships through authenticated requests, so this should be zero rows in
-- practice.
--
-- The 0112 sort indexes belonged to the old table and go with it; they are
-- re-expressed on the user-id columns below.
CREATE TABLE friendships_new (
  friendship_id TEXT PRIMARY KEY,
  requester_user_id TEXT,
  recipient_user_id TEXT,
  requester_builder_id TEXT,
  recipient_builder_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO friendships_new (
  friendship_id, requester_user_id, recipient_user_id, requester_builder_id, recipient_builder_id, status, created_at
)
SELECT
  f.friendship_id,
  (SELECT b.user_id FROM builders b WHERE b.builder_id = f.requester_builder_id),
  (SELECT b.user_id FROM builders b WHERE b.builder_id = f.recipient_builder_id),
  f.requester_builder_id,
  f.recipient_builder_id,
  f.status,
  f.created_at
FROM friendships f;

DROP TABLE friendships;
ALTER TABLE friendships_new RENAME TO friendships;

CREATE INDEX idx_friendships_requester_user_created
  ON friendships(requester_user_id, created_at, friendship_id);
CREATE INDEX idx_friendships_recipient_user_created
  ON friendships(recipient_user_id, created_at, friendship_id);
