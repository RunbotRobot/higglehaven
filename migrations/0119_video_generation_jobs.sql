-- #1619 (sub-issue of #1616, docs/SPEC.md): video-to-3D generation via
-- Tripo3D (https://developers.tripo3d.com/) — a seller uploads a few
-- still frames extracted client-side from a walkaround video of a real
-- object, and this backend kicks off an async multiview-to-model job,
-- tracks it to completion (poll or webhook, whichever lands first), and
-- stores the resulting mesh in the same MODELS R2 bucket/content-addressed
-- shape POST /api/models already produces, so the client-side model
-- optimizer pipeline (the pipeline-wiring sub-issue) needs no special-
-- casing for this source versus a direct upload.
--
-- One row per job. `job_id` is a local id handed to the frontend to poll
-- with, independent of Tripo's own `provider_task_id` — the job row is
-- created (reserved) before the Tripo task-create call, so there's
-- somewhere to record the reservation even if that outbound call never
-- completes. `processed_at` is the same atomic terminal-state guard this
-- codebase already uses for didit_verification_sessions/purchases.paid_out_at
-- — whichever of the webhook or a status poll gets there first applies the
-- result; the other is a safe no-op.
CREATE TABLE video_generation_jobs (
  job_id TEXT PRIMARY KEY,
  builder_id TEXT NOT NULL REFERENCES builders(builder_id),
  provider_task_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'complete', 'failed')),
  model_url TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  processed_at TEXT
);

-- Looked up by builder_id when starting a new job (to reuse/report an
-- already-in-flight one) and when polling status.
CREATE INDEX idx_video_generation_jobs_builder_id ON video_generation_jobs(builder_id, created_at);

-- Same defense-in-depth backstop as
-- idx_didit_verification_sessions_one_pending_per_user (migrations/0095) —
-- each job maps to a real, billed Tripo generation call
-- (~$0.20-0.30/generation), so two concurrent requests from the same
-- builder must never both reach it. worker/index.js's
-- reserveVideoGenerationJob folds this into an atomic
-- INSERT ... WHERE NOT EXISTS before ever calling Tripo; this unique
-- partial index backs that guard at the schema level too.
CREATE UNIQUE INDEX idx_video_generation_jobs_one_pending_per_builder
  ON video_generation_jobs(builder_id) WHERE processed_at IS NULL;

-- Tripo's webhook delivery (task.completed/task.failed) looks up the local
-- job row by the provider's own task_id.
CREATE UNIQUE INDEX idx_video_generation_jobs_provider_task_id ON video_generation_jobs(provider_task_id);
