-- #3448 (part of #3444): an assistant can hand a conversation to another one on
-- shift (end of shift, or the other is better placed). The conversation row
-- moves to the second assistant; these columns record that it did, so the
-- second assistant's inbox is handed the conversation so far exactly once and
-- the shopper's panel can say who they are talking to now.
ALTER TABLE assistant_conversations ADD COLUMN handed_over_from_user_id TEXT REFERENCES users(user_id) ON DELETE SET NULL;
ALTER TABLE assistant_conversations ADD COLUMN handed_over_at TEXT;
-- Set when the new assistant's inbox poll has been given the handover.
ALTER TABLE assistant_conversations ADD COLUMN handover_told_at TEXT;

-- Which assistant wrote a reply, so the log keeps naming the right one after a
-- handover. Null for a shopper's message, and for replies written before this.
ALTER TABLE assistant_messages ADD COLUMN author_user_id TEXT REFERENCES users(user_id) ON DELETE SET NULL;
