-- #3140 (sub-issue 1/2 of #3124, owner-approved 2026-11-05): a durable,
-- silent block between two people. Keyed on the account (user_id), not the
-- resettable builder_id ("Anything about a person as a person keys on the
-- account"), as plain TEXT ids with no foreign key so the record survives
-- the other party's profile reset -- the same reasoning direct_messages
-- (0122) and the conduct reports (0182) give. Account deletion removes a
-- person's rows in both directions explicitly (cascadeDeleteAccount).
-- This migration only lands the table; the per-surface filters that make a
-- block take effect are #3143 (2/2).
CREATE TABLE IF NOT EXISTS user_blocks (
  blocker_user_id TEXT NOT NULL,
  blocked_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (blocker_user_id, blocked_user_id)
);
-- The per-surface filters ask "who has blocked this person" (and the
-- reverse), so the blocked side needs its own index.
CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked ON user_blocks(blocked_user_id);
