-- #1645: video_generation_jobs.builder_id (migrations/0119) was declared
-- `NOT NULL REFERENCES builders(builder_id)` with no ON DELETE clause at
-- all, i.e. D1/SQLite's default restrictive NO ACTION -- the one
-- REFERENCES builders(builder_id)/REFERENCES users(user_id) FK in this
-- entire schema still missing an explicit ON DELETE behavior (migrations/
-- 0091 and 0093 closed every other one). DELETE /api/builders/:id throws
-- an unhandled constraint-violation error for any builder who has ever
-- started a video-to-3D job, instead of succeeding.
--
-- ON DELETE CASCADE, not SET NULL: this table is a generation-job log
-- (pending/processing/complete/failed), not a financial ledger like
-- purchases/higgles_redemptions (whose own builder_id uses SET NULL so a
-- *different* party's receipt survives) -- matching owned_animations/
-- avatar_ownership/notifications's own CASCADE choice, since a job log
-- for a now-deleted builder has no reason to outlive the account.
--
-- SQLite can't ALTER a column's FK action in place, so this rebuilds the
-- table (SQLite's documented recipe, migrations/0062/0091's own
-- precedent). Nothing holds a foreign key into video_generation_jobs
-- (confirmed: no other migration declares `REFERENCES
-- video_generation_jobs(...)` anywhere in this directory), so this
-- rebuild only drops/recreates the referencing table itself -- the same
-- "safe to rebuild directly" case 0091 found for sellers/
-- didit_verification_sessions, not the riskier one it found for builders
-- itself (which other tables' own CASCADE/SET NULL foreign keys make
-- unsafe to rebuild this same way).
CREATE TABLE video_generation_jobs_new (
  job_id TEXT PRIMARY KEY,
  builder_id TEXT NOT NULL REFERENCES builders(builder_id) ON DELETE CASCADE,
  provider_task_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'complete', 'failed')),
  model_url TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  processed_at TEXT
);

INSERT INTO video_generation_jobs_new
  SELECT job_id, builder_id, provider_task_id, status, model_url, error_message, created_at, processed_at
  FROM video_generation_jobs;

DROP TABLE video_generation_jobs;
ALTER TABLE video_generation_jobs_new RENAME TO video_generation_jobs;

CREATE INDEX idx_video_generation_jobs_builder_id ON video_generation_jobs(builder_id, created_at);

CREATE UNIQUE INDEX idx_video_generation_jobs_one_pending_per_builder
  ON video_generation_jobs(builder_id) WHERE processed_at IS NULL;

CREATE UNIQUE INDEX idx_video_generation_jobs_provider_task_id ON video_generation_jobs(provider_task_id);
