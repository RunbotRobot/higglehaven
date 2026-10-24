-- #2719 (sub-issue of #2715, "[Tracking] In-app 'Submit Feedback' bug
-- reports with automatic rendering-state capture"): durable storage for
-- what #2717's client-side ring buffer and #2718's "Submit Feedback" UI
-- already capture and POST to POST /api/feedback/bug-report
-- (worker/lib/feedback.js). One row per submitted report.
--
-- Screenshot bytes go to their own dedicated FEEDBACK R2 bucket
-- (higglehaven-feedback, wrangler.jsonc), not the existing shared MODELS
-- bucket #2719's own body points at as "the existing bucket pattern" --
-- MODELS already carries a five-way reference-checking scheme
-- (catalog_templates.model_url/image_url, video_generation_jobs.model_url,
-- control_room_tasks/control_room_replies.image_url) that
-- scheduledModelCleanup (worker/lib/models.js) relies on to sweep anything
-- unreferenced every 10 minutes. A bug report is never "referenced" by a
-- living row the way those five are -- it has no deduplication and no
-- obvious owner to check for continued use -- so reusing MODELS would mean
-- either retrofitting that whole checking scheme for a shape that doesn't
-- fit it, or risk scheduledModelCleanup silently deleting every feedback
-- screenshot within minutes of submission. A second, dedicated bucket
-- (same "one bucket per concern" shape DB_BACKUPS already established
-- alongside MODELS) sidesteps that entirely: nothing sweeps it
-- automatically, which is also the right default until the still-open
-- owner retention-policy/moderation question (#2715's own body) is
-- answered. screenshot_url (nullable: #2718's own UI still submits when a
-- screenshot capture fails) holds the servable API path this feature's
-- own GET /api/feedback/bug-reports/:reportId/screenshot returns, not a
-- raw R2 key.
--
-- user_id is nullable with ON DELETE SET NULL -- same accountability-
-- record reasoning as admin_action_log.admin_user_id (migrations/0087):
-- #2718's own UI submits `userId: currentAuthUser?.userId ?? null`, so a
-- report can be anonymous from the start, and even one submitted while
-- logged in should outlive that account's later deletion rather than
-- disappear.
--
-- webgl_renderer/webgl_vendor/user_agent/platform/render_state_buffer_json
-- stay flat/JSON-in-TEXT columns, mirroring admin_action_log's own
-- detail_json and control_room_tasks' own sub_issue_summaries -- this data
-- is only ever displayed (#2720's Control Room surfacing), never queried
-- on.
CREATE TABLE bug_reports (
  report_id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(user_id) ON DELETE SET NULL,
  screenshot_url TEXT,
  description TEXT,
  webgl_renderer TEXT,
  webgl_vendor TEXT,
  user_agent TEXT,
  platform TEXT,
  render_state_buffer_json TEXT,
  submitted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- #2720's own Control Room surfacing will list these newest-first, the
-- same "one index on the sort column" shape admin_action_log's own
-- idx_admin_action_log_action_type (created_at second column) and this
-- table's sibling tables already use.
CREATE INDEX idx_bug_reports_created_at ON bug_reports(created_at);
