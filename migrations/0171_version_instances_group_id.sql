-- #2968: same reasoning 0034_instance_crop.sql, 0036_instance_scale.sql,
-- and 0060_version_instances_community_flags.sql already applied here --
-- a published snapshot (and the archived-version mirror 0140 established
-- "column-for-column") shouldn't silently drop an instance's group
-- membership just because it went through a version save/restore.
-- 0154_placed_instance_groups.sql added group_id only to placed_instances,
-- never to version_instances/archived_version_instances -- the same kind
-- of oversight 0060's own comment already describes fixing twice before.
ALTER TABLE version_instances ADD COLUMN group_id TEXT;
ALTER TABLE archived_version_instances ADD COLUMN group_id TEXT;
