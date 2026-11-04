-- #3122: voice_conduct_reports (0160) and nearby_chat_reports (0172) had no
-- one-per-reporter rule, unlike product_flags (UNIQUE (template_id,
-- flagger_builder_id), 0131): one reporter could file the same report
-- against the same builder on every click, each with its own Control Room
-- card. Standing decisions: parity across sibling surfaces; weight by
-- signal, don't count raw events.
--
-- A repeat now collapses into the existing row (INSERT OR IGNORE against
-- these indexes, in worker/lib/social.js's fileConductReport) and appends a
-- line to the existing card. The key is the (reporter, reported) pair with no
-- time bucket: a later, genuinely new incident still reaches the admin
-- through the appended line, and the reporter sees nothing different.
--
-- Production may already hold duplicates, which would make CREATE UNIQUE
-- INDEX fail and break the deploy migration. Keep the earliest row per pair
-- (ties broken by report_id) and drop the rest. Nothing is lost beyond the
-- redundant rows: every report already has its own Control Room card
-- (task_id = report_id) carrying the reason, and those cards are left alone.
DELETE FROM voice_conduct_reports
WHERE EXISTS (
  SELECT 1 FROM voice_conduct_reports earlier
  WHERE earlier.reporter_builder_id = voice_conduct_reports.reporter_builder_id
    AND earlier.reported_builder_id = voice_conduct_reports.reported_builder_id
    AND (earlier.created_at < voice_conduct_reports.created_at
      OR (earlier.created_at = voice_conduct_reports.created_at AND earlier.report_id < voice_conduct_reports.report_id))
);
CREATE UNIQUE INDEX idx_voice_conduct_reports_pair ON voice_conduct_reports(reporter_builder_id, reported_builder_id);

DELETE FROM nearby_chat_reports
WHERE EXISTS (
  SELECT 1 FROM nearby_chat_reports earlier
  WHERE earlier.reporter_builder_id = nearby_chat_reports.reporter_builder_id
    AND earlier.reported_builder_id = nearby_chat_reports.reported_builder_id
    AND (earlier.created_at < nearby_chat_reports.created_at
      OR (earlier.created_at = nearby_chat_reports.created_at AND earlier.report_id < nearby_chat_reports.report_id))
);
CREATE UNIQUE INDEX idx_nearby_chat_reports_pair ON nearby_chat_reports(reporter_builder_id, reported_builder_id);
