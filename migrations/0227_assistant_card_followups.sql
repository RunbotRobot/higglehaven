-- #3532 part 2 (part of #3444): a shopper who passed an idea or a problem to
-- the team through an assistant hears what became of it. This row remembers
-- who to tell for a card the assistant filed (the card itself never names the
-- shopper's account, only a username in its private note). When the card is
-- marked done with a sentence written for the shopper, one notification goes
-- to them and told_at is set, so it is sent at most once. No message text is
-- kept here, and no row is created for a card that is not assistant-filed.
--
-- Keyed on user_id, a person-as-a-person fact ("Anything about a person as a
-- person keys on the account"); the row goes with the account.
CREATE TABLE assistant_card_followups (
  card_id TEXT PRIMARY KEY,
  shopper_user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  told_at TEXT
);

CREATE INDEX idx_assistant_card_followups_shopper ON assistant_card_followups (shopper_user_id);
