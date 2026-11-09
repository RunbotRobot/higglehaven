// #3327 (leaf 4/7 of #3323): a placed bundle instance is "the rows sharing one
// group_id" (migrations/0154), and a *linked* one also carries the saved
// bundle's id in placed_instances.bundle_id (migrations/0210). Several write
// paths accept a client-supplied groupId/bundleId pair so a Delete+Undo or a
// Restore-to-Editor can put an instance back where it was. Those values are
// visible to anyone via GET /api/instances, so neither is trusted on its own
// (#2959/#2968 for groupId). The rule, in one place:
//
//   a groupId is honored only when the caller already owns at least one live
//   member of that group; the bundleId rides with it only when that live group
//   is itself linked to exactly that bundle.
//
// So a crafted create can neither attach an instance to someone else's group
// nor claim a link its group does not have. Anything else comes back as null
// (an ordinary, unlinked instance), which is always safe.
//
// Returns Map<groupId, bundleId | null> for the verified groups only.
export async function verifyOwnedGroupLinks(db, instances, builderId) {
  const candidateGroupIds = [...new Set(instances.map((instance) => instance.groupId).filter(Boolean))];
  const verified = new Map();
  if (candidateGroupIds.length === 0) return verified;
  const placeholders = candidateGroupIds.map(() => '?').join(', ');
  const { results } = await db.prepare(`
    SELECT group_id, bundle_id FROM placed_instances
    WHERE group_id IN (${placeholders})
      AND EXISTS (SELECT 1 FROM landlets WHERE landlet_id = placed_instances.landlet_id AND owner_builder_id = ?)
  `).bind(...candidateGroupIds, builderId).all();
  for (const row of results) {
    if (!verified.has(row.group_id)) {
      verified.set(row.group_id, row.bundle_id ?? null);
    } else if (verified.get(row.group_id) !== (row.bundle_id ?? null)) {
      // Members of one group disagree about the link (should not happen; the
      // write paths keep it uniform). Trust none of it.
      verified.set(row.group_id, null);
    }
  }
  return verified;
}

// The { groupId, bundleId } a recreated instance may carry, given the map
// verifyOwnedGroupLinks returned.
export function honoredGroupLink(instance, verified) {
  if (!instance.groupId || !verified.has(instance.groupId)) return { groupId: null, bundleId: null };
  const liveBundleId = verified.get(instance.groupId);
  return {
    groupId: instance.groupId,
    bundleId: liveBundleId && instance.bundleId === liveBundleId ? liveBundleId : null,
  };
}
