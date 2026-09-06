-- In-flight R2 storage reservations for POST /api/models (issue #264).
-- getStorageUsage's own R2 bucket listing can't be read as part of an
-- atomic D1 statement, so two concurrent uploads could otherwise both
-- read "usage is under the cap" before either R2 put actually lands,
-- jointly overrunning MAX_TOTAL_STORAGE_BYTES. This ledger tracks bytes
-- reserved but not yet confirmed present in R2 (or confirmed abandoned),
-- so a concurrent upload's still-in-flight reservation is visible inside
-- the same atomic INSERT ... WHERE check checkRateLimit already uses for
-- its own check-then-act race (see handleModelUpload). Rows are deleted
-- once their upload either lands in R2 or fails, so the ledger only ever
-- tracks what's genuinely still pending; pruneExpiredAuthState also
-- sweeps any row old enough to be an abandoned reservation from a request
-- that crashed before cleaning up after itself.
CREATE TABLE model_upload_reservations (
  reservation_id TEXT PRIMARY KEY,
  size_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_model_upload_reservations_created ON model_upload_reservations (created_at);
