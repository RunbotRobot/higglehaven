-- #814 (foundational sub-issue of #813): admin-gated mutations (grant
-- admin, 1099 approve/file/void, land-cap/higgles balance grants,
-- world-generation tooling, refund overrides — ~15 endpoints total, see
-- #813's own body) recorded *whether* an action was allowed, but never
-- *who* performed it. This is a permanent accountability record, so
-- admin_user_id uses ON DELETE SET NULL rather than CASCADE — same "keep
-- the record, drop the live reference" reasoning migrations/0062 and
-- 0086 already use for purchases.builder_id/higgles_redemptions.builder_id,
-- applied here because a log entry losing its own row on the acting
-- admin's later account deletion would defeat the point of having an
-- audit trail at all.
--
-- Deliberately generic/write-only for this first landing (mirrors
-- notifications' own "one flexible shape, not a typed table per kind"
-- reasoning, migrations/0038) — detail_json carries whatever a given
-- action_type needs, and there's no admin-facing UI to browse this yet;
-- see #813's own body for why that's an intentional, separate follow-up.
CREATE TABLE admin_action_log (
  log_id TEXT PRIMARY KEY,
  admin_user_id TEXT REFERENCES users(user_id) ON DELETE SET NULL,
  action_type TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  detail_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_admin_action_log_admin_user_id ON admin_action_log(admin_user_id, created_at);
CREATE INDEX idx_admin_action_log_action_type ON admin_action_log(action_type, created_at);
