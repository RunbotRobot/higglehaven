-- Saved groups of items a builder can stamp down together in one tap (see
-- docs/API.md's "Bundles" section) — a named, persisted version of the same
-- relative-offset shape Copy/Paste already builds in memory
-- (copySelection/placeClipboardItems in src/main.js), just written to D1 so
-- it survives a reload and can be reused across landlets/sessions. Private
-- to the owning builder for now — no "shared" visibility flag yet (see
-- docs/SPEC.md's "explicit opt-in sharing to a community bundle tab",
-- still an open item).
CREATE TABLE bundles (
  bundle_id TEXT PRIMARY KEY,
  builder_id TEXT NOT NULL REFERENCES builders(builder_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- JSON array of { templateId, dx, dy, dz, rotationX, rotationY,
  -- rotationZ, crop, scale } — exactly placeClipboardItems' own `items`
  -- shape, so loading a bundle needs no translation before it can be
  -- placed the same way a Paste is.
  items_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_bundles_builder_id ON bundles(builder_id, created_at);
