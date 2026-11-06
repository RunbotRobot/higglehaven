-- #3148 (5/6 of #3141): conduct reports key both people on the account.
-- 0182 made the reported side survive a profile reset (reported_user_id); the
-- reporter side still hung off reporter_builder_id with ON DELETE CASCADE, and
-- the one-per-reporter rule (0184) keyed on the two builder ids. Either party
-- resetting their builder profile therefore dodged it: a reporter's reset
-- deleted their reports (so they could file a fresh card for the same person),
-- and a reported person's reset produced a new builder id the rule had never
-- seen. Per AGENTS.md ("Anything about a person as a person keys on the
-- account"), the rule now keys on (reporter_user_id, reported_user_id).
--
-- reporter_builder_id stays as a plain nullable TEXT with no foreign key
-- (nothing reads it after this change; 6/6 drops it), so a reporter's profile
-- reset no longer takes their reports with it. reported_builder_id keeps its
-- ON DELETE SET NULL. A reporter deleting their whole account still removes
-- their own reports: cascadeDeleteAccount does it explicitly now that the
-- foreign key is gone.
--
-- Existing rows are backfilled from builders.user_id. Production may already
-- hold more than one row per account pair (the old rule was per builder pair,
-- and a reset made a new builder id), which would make CREATE UNIQUE INDEX
-- fail and break the deploy migration, so the earliest row per account pair
-- is kept (ties broken by report_id) and the rest dropped, as 0184 did. The
-- dropped rows' Control Room cards (task_id = report_id) are left alone.
-- A row whose reporter or reported builder had no recoverable account keeps a
-- NULL user id and is left in place; NULLs never collide in the unique index.
CREATE TABLE voice_conduct_reports_new (
  report_id TEXT PRIMARY KEY,
  reporter_user_id TEXT,
  reported_user_id TEXT,
  reporter_builder_id TEXT,
  reported_builder_id TEXT REFERENCES builders(builder_id) ON DELETE SET NULL,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO voice_conduct_reports_new (report_id, reporter_user_id, reported_user_id, reporter_builder_id, reported_builder_id, reason, created_at)
  SELECT r.report_id,
         (SELECT b.user_id FROM builders b WHERE b.builder_id = r.reporter_builder_id),
         r.reported_user_id, r.reporter_builder_id, r.reported_builder_id, r.reason, r.created_at
  FROM voice_conduct_reports r;

DROP TABLE voice_conduct_reports;
ALTER TABLE voice_conduct_reports_new RENAME TO voice_conduct_reports;

DELETE FROM voice_conduct_reports
WHERE reporter_user_id IS NOT NULL AND reported_user_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM voice_conduct_reports earlier
    WHERE earlier.reporter_user_id = voice_conduct_reports.reporter_user_id
      AND earlier.reported_user_id = voice_conduct_reports.reported_user_id
      AND (earlier.created_at < voice_conduct_reports.created_at
        OR (earlier.created_at = voice_conduct_reports.created_at AND earlier.report_id < voice_conduct_reports.report_id))
  );

CREATE UNIQUE INDEX idx_voice_conduct_reports_pair ON voice_conduct_reports(reporter_user_id, reported_user_id);
CREATE INDEX idx_voice_conduct_reports_reported ON voice_conduct_reports(reported_builder_id, created_at);
CREATE INDEX idx_voice_conduct_reports_reported_user ON voice_conduct_reports(reported_user_id, created_at);

CREATE TABLE nearby_chat_reports_new (
  report_id TEXT PRIMARY KEY,
  reporter_user_id TEXT,
  reported_user_id TEXT,
  reporter_builder_id TEXT,
  reported_builder_id TEXT REFERENCES builders(builder_id) ON DELETE SET NULL,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO nearby_chat_reports_new (report_id, reporter_user_id, reported_user_id, reporter_builder_id, reported_builder_id, reason, created_at)
  SELECT r.report_id,
         (SELECT b.user_id FROM builders b WHERE b.builder_id = r.reporter_builder_id),
         r.reported_user_id, r.reporter_builder_id, r.reported_builder_id, r.reason, r.created_at
  FROM nearby_chat_reports r;

DROP TABLE nearby_chat_reports;
ALTER TABLE nearby_chat_reports_new RENAME TO nearby_chat_reports;

DELETE FROM nearby_chat_reports
WHERE reporter_user_id IS NOT NULL AND reported_user_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM nearby_chat_reports earlier
    WHERE earlier.reporter_user_id = nearby_chat_reports.reporter_user_id
      AND earlier.reported_user_id = nearby_chat_reports.reported_user_id
      AND (earlier.created_at < nearby_chat_reports.created_at
        OR (earlier.created_at = nearby_chat_reports.created_at AND earlier.report_id < nearby_chat_reports.report_id))
  );

CREATE UNIQUE INDEX idx_nearby_chat_reports_pair ON nearby_chat_reports(reporter_user_id, reported_user_id);
CREATE INDEX idx_nearby_chat_reports_reported ON nearby_chat_reports(reported_builder_id, created_at);
CREATE INDEX idx_nearby_chat_reports_reported_user ON nearby_chat_reports(reported_user_id, created_at);
