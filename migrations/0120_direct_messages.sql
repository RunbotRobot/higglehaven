-- #1637 (resolves #1002, owner go-ahead 2026-10-11): direct messages
-- between two id_verified builders who are already friends. Same "one
-- flexible shape" reasoning as notifications (migrations/0038) — a
-- "thread" is never anything more than "every row where these two ids
-- appear as sender/recipient in either order," so one table covers it
-- with no separate conversation/thread row needed.
CREATE TABLE direct_messages (
  message_id TEXT PRIMARY KEY,
  sender_builder_id TEXT NOT NULL REFERENCES builders(builder_id) ON DELETE CASCADE,
  recipient_builder_id TEXT NOT NULL REFERENCES builders(builder_id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  read_at TEXT
);

-- A thread query needs both directions of a pair (sender=me/recipient=them
-- OR sender=them/recipient=me) — same two-index-per-role shape
-- migrations/0112 already uses for friendships' requester/recipient roles,
-- since no single index can serve an OR across two different leading
-- columns as well as one index per role does.
CREATE INDEX idx_direct_messages_sender ON direct_messages(sender_builder_id, created_at, message_id);
CREATE INDEX idx_direct_messages_recipient ON direct_messages(recipient_builder_id, created_at, message_id);

-- Unread-count badge query, same shape as idx_notifications_builder_id.
CREATE INDEX idx_direct_messages_recipient_unread ON direct_messages(recipient_builder_id, read_at);
