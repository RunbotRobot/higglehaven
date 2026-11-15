-- #3531 (part of #3444): has this assistant spoken to this shopper before?
-- An assistant introduces itself as an AI once per person, not at the start of
-- every reply (owner, 2026-11-15, after the first real conversation with
-- Juniper). Messages are deleted after 30 minutes, so "has it spoken to them"
-- cannot be read from them; this is a small fact of its own: which assistant,
-- which shopper, and when it last answered. No message text is kept here.
--
-- Keyed on user_id, a person-as-a-person fact ("Anything about a person as a
-- person keys on the account"). Dropped 30 days after the assistant last spoke
-- to that person (pruneStaleAssistantChat), after which they are a stranger
-- again and get the introduction once more.
CREATE TABLE assistant_contacts (
  shopper_user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  assistant_user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  first_spoke_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_spoke_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (shopper_user_id, assistant_user_id)
);

CREATE INDEX idx_assistant_contacts_last_spoke ON assistant_contacts (last_spoke_at);
