-- #3121: a reported builder could erase every conduct report against them
-- by resetting their builder profile. DELETE /api/builders/:id is an
-- ordinary self-service action (see migration 0122's comment), and both
-- report tables declared reported_builder_id as ON DELETE CASCADE, so the
-- reports vanished with the builder row -- leaving only a Control Room card
-- whose note named a builder id that no longer resolved to a users account
-- (suspension is by user_id).
--
-- Fix, same shape migration 0165 used for commission_holds.builder_id: the
-- reported builder FK becomes ON DELETE SET NULL, and the report now also
-- records the reported account's user_id directly (plain TEXT, no FK -- the
-- point is that it survives the builder row, and a deleted account is a
-- separate, already-handled lifecycle). Existing rows are backfilled from
-- builders.user_id; rows already cascaded away cannot be recovered.
--
-- The reporter side stays ON DELETE CASCADE: a deleted reporter's own
-- reports have no durable evidentiary role the way a report against someone
-- does.
CREATE TABLE voice_conduct_reports_new (
  report_id TEXT PRIMARY KEY,
  reporter_builder_id TEXT NOT NULL REFERENCES builders(builder_id) ON DELETE CASCADE,
  reported_builder_id TEXT REFERENCES builders(builder_id) ON DELETE SET NULL,
  reported_user_id TEXT,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO voice_conduct_reports_new (report_id, reporter_builder_id, reported_builder_id, reported_user_id, reason, created_at)
  SELECT r.report_id, r.reporter_builder_id, r.reported_builder_id,
         (SELECT b.user_id FROM builders b WHERE b.builder_id = r.reported_builder_id),
         r.reason, r.created_at
  FROM voice_conduct_reports r;

DROP TABLE voice_conduct_reports;
ALTER TABLE voice_conduct_reports_new RENAME TO voice_conduct_reports;

CREATE INDEX idx_voice_conduct_reports_reported ON voice_conduct_reports(reported_builder_id, created_at);
CREATE INDEX idx_voice_conduct_reports_reported_user ON voice_conduct_reports(reported_user_id, created_at);

CREATE TABLE nearby_chat_reports_new (
  report_id TEXT PRIMARY KEY,
  reporter_builder_id TEXT NOT NULL REFERENCES builders(builder_id) ON DELETE CASCADE,
  reported_builder_id TEXT REFERENCES builders(builder_id) ON DELETE SET NULL,
  reported_user_id TEXT,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO nearby_chat_reports_new (report_id, reporter_builder_id, reported_builder_id, reported_user_id, reason, created_at)
  SELECT r.report_id, r.reporter_builder_id, r.reported_builder_id,
         (SELECT b.user_id FROM builders b WHERE b.builder_id = r.reported_builder_id),
         r.reason, r.created_at
  FROM nearby_chat_reports r;

DROP TABLE nearby_chat_reports;
ALTER TABLE nearby_chat_reports_new RENAME TO nearby_chat_reports;

CREATE INDEX idx_nearby_chat_reports_reported ON nearby_chat_reports(reported_builder_id, created_at);
CREATE INDEX idx_nearby_chat_reports_reported_user ON nearby_chat_reports(reported_user_id, created_at);
