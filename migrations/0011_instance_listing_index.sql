-- Support stable, bounded draft-instance listing within each landlet.

CREATE INDEX IF NOT EXISTS idx_placed_instances_landlet_created
ON placed_instances(landlet_id, created_at, instance_id);
