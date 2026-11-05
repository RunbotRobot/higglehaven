-- #3146 (3/6 of #3141): direct_messages key on the account (users.user_id),
-- not the resettable builder profile. Owner decision 2026-11-05 (AGENTS.md,
-- "Anything about a person as a person keys on the account"): a builder
-- profile can be reset to a brand-new builder_id through ordinary
-- self-service, which used to orphan a person's whole DM history from them
-- (the thread lookup matched the old builder_id, which no longer belonged to
-- anyone). Follows the pattern in docs/API.md, "Moving a table from builder
-- ids to user ids" (#3144).
--
-- Rebuilt rather than ALTERed because the old sender_builder_id/
-- recipient_builder_id columns were NOT NULL and are no longer written: they
-- are kept as plain nullable TEXT, unread by any code, for 6/6 (#3149) to
-- drop. Plain TEXT with no foreign key and no cascade, same as 0122: a
-- thread must outlive the other party's profile reset or account deletion.
--
-- Backfill: user ids come from builders.user_id. A row whose builder was
-- already reset or has no account (user_id NULL, migrations/0054) cannot be
-- resolved, so it keeps its builder ids, gets NULL user ids, and is left in
-- place (no silent loss) -- it is simply no longer reachable through the
-- user-keyed queries, exactly as it was already unreachable to anyone whose
-- current builder_id differed from the stored one.
CREATE TABLE direct_messages_new (
  message_id TEXT PRIMARY KEY,
  sender_user_id TEXT,
  recipient_user_id TEXT,
  sender_builder_id TEXT,
  recipient_builder_id TEXT,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  read_at TEXT
);

INSERT INTO direct_messages_new
  (message_id, sender_user_id, recipient_user_id, sender_builder_id, recipient_builder_id, text, created_at, read_at)
SELECT
  dm.message_id,
  (SELECT user_id FROM builders WHERE builder_id = dm.sender_builder_id),
  (SELECT user_id FROM builders WHERE builder_id = dm.recipient_builder_id),
  dm.sender_builder_id, dm.recipient_builder_id, dm.text, dm.created_at, dm.read_at
FROM direct_messages dm;

DROP TABLE direct_messages;
ALTER TABLE direct_messages_new RENAME TO direct_messages;

-- The old three indexes (0120/0122), re-expressed on the user-id columns.
CREATE INDEX idx_direct_messages_sender_user ON direct_messages(sender_user_id, created_at, message_id);
CREATE INDEX idx_direct_messages_recipient_user ON direct_messages(recipient_user_id, created_at, message_id);
CREATE INDEX idx_direct_messages_recipient_user_unread ON direct_messages(recipient_user_id, read_at);
