CREATE INDEX idx_placed_instances_landlet_template_created
ON placed_instances(landlet_id, template_id, created_at, instance_id);
