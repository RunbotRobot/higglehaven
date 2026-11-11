-- #3447 (part of #3444): a shopper asks an assistant a question, and the
-- assistant (its own Claude Code session, signed in as its own fleet account)
-- answers. This is the site's side of that: a small inbox per assistant.
--
-- One person at a time, by design (owner, 2026-11-11: "the limited number of
-- session avatars available for people to talk to provides a real-world feel"):
-- the two partial unique indexes below let an assistant hold one open
-- conversation, and a shopper be in one, enforced by the database rather than a
-- check-then-insert race.
CREATE TABLE assistant_conversations (
  conversation_id TEXT PRIMARY KEY,
  assistant_user_id TEXT NOT NULL REFERENCES users(user_id),
  shopper_user_id TEXT NOT NULL REFERENCES users(user_id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'ended')),
  -- 'shopper' | 'assistant' | 'timeout'. Null while open.
  ended_by TEXT CHECK (ended_by IS NULL OR ended_by IN ('shopper', 'assistant', 'timeout')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_activity_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ended_at TEXT,
  -- Set when the assistant's inbox poll has been told the conversation ended
  -- (so a shopper hanging up reaches the assistant exactly once).
  assistant_told_ended_at TEXT
);

CREATE UNIQUE INDEX idx_assistant_conversations_one_open_per_assistant
  ON assistant_conversations (assistant_user_id) WHERE status = 'open';
CREATE UNIQUE INDEX idx_assistant_conversations_one_open_per_shopper
  ON assistant_conversations (shopper_user_id) WHERE status = 'open';
CREATE INDEX idx_assistant_conversations_ended_at ON assistant_conversations (ended_at);

CREATE TABLE assistant_messages (
  message_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES assistant_conversations(conversation_id) ON DELETE CASCADE,
  sender TEXT NOT NULL CHECK (sender IN ('shopper', 'assistant')),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- A shopper message is "delivered" when the assistant's inbox poll returns
  -- it, so the poll hands each one over exactly once.
  delivered_at TEXT
);

CREATE INDEX idx_assistant_messages_conversation ON assistant_messages (conversation_id, created_at);
CREATE INDEX idx_assistant_messages_created_at ON assistant_messages (created_at);

-- When the assistant's session last checked in. An assistant is on shift while
-- this is recent; the inbox poll keeps it fresh.
ALTER TABLE users ADD COLUMN assistant_seen_at TEXT;
