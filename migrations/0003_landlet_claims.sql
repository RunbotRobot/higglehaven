-- Enforce the dev MVP rule that a builder may own one claimed starter landlet.

CREATE UNIQUE INDEX IF NOT EXISTS idx_landlets_one_claimed_per_builder
ON landlets(owner_builder_id)
WHERE status = 'claimed' AND owner_builder_id IS NOT NULL;
