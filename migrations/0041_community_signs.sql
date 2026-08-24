-- Community sign-post system (docs/SPEC.md §6: "Builders flag any placed
-- object as a 'community sign' — becomes a content-bearing slot.").
-- is_community_sign is per-*instance* (a specific placed object), not a
-- catalog-template flag — unlike flooring (migrations/0035), any single
-- placement of any product can independently become a sign.
ALTER TABLE placed_instances ADD COLUMN is_community_sign INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS sign_posts (
  post_id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES placed_instances(instance_id) ON DELETE CASCADE,
  author_label TEXT NOT NULL,
  text TEXT NOT NULL CHECK (length(text) > 0 AND length(text) <= 280),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_sign_posts_instance_id ON sign_posts(instance_id, created_at);
