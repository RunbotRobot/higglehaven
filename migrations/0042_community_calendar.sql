-- Community calendar (docs/SPEC.md §6: "Community calendar reuses the
-- identical pattern [as community signs], builder-authored (event
-- postings, creative-tool support like a scheduled confetti-cannon
-- trigger)."). A deliberately separate flag/table from community signs
-- (migrations/0041), not a generalized "board kind" — the two are
-- structurally similar today but calendar events are the more likely of
-- the two to grow fielded data (actual date/time, RSVPs) later, at which
-- point a shared abstraction would need reworking anyway. Duplicating a
-- small, well-understood pattern now is cheaper than guessing at that
-- shape today.
ALTER TABLE placed_instances ADD COLUMN is_community_calendar INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS calendar_events (
  event_id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES placed_instances(instance_id) ON DELETE CASCADE,
  author_label TEXT NOT NULL,
  text TEXT NOT NULL CHECK (length(text) > 0 AND length(text) <= 280),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_calendar_events_instance_id ON calendar_events(instance_id, created_at);
