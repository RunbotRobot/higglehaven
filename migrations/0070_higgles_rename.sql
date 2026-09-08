-- #484/#485: rename the in-game currency "dállers" -> "higgles" (owner-
-- confirmed branding decision, Control Room msg-gyno3ytklaxjg4tw0b1h).
-- Renames only — no data migration needed, SQLite/D1 supports both
-- ALTER TABLE forms directly and preserves existing rows/indexes.
ALTER TABLE builders RENAME COLUMN dallers_balance_cents TO higgles_balance_cents;
ALTER TABLE daller_earnings_events RENAME TO higgles_earnings_events;
DROP INDEX IF EXISTS idx_daller_earnings_events_builder_id;
CREATE INDEX IF NOT EXISTS idx_higgles_earnings_events_builder_id ON higgles_earnings_events(builder_id, created_at);
