-- #1756 (*No silent loss*, re-triaged on the issue): removing a landlet level
-- sweeps its instances into a reusable saved layout so the removal is "not a
-- silent loss", but sign_posts and calendar_events reference placed_instances
-- with ON DELETE CASCADE, so every post and event written on a swept community
-- sign or calendar was destroyed with the instance, while the saved layout kept
-- the community flag and made a later paste look like a restored sign. These
-- tables snapshot that content alongside the saved instance so a paste can put
-- it back. Rows go with the saved layout (ON DELETE CASCADE on the layout); the
-- author's user_id is SET NULL like the live tables' own (0125, 0135).
CREATE TABLE IF NOT EXISTS saved_layout_sign_posts (
  saved_layout_id TEXT NOT NULL REFERENCES saved_level_layouts(saved_layout_id) ON DELETE CASCADE,
  source_instance_id TEXT NOT NULL,
  author_label TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  user_id TEXT REFERENCES users(user_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_saved_layout_sign_posts_instance
  ON saved_layout_sign_posts(saved_layout_id, source_instance_id, created_at);

CREATE TABLE IF NOT EXISTS saved_layout_calendar_events (
  saved_layout_id TEXT NOT NULL REFERENCES saved_level_layouts(saved_layout_id) ON DELETE CASCADE,
  source_instance_id TEXT NOT NULL,
  author_label TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  scheduled_at TEXT,
  triggered_at TEXT,
  user_id TEXT REFERENCES users(user_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_saved_layout_calendar_events_instance
  ON saved_layout_calendar_events(saved_layout_id, source_instance_id, created_at);
