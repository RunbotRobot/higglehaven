-- #2764 (sub-issue of #2763, owner-requested): persistent Group/Ungroup for
-- placed items. The existing groupMovePivot mechanic (src/build/scene.js)
-- only ever lives for the duration of one drag -- nothing about a multi-
-- select group move survives a reload. This adds a real, persistent
-- grouping concept.
--
-- A single nullable `group_id` column, not a join table: an instance
-- belongs to at most one group (there's no many-to-many relationship to
-- model here), the same "a plain column is enough, a join table is
-- unneeded complexity" reasoning sold_out_markers.landlet_id/every other
-- simple FK-shaped relationship on this table already uses. `group_id` is
-- not itself a foreign key into another table -- it's just an opaque
-- shared key (a fresh UUID minted by POST /api/instances/group) that
-- happens to be equal across every member of one group; there is no
-- `instance_groups` row to reference. NULL means "not in a group," the
-- ordinary state for most instances.
ALTER TABLE placed_instances ADD COLUMN group_id TEXT;

-- Group/Ungroup's own lookups are always "every instance sharing this
-- group_id" (POST /api/instances/group's merge-into-one-group path,
-- POST /api/instances/ungroup's dissolve-the-whole-group path) -- same
-- "index whatever this feature's own real query pattern needs" reasoning
-- idx_placed_instances_landlet_id/idx_placed_instances_template_id
-- (migrations/0001_initial.sql) already follow for their own columns.
CREATE INDEX idx_placed_instances_group_id ON placed_instances(group_id);
