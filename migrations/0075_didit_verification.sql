-- #589 (sub-issue of #556, docs/SPEC.md §6): government-ID verification via
-- Didit (https://didit.me/), the higher trust tier that gates full social
-- features. One row per Didit verification session this app has started,
-- so the session-create endpoint has somewhere to record what it started
-- and the result webhook has a real row to update — processed_at is the
-- same atomic-guard idiom used elsewhere in this codebase (e.g.
-- purchases.paid_out_at) to make a duplicate webhook delivery a no-op
-- rather than needing a separate SELECT-then-UPDATE.
CREATE TABLE didit_verification_sessions (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  processed_at TEXT
);

-- Looked up by user_id when starting a new session (to reuse/report an
-- already-pending one) and when polling status.
CREATE INDEX idx_didit_verification_sessions_user_id ON didit_verification_sessions(user_id, created_at);
