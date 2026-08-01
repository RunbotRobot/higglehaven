-- Keep cursor-paginated landlet discovery efficient as the world grows.

CREATE INDEX IF NOT EXISTS idx_landlets_created
ON landlets(created_at, landlet_id);

CREATE INDEX IF NOT EXISTS idx_landlets_status_created
ON landlets(status, created_at, landlet_id);

CREATE INDEX IF NOT EXISTS idx_landlets_owner_created
ON landlets(owner_builder_id, created_at, landlet_id);

CREATE INDEX IF NOT EXISTS idx_landlets_status_owner_created
ON landlets(status, owner_builder_id, created_at, landlet_id);
