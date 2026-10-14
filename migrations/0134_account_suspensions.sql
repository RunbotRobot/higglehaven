-- #2029 (sub-issue of #1201, owner-settled shape across the 2026-10-01/
-- 10-07/10-13 comments on #1201): an admin-initiated, reversible account
-- suspension -- not a new column on users, but a dedicated table, since
-- the owner explicitly wants "longer suspension log retention and greater
-- detail" preserved across possibly-multiple suspend/lift cycles on the
-- same account, not a single set of columns a later suspension would
-- overwrite. user_id is deliberately NOT a foreign key, same reasoning as
-- admin_action_log's own target_id (#814's migration comment) and
-- product_flags' template_id/flagger_builder_id (#2017/migrations/0131) --
-- this is a permanent trust-and-safety record that must survive account
-- deletion (including the very escalation this table itself can trigger,
-- see #2033), not cascade away with it.
CREATE TABLE IF NOT EXISTS account_suspensions (
  suspension_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  admin_user_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence_note TEXT,
  suspended_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  grace_period_ends_at TEXT NOT NULL,
  lifted_at TEXT,
  lifted_by_admin_user_id TEXT,
  escalated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_account_suspensions_user ON account_suspensions(user_id);

-- #2030/#2033 both need to find "the currently-active suspension for this
-- user" (not lifted, not yet escalated) without scanning every historical
-- row -- a partial index keyed on exactly that predicate.
CREATE INDEX IF NOT EXISTS idx_account_suspensions_active ON account_suspensions(user_id)
  WHERE lifted_at IS NULL AND escalated_at IS NULL;
