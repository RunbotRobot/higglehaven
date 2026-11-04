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
//   - (#2988) a slot whose seller's suspension escalated to a permanent
//     closure stays listed, flagged `permanentAt`, with its product info
//     retained on the snapshot itself rather than read from a template
//     that may by then be gone;
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
    // #2988: the live template wins while it still exists (so a rename is
    // reflected), but the snapshot's own retained copy (taken at removal
    // time) backs it up indefinitely -- the builder is never left wondering
    // what used to be here once the template, or the seller's whole
    // account, is gone.
    templateName: row.live_template_name ?? row.template_name ?? null,
    category: row.live_template_category ?? row.template_category ?? null,
    imageUrl: row.live_template_image_url ?? row.template_image_url ?? null,
    position: {
      x: instance.x_m ?? null,
      y: instance.y_m ?? null,
      z: instance.z_m ?? null,
    },
    removedAt: row.removed_at,
    // #3095: the id the removed placement had, so a Build tab that was open
    // when the removal happened can drop exactly those meshes (and nothing
    // else -- never an item the builder just placed that hasn't reached the
    // server yet). A restore gets a fresh id, so this one never comes back.
    removedInstanceId: instance.instance_id ?? null,
    // False once the suspension has been lifted but this slot could not be
    // restored (e.g. its template was deleted meanwhile) -- it stays
    // listed so the builder can clear it rather than waiting forever.
    sellerSuspended: Boolean(row.seller_suspended),
    // #2988: the seller's suspension escalated into a permanent account
    // closure -- restoration is no longer coming. ISO timestamp, or null.
    permanentAt: row.permanent_at ?? null,
  };
}

export async function handlePendingRestoration(request, db, route) {
  // route is ['instances', 'pending-restoration'(, snapshotId)]
  const sessionBuilder = await requireSessionBuilder(request, db);

  if (request.method === 'GET' && route.length === 2) {
    const { results } = await db.prepare(`
      SELECT s.snapshot_id, s.landlet_id, s.template_id, s.instance_json, s.removed_at,
             s.template_name, s.template_category, s.template_image_url, s.permanent_at,
             t.name AS live_template_name, t.category AS live_template_category, t.image_url AS live_template_image_url,
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
