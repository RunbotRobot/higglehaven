// #2987 (sub-issue 3/5 of #2305): the builder-facing half of #2986's
// suspended-seller snapshots (migrations/0174_suspended_seller_instance_snapshots.sql).
// When a seller is suspended, every placed instance of their products is
// removed from the world and snapshotted; the builder whose landlet it was
// removed from gets, per the "builder has full information and full
// autonomy" standing owner decision:
//
//   - GET /api/instances/pending-restoration -- what used to be on their
//     land and is waiting on a possible restoration (their own records only,
//     never visible to shoppers or other builders);
//   - DELETE /api/instances/pending-restoration/:snapshotId -- the
//     "permanently clear" action: discard the pending slot themselves
//     instead of waiting indefinitely. #2986's restore skips any snapshot
//     with cleared_at set, so a cleared slot never comes back on a later
//     unsuspension.
//
// The row is never deleted -- cleared_at is a soft marker -- so the
// product-identifying info stays queryable (#2988's "never left wondering
// what did I used to have here" requirement is built on top of that).
import { json, HttpError } from './http.js';
import { checkRateLimit } from './rate-limit.js';
import { requireSessionBuilder } from './auth.js';

const PENDING_RESTORATION_CLEAR_RATE_LIMIT_MAX = 100;
const PENDING_RESTORATION_LIST_MAX = 500;

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export function pendingRestorationFromRow(row) {
  const instance = safeParse(row.instance_json);
  return {
    snapshotId: row.snapshot_id,
    landletId: row.landlet_id,
    templateId: row.template_id,
    // Template fields come from a LEFT JOIN: a deleted template leaves
    // these null rather than hiding the slot (the builder still sees that
    // *something* used to be here; #2988 hardens what's retained).
    templateName: row.template_name ?? null,
    category: row.template_category ?? null,
    imageUrl: row.template_image_url ?? null,
    position: {
      x: instance.x_m ?? null,
      y: instance.y_m ?? null,
      z: instance.z_m ?? null,
    },
    removedAt: row.removed_at,
    // False once the suspension has been lifted but this slot could not be
    // restored (e.g. its template was deleted meanwhile) -- it stays
    // listed so the builder can clear it rather than waiting forever.
    sellerSuspended: Boolean(row.seller_suspended),
  };
}

export async function handlePendingRestoration(request, db, route) {
  // route is ['instances', 'pending-restoration'(, snapshotId)]
  const sessionBuilder = await requireSessionBuilder(request, db);

  if (request.method === 'GET' && route.length === 2) {
    const { results } = await db.prepare(`
      SELECT s.snapshot_id, s.landlet_id, s.template_id, s.instance_json, s.removed_at,
             t.name AS template_name, t.category AS template_category, t.image_url AS template_image_url,
             EXISTS (
               SELECT 1 FROM account_suspensions a
               WHERE a.user_id = sel.user_id AND a.lifted_at IS NULL AND a.escalated_at IS NULL
             ) AS seller_suspended
      FROM suspended_seller_instance_snapshots s
      JOIN landlets l ON l.landlet_id = s.landlet_id AND l.owner_builder_id = s.builder_id
      LEFT JOIN catalog_templates t ON t.template_id = s.template_id
      LEFT JOIN sellers sel ON sel.seller_id = s.seller_id
      WHERE s.builder_id = ? AND s.restored_at IS NULL AND s.cleared_at IS NULL
      ORDER BY s.removed_at DESC, s.snapshot_id
      LIMIT ?
    `).bind(sessionBuilder.builder_id, PENDING_RESTORATION_LIST_MAX).all();
    return json({ pendingRestorations: results.map(pendingRestorationFromRow) });
  }

  if (request.method === 'DELETE' && route.length === 3) {
    const snapshotId = route[2];
    await checkRateLimit(db, `pending-restoration-clear:${sessionBuilder.builder_id}`, PENDING_RESTORATION_CLEAR_RATE_LIMIT_MAX);
    // Ownership folded into the write itself (the #929 idiom): only the
    // builder the snapshot was taken for can clear it, and only while it's
    // still pending. A foreign or already-resolved id is indistinguishable
    // from a nonexistent one -- same 404 either way, no existence leak.
    const result = await db.prepare(`
      UPDATE suspended_seller_instance_snapshots
      SET cleared_at = ?
      WHERE snapshot_id = ? AND builder_id = ? AND restored_at IS NULL AND cleared_at IS NULL
    `).bind(new Date().toISOString(), snapshotId, sessionBuilder.builder_id).run();
    if (result.meta.changes === 0) throw new HttpError('Pending restoration not found', 404);
    return json({ clearedSnapshotId: snapshotId });
  }

  return json({ error: 'Not found' }, 404);
}
