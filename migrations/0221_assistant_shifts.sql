-- #3449 (part of #3444): an assistant is in the world while its own session says
-- so. The session has no browser, so it cannot report a position the way a
-- shopper's page does; instead it keeps one row fresh with a heartbeat
-- (POST /api/assistant/heartbeat) and the server decides where the assistant
-- stands. A row that has not been refreshed recently means the assistant is off
-- shift and is not drawn.
CREATE TABLE assistant_shifts (
  user_id TEXT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  last_seen_at TEXT NOT NULL,
  -- 1 while the assistant is helping someone, so a shopper can tell a free
  -- assistant from a busy one (#3447/#3448 set it).
  busy INTEGER NOT NULL DEFAULT 0
);
