-- Adds a real-model-backed "brick" catalog template — the concrete example
-- for moving off placeholder box products: a brick is a product you can
-- buy and place repeatedly to build a wall. model_url points at the
-- static glTF asset shipped alongside the frontend (public/models/,
-- served from the same origin as this Worker's static assets).

INSERT OR IGNORE INTO catalog_templates
  (template_id, name, category, subcategory, color, width_m, depth_m, height_m, price_cents, seller_id, model_url, metadata_json)
VALUES
  ('brick', 'Brick', 'placeholder', 'building-material', '#a0522d', 0.2, 0.095, 0.057, NULL, 'dev-seller', '/models/brick.glb', '{"placeholder":true}');
