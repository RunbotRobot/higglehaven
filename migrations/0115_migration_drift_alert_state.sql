-- #1452: checkMigrationDrift (worker/index.js) re-sends its production
-- drift alert email on every */10 cron tick for as long as the drift
-- goes unfixed -- 144+ identical emails/day. Unlike warnInactiveLandletOwners'
-- own inactivity_warning_sent_at (migrations/0109), this alert isn't scoped
-- to any existing per-row entity (it's a single global ops condition, not
-- one per builder), so a dedicated singleton table is the simplest fit
-- rather than bolting an unrelated column onto world_settings or similar.
--
-- Same semantics as inactivity_warning_sent_at: NULL means "not yet
-- alerted for the current drift episode," set once the alert email is
-- sent, and cleared back to NULL by checkMigrationDrift itself the moment
-- drift resolves (missing.length === 0) -- so the *next* drift episode
-- alerts fresh rather than staying permanently silenced by one stale row.
CREATE TABLE IF NOT EXISTS migration_drift_alert_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  alerted_at TEXT
);

INSERT OR IGNORE INTO migration_drift_alert_state (id, alerted_at) VALUES (1, NULL);
