-- Wires the three original seeded catalog rows up to real glTF models
-- (public/models/), same as migration 0002 did for brick — previously
-- these had no model_url and rendered as plain colored boxes. chair/tree
-- keep their existing declared dimensions (new models were authored to
-- match exactly); table's model was authored at 1.4x0.8x0.75 (matching
-- the frontend fallback catalog's own table, reusing the same asset
-- instead of shipping a near-duplicate model), so its dimensions are
-- updated to match.
--
-- Names drop the "Placeholder " prefix too — these are real distinct
-- models now, not a shared generic box standing in for every product.

UPDATE catalog_templates
SET name = 'Table', width_m = 1.4, depth_m = 0.8, height_m = 0.75, model_url = '/models/table.glb'
WHERE template_id = 'placeholder-table';

UPDATE catalog_templates
SET name = 'Chair', model_url = '/models/chair.glb'
WHERE template_id = 'placeholder-chair';

UPDATE catalog_templates
SET name = 'Tree', model_url = '/models/tree.glb'
WHERE template_id = 'placeholder-tree';
