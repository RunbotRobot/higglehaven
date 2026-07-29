-- Initial D1 schema for the higglehaven backend API.
-- Plain "a" naming is intentional for internal code/DB/API names.

CREATE TABLE IF NOT EXISTS catalog_templates (
  template_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'placeholder',
  subcategory TEXT,
  color TEXT NOT NULL,
  width_m REAL NOT NULL CHECK (width_m > 0),
  depth_m REAL NOT NULL CHECK (depth_m > 0),
  height_m REAL NOT NULL CHECK (height_m > 0),
  price_cents INTEGER CHECK (price_cents IS NULL OR price_cents >= 0),
  seller_id TEXT,
  model_url TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS landlets (
  landlet_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  area_m2 REAL NOT NULL DEFAULT 1000 CHECK (area_m2 > 0),
  center_x_m REAL NOT NULL DEFAULT 0,
  center_y_m REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'greenbelt' CHECK (status IN ('greenbelt', 'claimed', 'generating')),
  owner_builder_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS placed_instances (
  instance_id TEXT PRIMARY KEY,
  landlet_id TEXT NOT NULL REFERENCES landlets(landlet_id) ON DELETE CASCADE,
  template_id TEXT NOT NULL REFERENCES catalog_templates(template_id) ON DELETE RESTRICT,
  x_m REAL NOT NULL,
  y_m REAL NOT NULL,
  z_m REAL NOT NULL DEFAULT 0,
  rotation_z_rad REAL NOT NULL DEFAULT 0,
  label TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_catalog_templates_category ON catalog_templates(category, subcategory);
CREATE INDEX IF NOT EXISTS idx_placed_instances_landlet_id ON placed_instances(landlet_id);
CREATE INDEX IF NOT EXISTS idx_placed_instances_template_id ON placed_instances(template_id);

INSERT OR IGNORE INTO landlets (landlet_id, name, area_m2, status)
VALUES ('starter-landlet', 'Starter landlet', 1000, 'claimed');

INSERT OR IGNORE INTO catalog_templates
  (template_id, name, category, subcategory, color, width_m, depth_m, height_m, price_cents, seller_id, metadata_json)
VALUES
  ('placeholder-table', 'Placeholder table', 'placeholder', 'furniture', '#8b5a2b', 2.0, 1.0, 0.8, NULL, 'dev-seller', '{"placeholder":true}'),
  ('placeholder-chair', 'Placeholder chair', 'placeholder', 'furniture', '#3366cc', 0.7, 0.7, 1.0, NULL, 'dev-seller', '{"placeholder":true}'),
  ('placeholder-tree', 'Placeholder tree', 'placeholder', 'landscape', '#2f8f46', 1.5, 1.5, 4.0, NULL, 'dev-seller', '{"placeholder":true}');
