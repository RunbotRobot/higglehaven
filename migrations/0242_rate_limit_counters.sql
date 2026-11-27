-- #4542: the sliding-window limiter counts a bucket's events with a COUNT(*)
-- over rate_limit_events on every call, so a bucket limited at 600 a window
-- reads up to 600 rows per request. The shop polls presence, nearby chat and
-- voice every second or so, and that read cost scales with the limit, which
-- matters on D1's free-tier rows-read budget. A poll bucket keeps one row
-- instead: the count in the current fixed window, upserted atomically.
CREATE TABLE IF NOT EXISTS rate_limit_counters (
  bucket_key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_counters_window ON rate_limit_counters (window_start);
