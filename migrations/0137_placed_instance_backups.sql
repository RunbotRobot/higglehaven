-- #2050 (sub-issue of #1952, following up on #1948): lets a builder
-- configure an ordered backup/replacement chain for one specific placed
-- instance -- per-instance, not per-template, since two different
-- builders' placed instances of the same product each need their own
-- independent chain. instance_id is ON DELETE CASCADE (a backup chain is
-- meaningless once its own placed instance is gone -- unlike
-- saved_layout_instances/version_instances, this is live configuration,
-- not a historical snapshot). template_id is ON DELETE RESTRICT, same as
-- placed_instances' own template_id (migrations/0001) -- a catalog
-- template still queued as someone's backup must block deletion the same
-- way one that's actually placed already does (see
-- assertCatalogTemplatesDeletable's own extension for this table).
-- position is NOT UNIQUE: the application always keeps a chain's
-- positions contiguous (0, 1, 2, ...) on its own, and a reorder rewrites
-- every row's position in one batch -- a UNIQUE(instance_id, position)
-- constraint would only get in the way of that (SQLite UNIQUE
-- constraints, unlike FOREIGN KEY ones, cannot be declared DEFERRABLE).
CREATE TABLE IF NOT EXISTS placed_instance_backups (
  backup_id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES placed_instances(instance_id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  template_id TEXT NOT NULL REFERENCES catalog_templates(template_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_placed_instance_backups_instance_id ON placed_instance_backups(instance_id, position);
CREATE INDEX IF NOT EXISTS idx_placed_instance_backups_template_id ON placed_instance_backups(template_id);
