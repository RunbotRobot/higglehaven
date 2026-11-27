-- #4560: GET /api/credit-orbs?landletId=... filters on landlet_id, but credit_orbs was indexed only on
-- collected_at and spawned_at, so `landlet_id = ? AND collected_at IS NULL` walked every uncollected orb in
-- the world (149 rows a call live) and the shop polls it about once a second per person. This index lets both
-- orb queries (still uncollected, and collected a moment ago) read only the asked-about landlet's rows.
CREATE INDEX IF NOT EXISTS idx_credit_orbs_landlet_collected ON credit_orbs (landlet_id, collected_at);
