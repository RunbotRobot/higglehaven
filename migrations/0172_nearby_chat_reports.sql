-- #2956: parity with proximity voice chat's own mute + report pair
-- (#2819/migrations/0160_voice_conduct_reports.sql) -- resolved directly by
-- AGENTS.md's "Standing owner decisions" -> "Parity across sibling
-- surfaces" default (2026-11-02): a protection present on one sibling
-- surface (voice chat's report+mute pair) belongs on the other (general
-- proximity text chat) unless there's a stated reason it doesn't, and none
-- applies here.
--
-- Deliberately its own table rather than reusing voice_conduct_reports --
-- mirroring the shape is the point, not merging the two surfaces (nearby
-- chat is its own surface, not the same unit as voice). Mute is purely
-- local/client-side (src/shop/nearbyChat.js) and never touches this table;
-- a report needs a durable, admin-reviewable record, which is what this
-- table and its paired Control Room card (see handleNearbyChatReportCreate
-- in worker/lib/social.js) are for.
--
-- Both builder_id columns cascade on delete, same reasoning
-- voice_conduct_reports' own columns use.
CREATE TABLE nearby_chat_reports (
  report_id TEXT PRIMARY KEY,
  reporter_builder_id TEXT NOT NULL REFERENCES builders(builder_id) ON DELETE CASCADE,
  reported_builder_id TEXT NOT NULL REFERENCES builders(builder_id) ON DELETE CASCADE,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- An admin reviewing a Control Room card wants this report's siblings
-- against the same builder at a glance (a repeat offender), same reasoning
-- voice_conduct_reports' own index uses.
CREATE INDEX idx_nearby_chat_reports_reported ON nearby_chat_reports(reported_builder_id, created_at);
