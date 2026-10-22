// #2613 (leaf of #2540, itself sub-issue of #2502/#2500): the two small,
// independent admin/builder-facing review endpoints left over once
// purchase creation (#2614) and purchase lifecycle actions (#2615) take
// the rest of the "purchases" domain -- the admin review queue over
// self_dealing_flags, and the builder-facing list/dismiss over
// sold_out_markers. Extracted verbatim, zero behavior change, same
// discipline as #2501/#2528/#2535/#2534.
//
// Deliberately does NOT include flagSelfDealingIfMatched/
// sweepSoldOutTemplateInstances (the side effects that actually populate
// these two tables, fired from inside handlePurchaseFinalize's own commit
// path) -- despite writing to the same tables these endpoints read, those
// are purchase-*creation* domain logic (#2614's own territory), not this
// leaf's; see #2613's own issue body for the full reasoning on why the
// original #2540 2-way split estimate didn't hold up once every call site
// was actually traced.
import { json, HttpError } from './http.js';
import { readJson, stringValue } from './validation.js';
import { checkRateLimit } from './rate-limit.js';
import { adminActionLogStatement } from './admin-log.js';
import { requireAdmin, requireSessionBuilder } from './auth.js';
// requireOwnedLandlet is landlet-core domain (#2533, not yet its own
// #2502 leaf) -- imported back from worker/index.js the same
// one-directional, safe-at-request-time-only way #2535/#2534 already
// established for a dependency that hasn't found its own stable home yet.
import { requireOwnedLandlet } from '../index.js';

const SELF_DEALING_FLAG_REVIEW_RATE_LIMIT_MAX = 20;

// #2019: the admin-facing review queue over self_dealing_flags -- a flag
// here is a soft signal, not an accusation, so there is no "approve"
// action with its own consequence the way #2017's product-flags resolve
// has (remove listing + strike seller). An admin reviewing one is just
// acknowledging it (optionally with a note for their own record); nothing
// else in this app reacts to a flag's status.
async function handleSelfDealingFlags(request, db, route) {
  if (request.method === 'GET' && route.length === 1) {
    await requireAdmin(request, db);
    const { results } = await db.prepare(`
      SELECT sdf.flag_id AS flagId, sdf.purchase_id AS purchaseId, sdf.matched_signals AS matchedSignals, sdf.created_at AS createdAt,
             p.template_id AS templateId, p.buyer_builder_id AS buyerBuilderId, p.builder_id AS builderId, p.total_cents AS totalCents
      FROM self_dealing_flags sdf
      JOIN purchases p ON p.purchase_id = sdf.purchase_id
      WHERE sdf.status = 'pending'
      ORDER BY sdf.created_at DESC
      LIMIT 200
    `).all();
    // #2110: same totalCount-alongside-the-cap pattern as handleSignPosts/
    // handleCalendarEvents/handlePurchases -- without it, an admin
    // reviewing this trust-and-safety queue has no way to tell "200 of
    // 200" from "200 of 1400", silently dropping older pending flags off
    // the end once the cap is reached.
    const total = await db.prepare(`SELECT COUNT(*) AS count FROM self_dealing_flags WHERE status = 'pending'`).first();
    return json({
      flags: results.map((row) => ({ ...row, matchedSignals: JSON.parse(row.matchedSignals) })),
      totalCount: total.count,
    });
  }

  if (request.method === 'POST' && route.length === 3 && route[2] === 'review') {
    const admin = await requireAdmin(request, db);
    await checkRateLimit(db, `self-dealing-flag-review:${admin.user_id}`, SELF_DEALING_FLAG_REVIEW_RATE_LIMIT_MAX);
    const flagId = route[1];
    const input = await readJson(request);
    const notes = input.notes === undefined || input.notes === null || input.notes === ''
      ? null
      : stringValue(input.notes, 'notes');
    if (notes && notes.length > 280) throw new HttpError('notes must be 280 characters or fewer', 400);
    const result = await db.prepare(`
      UPDATE self_dealing_flags SET status = 'reviewed', reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        reviewed_by_admin_user_id = ?, review_notes = ?
      WHERE flag_id = ? AND status = 'pending'
    `).bind(admin.user_id, notes, flagId).run();
    if (result.meta.changes === 0) throw new HttpError('Flag not found or already reviewed', 404);
    await adminActionLogStatement(db, admin.user_id, 'reviewed_self_dealing_flag', 'self_dealing_flag', flagId, { notes }).run();
    return json({ reviewed: true });
  }

  return json({ error: 'Not found' }, 404);
}

function soldOutMarkerFromRow(row) {
  return {
    markerId: row.marker_id,
    landletId: row.landlet_id,
    x: row.x_m,
    y: row.y_m,
    z: row.z_m,
    templateId: row.template_id,
    templateName: row.template_name,
    soldOutAt: row.sold_out_at,
  };
}

// #2068: dismissing is a one-way action (clearing a marker permanently,
// same "builder has acknowledged this, stop showing it" shape other
// dismiss-style actions in this app use), not a delete-then-recreate --
// shares a rate-limit bucket shape with every other per-account mutation
// limit in this file.
const SOLD_OUT_MARKER_DISMISS_RATE_LIMIT_MAX = 20;

async function handleSoldOutMarkers(request, db, route) {
  const landletId = route[1];

  if (request.method === 'GET' && route.length === 3) {
    const sessionBuilder = await requireSessionBuilder(request, db);
    await requireOwnedLandlet(db, landletId, sessionBuilder.builder_id);
    const { results } = await db.prepare(
      'SELECT * FROM sold_out_markers WHERE landlet_id = ? AND dismissed_at IS NULL ORDER BY sold_out_at ASC',
    ).bind(landletId).all();
    return json({ markers: results.map(soldOutMarkerFromRow) });
  }

  if (request.method === 'POST' && route.length === 5 && route[4] === 'dismiss') {
    const markerId = route[3];
    const sessionBuilder = await requireSessionBuilder(request, db);
    await requireOwnedLandlet(db, landletId, sessionBuilder.builder_id);
    await checkRateLimit(db, `sold-out-marker-dismiss:${sessionBuilder.builder_id}`, SOLD_OUT_MARKER_DISMISS_RATE_LIMIT_MAX);
    // #2098: same #929/#960/#2091 idiom used throughout this file --
    // requireOwnedLandlet above is a point-in-time check, and
    // checkRateLimit is a real awaited gap since then. Fold the ownership
    // re-check into the UPDATE itself (landlet_id is a direct FK here, so
    // no placed_instances join is needed, unlike the backup-chain case).
    const result = await db.prepare(`
      UPDATE sold_out_markers SET dismissed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE marker_id = ? AND landlet_id = ? AND dismissed_at IS NULL AND EXISTS (
        SELECT 1 FROM landlets l WHERE l.landlet_id = ? AND l.owner_builder_id IS ?
      )
    `).bind(markerId, landletId, landletId, sessionBuilder.builder_id).run();
    if (result.meta.changes === 0) {
      const stillOwned = await db.prepare('SELECT 1 FROM landlets WHERE landlet_id = ? AND owner_builder_id IS ?')
        .bind(landletId, sessionBuilder.builder_id).first();
      if (!stillOwned) {
        throw new HttpError('Landlet changed concurrently — refetch and retry', 409);
      }
      throw new HttpError('Marker not found or already dismissed', 404);
    }
    return json({ dismissed: true });
  }

  return json({ error: 'Not found' }, 404);
}

export { handleSelfDealingFlags, handleSoldOutMarkers };
