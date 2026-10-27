-- #2819 (sub-issue of #2780, itself sub-issue of #2777, proximity voice
-- chat): the report half of the per-shopper mute + report mechanism
-- (#2778's own resolution: "Moderation beyond the trust-tier gate: report
-- mechanism + per-shopper mute both required"). Mute is purely local/
-- client-side (src/shop/voiceChat.js) and never touches the server; a
-- report needs a durable, admin-reviewable record, which is what this
-- table and its paired Control Room card (see handleVoiceReportCreate in
-- worker/lib/social.js) are for.
--
-- Deliberately its own table rather than reusing product_flags
-- (worker/lib/reputation.js): that table is keyed to a catalog_templates
-- listing with a seller strike ladder as its consequence model -- the
-- wrong unit (a product, not a builder) and the wrong consequence (an
-- automatic strike against a seller account) for "a builder said
-- something inappropriate over voice chat." This instead follows
-- worker/lib/feedback.js's bug-report shape: land directly in the
-- Control Room for a human to look at, with no automatic consequence of
-- its own, same "don't punish good-faith reports" philosophy
-- reputation.js's own product-flag comment already states for a
-- structurally similar zero-cost-to-the-reporter report.
--
-- Both builder_id columns cascade on delete -- a deleted builder's own
-- reports, or reports against them, have no reason to survive them, same
-- reasoning avatar_presence/voice_signaling_messages's own builder_id
-- columns use.
CREATE TABLE voice_conduct_reports (
  report_id TEXT PRIMARY KEY,
  reporter_builder_id TEXT NOT NULL REFERENCES builders(builder_id) ON DELETE CASCADE,
  reported_builder_id TEXT NOT NULL REFERENCES builders(builder_id) ON DELETE CASCADE,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- An admin reviewing a Control Room card wants this report's siblings
-- against the same builder at a glance (a repeat offender), same
-- "surfaced for a human, not auto-actioned" reasoning as this table's own
-- header comment.
CREATE INDEX idx_voice_conduct_reports_reported ON voice_conduct_reports(reported_builder_id, created_at);
