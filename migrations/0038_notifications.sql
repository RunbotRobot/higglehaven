-- Builder-facing notifications — currently used for exactly one thing:
-- telling a builder their placed instance's product just had its
-- real-world dimensions changed by the seller (see the catalog_templates
-- PATCH handler), so the builder knows to go check whether it still fits
-- where they put it. Deliberately generic (a plain message, not a typed
-- "dimension change" event) so future notification kinds don't need
-- their own table.
CREATE TABLE notifications (
  notification_id TEXT PRIMARY KEY,
  builder_id TEXT NOT NULL REFERENCES builders(builder_id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  -- Set null (not cascaded) if the template is later deleted — the
  -- message text already carries the product's name, so the notification
  -- itself is still meaningful without a live template to point at.
  template_id TEXT REFERENCES catalog_templates(template_id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  read_at TEXT
);

CREATE INDEX idx_notifications_builder_id ON notifications(builder_id, read_at);
