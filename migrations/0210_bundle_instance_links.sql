-- #3327 (leaf 4/7 of #3323, "groups and bundles become one feature"): a
-- placed bundle instance remembers which saved bundle (template) it came
-- from, so a later edit of the template can reach every linked placement
-- (leaf 6/7) and the owner of a placement can be told (leaf 7/7).
--
-- A column on placed_instances, not a join table: a bundle instance is
-- already just "the rows sharing one group_id" (0154_placed_instance_groups),
-- so the link rides on the same rows, set on every member of the group. 6/7's
-- "every linked placement" is then one indexed query
-- (SELECT DISTINCT group_id, landlet_id FROM placed_instances WHERE bundle_id = ?)
-- and a template delete needs no cleanup pass: ON DELETE SET NULL leaves the
-- placements in the world as ordinary, unlinked bundle instances (nothing
-- disappears from anyone's land; "No silent loss").
--
-- Invariant the application maintains: bundle_id IS NOT NULL implies group_id
-- IS NOT NULL, and every member of one group shares one bundle_id. Grouping
-- again (a fresh group_id) or ungrouping clears the link; only Save Bundle and
-- placing from the picker set it. group_id keeps its name: it is the
-- bundle-instance id (renaming it would touch every snapshot path for no
-- behaviour change).
ALTER TABLE placed_instances ADD COLUMN bundle_id TEXT REFERENCES bundles(bundle_id) ON DELETE SET NULL;
CREATE INDEX idx_placed_instances_bundle_id ON placed_instances(bundle_id);

-- Version and archived-version snapshots carry the link the way
-- 0171_version_instances_group_id carries group_id. Plain TEXT with no FK:
-- these are historical copies that must outlive the template, so restoring
-- one re-verifies the link against the live bundle and the live group rather
-- than trusting the stored value (worker/lib/land.js).
ALTER TABLE version_instances ADD COLUMN bundle_id TEXT;
ALTER TABLE archived_version_instances ADD COLUMN bundle_id TEXT;
