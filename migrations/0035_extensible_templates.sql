-- Two placeholder box products to exercise the new crop/extensible
-- feature end to end: a door that can be trimmed narrower to fit a wall
-- gap, and a length of lumber that can be cut down like real dimensional
-- lumber. Both are plain colored boxes (no model_url) sized at their
-- seller-declared maximum along the extensible axis — width_m here,
-- which createMeshForInstance maps to the scene's local x. metadata_json's
-- "extensible" object is the seller-side declaration this feature reads;
-- placed_instances.crop_json (see 0034) holds the per-instance override.
INSERT OR IGNORE INTO catalog_templates
  (template_id, name, category, subcategory, color, width_m, depth_m, height_m, price_cents, seller_id, metadata_json)
VALUES
  ('door', 'Door', 'placeholder', 'building-material', '#8a6642', 1.0, 0.04, 2.03, NULL, 'dev-seller',
   '{"placeholder":true,"extensible":{"x":{"minM":0.4}}}'),
  ('lumber-board', 'Lumber board', 'placeholder', 'building-material', '#c9a876', 2.4, 0.089, 0.038, NULL, 'dev-seller',
   '{"placeholder":true,"extensible":{"x":{"minM":0.1}}}');
