-- Backs a simple fixed-window rate limiter for the unauthenticated,
-- email-triggering auth endpoints (signup, password-reset-request) — see
-- checkRateLimit in worker/index.js. No new Cloudflare bindings needed;
-- this is deliberately just a D1 table so it behaves identically in local
-- dev, CI, and production.
CREATE TABLE rate_limit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bucket_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Every query either scans one bucket's recent rows (the count check) or
-- deletes one bucket's expired rows (the prune step) — both filter on
-- bucket_key first, then created_at.
CREATE INDEX idx_rate_limit_events_bucket_created ON rate_limit_events (bucket_key, created_at);
