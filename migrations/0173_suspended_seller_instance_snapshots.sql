-- #2986 (sub-issue 2/5 of #2305): when a seller is suspended, every
-- already-placed instance of their listed products across every
-- builder's landlet is removed from the world and snapshotted here, so
-- unsuspending the seller can restore it exactly. Deliberately a new
-- table rather than reusing moderation_removal_snapshots (#2388) -- that
-- one is a forensic, admin-only, anonymous-by-design record never meant
-- to be read back by the system (no builder/landlet/position data at
-- all, and its own migration explicitly says it must never surface to
-- the content's own author); this one is the opposite -- restorable,
-- builder-visible (sub-issue 3, #2987), and keyed by exactly the fields
-- needed to recreate the removed instance and find it again by seller.
--
-- instance_json is the FULL placed_instances row at removal time (same
-- "snapshot the whole row, not hand-picked fields" idiom
-- 0171_version_instances_group_id.sql's own siblings already follow for
-- version_instances), so restoration doesn't need updating every time
-- placed_instances grows a new column.
--
-- seller_id/builder_id/landlet_id/template_id are denormalized out of
-- instance_json (rather than making every query parse it) since they're
-- exactly what auto-restore-on-unsuspend (by seller_id) and sub-issue 3's
-- builder-facing view (by builder_id) both need to look up by. No FK on
-- any of them, same reasoning moderation_removal_snapshots' own
-- (source_table, source_id) pair already gives: this row must survive
-- regardless of what later happens to the (possibly since-deleted)
-- builder/landlet/template/seller it describes -- restoration re-checks
-- liveness at the moment it runs instead.
--
-- restored_at/cleared_at are mutually exclusive terminal states (at most
-- one is ever non-NULL): restored_at is set once auto-restored on
-- unsuspend; cleared_at is set once the affected builder permanently
-- discards it instead (sub-issue 3's own "permanently clear" action) --
-- NULL/NULL means still pending.
CREATE TABLE suspended_seller_instance_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL,
  builder_id TEXT NOT NULL,
  landlet_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  instance_json TEXT NOT NULL,
  removed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  restored_at TEXT,
  cleared_at TEXT
);

-- Auto-restore-on-unsuspend's own access pattern: every still-pending
-- snapshot for a given seller.
CREATE INDEX idx_suspended_seller_instance_snapshots_seller ON suspended_seller_instance_snapshots (seller_id, restored_at, cleared_at);
-- Sub-issue 3's own future access pattern: every still-pending snapshot
-- for a given builder (the "pending restoration" view).
CREATE INDEX idx_suspended_seller_instance_snapshots_builder ON suspended_seller_instance_snapshots (builder_id, restored_at, cleared_at);
