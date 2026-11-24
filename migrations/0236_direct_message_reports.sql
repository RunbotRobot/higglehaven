-- #4169: a report for direct messages, the one conversation surface without one ("Parity across sibling
-- surfaces", the same default #2956 applied to nearby chat). Mirrors nearby_chat_reports as it stands after
-- 0202: keyed on the two accounts only, one row per reporter and reported pair, and it never holds a message:
-- only who reported whom and an optional reason of at most 280 characters, so a report gives an admin no way to
-- read a private thread (the question #2040 asks about is not raised here).
CREATE TABLE direct_message_reports (
  report_id TEXT PRIMARY KEY,
  reporter_user_id TEXT,
  reported_user_id TEXT,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX idx_direct_message_reports_pair ON direct_message_reports(reporter_user_id, reported_user_id);
CREATE INDEX idx_direct_message_reports_reported_user ON direct_message_reports(reported_user_id, created_at);
