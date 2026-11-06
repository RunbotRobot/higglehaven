-- #3149 (6/6 of #3141): drop the retired builder-id columns from the social
-- tables. Sub-issues 2/6-5/6 moved every reader and writer to the account
-- (users.user_id) and left the old columns in place, nullable and unwritten, so
-- the cut-over could be reverted while it was in flight. Per AGENTS.md ("One
-- model, not a hybrid") nothing reads both after this: the ephemeral set
-- (presence, nearby chat, voice signaling, friend voice channels) already lost
-- its builder columns in 0201, so what is left is:
--   friendships            requester_builder_id, recipient_builder_id
--   direct_messages        sender_builder_id,    recipient_builder_id
--   voice_conduct_reports  reporter_builder_id,  reported_builder_id
--   nearby_chat_reports    reporter_builder_id,  reported_builder_id
--
-- No silent loss: before a column goes, one last backfill fills any user id
-- that is still NULL while the builder row it came from still resolves (the
-- earlier backfills ran once, at their own deploy). Rows whose builder never
-- had an account, or no longer exists, keep NULL user ids -- they were already
-- unreachable (every query matches on user ids) and the builder id was the only
-- thing they ever held, which no longer names anyone. They are left in place,
-- not deleted. Control Room cards for reports are untouched; each already
-- carries the reported builder's id and label in its note.
UPDATE friendships SET requester_user_id = (SELECT b.user_id FROM builders b WHERE b.builder_id = friendships.requester_builder_id)
  WHERE requester_user_id IS NULL AND requester_builder_id IS NOT NULL;
UPDATE friendships SET recipient_user_id = (SELECT b.user_id FROM builders b WHERE b.builder_id = friendships.recipient_builder_id)
  WHERE recipient_user_id IS NULL AND recipient_builder_id IS NOT NULL;
UPDATE direct_messages SET sender_user_id = (SELECT b.user_id FROM builders b WHERE b.builder_id = direct_messages.sender_builder_id)
  WHERE sender_user_id IS NULL AND sender_builder_id IS NOT NULL;
UPDATE direct_messages SET recipient_user_id = (SELECT b.user_id FROM builders b WHERE b.builder_id = direct_messages.recipient_builder_id)
  WHERE recipient_user_id IS NULL AND recipient_builder_id IS NOT NULL;
UPDATE voice_conduct_reports SET reporter_user_id = (SELECT b.user_id FROM builders b WHERE b.builder_id = voice_conduct_reports.reporter_builder_id)
  WHERE reporter_user_id IS NULL AND reporter_builder_id IS NOT NULL;
UPDATE voice_conduct_reports SET reported_user_id = (SELECT b.user_id FROM builders b WHERE b.builder_id = voice_conduct_reports.reported_builder_id)
  WHERE reported_user_id IS NULL AND reported_builder_id IS NOT NULL;
UPDATE nearby_chat_reports SET reporter_user_id = (SELECT b.user_id FROM builders b WHERE b.builder_id = nearby_chat_reports.reporter_builder_id)
  WHERE reporter_user_id IS NULL AND reporter_builder_id IS NOT NULL;
UPDATE nearby_chat_reports SET reported_user_id = (SELECT b.user_id FROM builders b WHERE b.builder_id = nearby_chat_reports.reported_builder_id)
  WHERE reported_user_id IS NULL AND reported_builder_id IS NOT NULL;

-- friendships and direct_messages: the builder columns carry no index, foreign
-- key, key or CHECK any more (0192 and 0191 removed them), so a plain DROP COLUMN
-- is enough and copies no rows.
ALTER TABLE friendships DROP COLUMN requester_builder_id;
ALTER TABLE friendships DROP COLUMN recipient_builder_id;
ALTER TABLE direct_messages DROP COLUMN sender_builder_id;
ALTER TABLE direct_messages DROP COLUMN recipient_builder_id;

-- The report tables still carry reported_builder_id as a foreign key
-- (ON DELETE SET NULL) with its own index, which DROP COLUMN refuses, so they
-- are rebuilt (the 0165/0182 shape). The unique one-per-reporter index on the
-- account pair and the reported-account index are recreated as they were.
CREATE TABLE voice_conduct_reports_new (
  report_id TEXT PRIMARY KEY,
  reporter_user_id TEXT,
  reported_user_id TEXT,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO voice_conduct_reports_new (report_id, reporter_user_id, reported_user_id, reason, created_at)
  SELECT report_id, reporter_user_id, reported_user_id, reason, created_at FROM voice_conduct_reports;
DROP TABLE voice_conduct_reports;
ALTER TABLE voice_conduct_reports_new RENAME TO voice_conduct_reports;
CREATE UNIQUE INDEX idx_voice_conduct_reports_pair ON voice_conduct_reports(reporter_user_id, reported_user_id);
CREATE INDEX idx_voice_conduct_reports_reported_user ON voice_conduct_reports(reported_user_id, created_at);

CREATE TABLE nearby_chat_reports_new (
  report_id TEXT PRIMARY KEY,
  reporter_user_id TEXT,
  reported_user_id TEXT,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO nearby_chat_reports_new (report_id, reporter_user_id, reported_user_id, reason, created_at)
  SELECT report_id, reporter_user_id, reported_user_id, reason, created_at FROM nearby_chat_reports;
DROP TABLE nearby_chat_reports;
ALTER TABLE nearby_chat_reports_new RENAME TO nearby_chat_reports;
CREATE UNIQUE INDEX idx_nearby_chat_reports_pair ON nearby_chat_reports(reporter_user_id, reported_user_id);
CREATE INDEX idx_nearby_chat_reports_reported_user ON nearby_chat_reports(reported_user_id, created_at);
