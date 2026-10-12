-- #1690: sender_builder_id/recipient_builder_id were declared
-- `NOT NULL REFERENCES builders(builder_id) ON DELETE CASCADE` (migrations/
-- 0120) -- DELETE /api/builders/:id ("Reset your builder profile", an
-- ordinary unprivileged self-service action, NOT full account deletion)
-- was silently destroying every direct_messages row where the resetting
-- builder appeared in EITHER role, including every message the OTHER
-- party sent or received that had nothing to do with their own action.
-- This directly contradicts handleDirectMessages' own GET branch
-- (worker/index.js), which states the explicit design intent: "once sent,
-- a message stays visible in history the same way email/chat history
-- survives an unfriend."
--
-- Fixed the same way purchases.seller_id/seller_feedback.seller_id already
-- are (migrations/0051, 0098's own comment): dropped the FK entirely
-- rather than switching to ON DELETE SET NULL. SET NULL would still break
-- GET /api/direct-messages' own thread lookup -- it matches a thread by
-- comparing sender_builder_id/recipient_builder_id directly against the
-- other party's withBuilderId, and `NULL = withBuilderId` never matches
-- in SQL, so nulling either column would make the surviving party's own
-- messages permanently unreachable through that same query, not just
-- undeleted. Keeping the original builder_id value in place (just
-- un-enforced, the same plain-TEXT shape seller_id already uses) means
-- that query keeps matching exactly as before, with no other code change
-- needed, whether or not the id it names still resolves to a living row.
--
-- SQLite can't ALTER a column's FK constraint in place, so this rebuilds
-- the table (SQLite's documented recipe, same as migrations/0062). Nothing
-- holds a foreign key into direct_messages, so the migrations/0056-style
-- rebuild failure mode (other tables' FKs into the table being rebuilt)
-- doesn't apply here, same reasoning migrations/0062's own comment gives.
CREATE TABLE direct_messages_new (
  message_id TEXT PRIMARY KEY,
  sender_builder_id TEXT NOT NULL,
  recipient_builder_id TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  read_at TEXT
);

INSERT INTO direct_messages_new
  SELECT message_id, sender_builder_id, recipient_builder_id, text, created_at, read_at
  FROM direct_messages;

DROP TABLE direct_messages;
ALTER TABLE direct_messages_new RENAME TO direct_messages;

CREATE INDEX idx_direct_messages_sender ON direct_messages(sender_builder_id, created_at, message_id);
CREATE INDEX idx_direct_messages_recipient ON direct_messages(recipient_builder_id, created_at, message_id);
CREATE INDEX idx_direct_messages_recipient_unread ON direct_messages(recipient_builder_id, read_at);
