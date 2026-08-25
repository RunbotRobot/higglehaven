-- Land cap — the growth-gating mechanic (docs/SPEC.md §3), explicitly
-- distinct from land ACQUISITION (§5's auctions, migrations/0045): how much
-- total lándlet area a builder may own at once, gated by demonstrated
-- performance (trailing dáller earnings) rather than purchasable with real
-- cash. Every signup starts with exactly enough cap for the one free
-- starter lándlet (1,000 m²) every builder can already claim unconditionally.
ALTER TABLE builders ADD COLUMN land_cap_m2 INTEGER NOT NULL DEFAULT 1000;

-- A per-event earnings ledger, not just the running dallers_balance_cents
-- total (migrations/0045) — the land-cap formula needs a genuine trailing-
-- 30-day WINDOW of earnings ("trailing-30-day dáller earnings per 1,000 m²
-- owned"), which a running lifetime total alone can't answer.
CREATE TABLE IF NOT EXISTS daller_earnings_events (
  event_id TEXT PRIMARY KEY,
  builder_id TEXT NOT NULL REFERENCES builders(builder_id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_daller_earnings_events_builder_id ON daller_earnings_events(builder_id, created_at);
