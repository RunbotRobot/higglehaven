-- #2068 (leaf sub-issue of #1973/#1947, owner requirement): "On the build
-- screen looking at their land, they should be able to toggle on/off
-- grayed-out items that have disappeared which they haven't dismissed
-- yet." sweepSoldOutTemplateInstances (worker/index.js) previously just
-- hard-deleted every placed_instances row for a template that hit zero
-- stock, discarding its location entirely -- this table captures each
-- removed instance's own position before that delete runs, so Build mode
-- can still show a builder where something used to be.
--
-- template_id/template_name are NOT a live join back to catalog_templates
-- -- deliberately a snapshot, same "a permanent record must survive the
-- thing it references disappearing too" reasoning purchases.seller_id and
-- seller_feedback.seller_id already use (migrations/0051/0098's own
-- comments) -- the template that just sold out is exactly the kind of row
-- that can itself be deleted later, and the marker should keep reading
-- sensibly either way.
--
-- landlet_id IS a real FK with ON DELETE CASCADE: a marker's only purpose
-- is showing a builder something about their own land, so it has nothing
-- left to say once that landlet itself is gone (same reasoning
-- placed_instances.landlet_id's own CASCADE already uses).
CREATE TABLE IF NOT EXISTS sold_out_markers (
  marker_id TEXT PRIMARY KEY,
  landlet_id TEXT NOT NULL REFERENCES landlets(landlet_id) ON DELETE CASCADE,
  x_m REAL NOT NULL,
  y_m REAL NOT NULL,
  z_m REAL NOT NULL,
  template_id TEXT NOT NULL,
  template_name TEXT NOT NULL,
  sold_out_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  dismissed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sold_out_markers_landlet_id ON sold_out_markers(landlet_id);
