// #2533: the landlet core domain -- CRUD, draft/live state, versions, and
// vertical levels -- extracted verbatim from worker/index.js, zero behavior
// change (sub-issue of #2502, itself sub-issue of #2500's worker/index.js
// module split).
//
// requireLandlet/getVersion/versionFromRow/versionInstanceFromRow/
// landletFromRow/optionalLabelValue/integerValue/recomputeLandCap/cropsEqual/
// assertInstanceZWithinLevels/assertInstanceXYWithinLandlet/
// assertInstanceScaleWithinBounds/getInstancesById/validateLandlet/
// validateInstance/instanceFromRow are imported back from worker/index.js
// below -- each is genuinely shared well beyond this file's own domain
// (requireOwnedLandlet/requireOwnedLandlets call requireLandlet from
// handlers that haven't moved yet; instance validation/row-shaping is
// shared with handleInstances; and so on). This is a real circular module
// graph (worker/index.js <-> this file), but a safe one: every name on both
// sides is only read inside an async handler function invoked at request
// time, never at module-evaluation time, so the cycle resolves correctly
// under ES module live bindings (confirmed via the full build + test suite,
// both unit and e2e) -- same precedent as worker/lib/builder-profile.js's
// own circular import of templateFromRow/recomputeLandCap.
//
// candidateRowFromLandlet, handleSoldOutMarkers, and handleStartAuction all
// moved homes mid-flight: #2534 (merged into main while this extraction was
// in progress) moved candidateRowFromLandlet into
// worker/lib/world-generation.js, #2616 moved handleSoldOutMarkers into
// worker/lib/purchases-admin.js, and #2538/#2612 moved handleStartAuction
// into worker/lib/auctions.js -- all three are imported from their real
// homes directly instead of circularly through worker/index.js.
//
// LEVEL_HEIGHT_M/HALF_LEVEL_HEIGHT_M/LANDLET_AREA_M2/LANDLET_RELEASED_VIA_AUCTION_SQL
// are duplicated below rather than imported -- each is also used by code
// that stays in worker/index.js (assertInstanceZWithinLevels/
// assertInstanceXYWithinLandlet, recomputeLandCap and others), and workerd
// requires every named export of the main Worker entry module to be a
// function/class binding, so none of them can be exported from there as a
// plain const (confirmed the hard way for D1_MAX_BOUND_PARAMETERS in #2535).
import { json, HttpError, clientIp } from './http.js';
import { checkRateLimit } from './rate-limit.js';
import { adminActionLogStatement } from './admin-log.js';
import { readJson, stringValue, queryLimit, decodeCursor, encodeCursor } from './validation.js';
import { fireNotifications } from './notifications.js';
import { requireSessionBuilder, assertOwner, requireAdmin } from './auth.js';
import { requireBuilder } from './builder-profile.js';
import { candidateRowFromLandlet } from './world-generation.js';
import { handleSoldOutMarkers } from './purchases-admin.js';
import { handleStartAuction } from './auctions.js';
import { landletMaxWorldRadius } from '../geometry.js';
import { DEFAULT_EARTH_RADIUS_M, footprintScaleAtHeight } from '../earthCurvature.js';
import {
  requireLandlet, getVersion, versionFromRow, versionInstanceFromRow, landletFromRow,
  optionalLabelValue, integerValue, recomputeLandCap,
  cropsEqual, assertInstanceZWithinLevels, assertInstanceXYWithinLandlet, assertInstanceScaleWithinBounds,
  getInstancesById, validateLandlet, validateInstance, instanceFromRow,
  assertCropWithinTemplateBounds,
} from '../index.js';

// docs/SPEC.md §1's vertical construction (issue #167/#168): matches
// LANDLET_HEIGHT_M in src/main.js, the height of the single buildable
// level that already exists — each additional level is the same height,
// stacked directly on the previous one.
const LEVEL_HEIGHT_M = 10;

// #789: matches LANDLET_AREA_M2/LANDLET_SIDE_M in src/main.js — the fixed
// buildable-interior footprint every landlet has, a square centered at
// that landlet's own local (0,0), identical for every landlet regardless
// of its own DB area_m2/landlet_class.
const LANDLET_AREA_M2 = 1000;

// Half a level's height, allowed as slack on each end of a landlet's
// purchased-levels range — an instance's own thickness can carry it
// slightly past a level's exact z boundary without actually needing the
// next level purchased just to fit.
const HALF_LEVEL_HEIGHT_M = LEVEL_HEIGHT_M / 2;

const LANDLET_RELEASED_VIA_AUCTION_SQL = `EXISTS (
  SELECT 1 FROM auctions
  WHERE auctions.landlet_id = owned.landlet_id AND auctions.status = 'active'
    AND (auctions.starting_bid_cents = 0 OR EXISTS (
      SELECT 1 FROM auction_bids WHERE auction_bids.auction_id = auctions.auction_id
    ))
)`;

// docs/SPEC.md §3's two hard limits on digging down (issue #164): a
// downward level is blocked once its own cross-sectional area (the cone
// narrowing toward Earth's center) would fall below this floor, and dead-
// center itself (footprintScaleAtHeight hits exactly 0 there) is the
// absolute floor no level can ever reach or pass.
const MIN_LEVEL_FOOTPRINT_M2 = 10;

// Also used by recomputeLandCap/handleAuctionBids/resolveAuction, which stay
// in worker/index.js -- duplicated here for the same reason as the other
// platform constants above (see this file's own header comment).
const LAND_CAP_DISPLAY_ROUNDING_BUFFER_M2 = 1;

// #796: both version-creating write paths below (this POST, and the
// auto-version side effect of PUT /landlets/:id/draft) had no rate limit at
// all, unlike every other authenticated per-owner repeatable write in this
// file (bundle-create, calendar-event, catalog-thumbnail, concept-image) —
// each save duplicates up to 250 placed_instances rows into a new
// version_instances snapshot, so an unthrottled caller could grow storage
// without bound.
const LANDLET_VERSION_RATE_LIMIT_MAX = 20;

// #794: removing a level with out-of-range instances snapshots them into a
// brand-new, permanent saved_level_layouts/saved_layout_instances row pair
// — an unbounded, repeatable write with no rate limit at all otherwise.
const SAVED_LAYOUT_CREATE_RATE_LIMIT_MAX = 20;
// #907: the add-level POST branch, and a plain level removal with nothing
// to sweep, had no rate limit at all despite doing the same real, repeated
// DB work (an atomic multi-subquery INSERT/DELETE plus a recomputeLandCap
// call) this file rate-limits everywhere else.
const LANDLET_LEVEL_RATE_LIMIT_MAX = 40;

// #799: the self-owned "claimed" branch of POST /api/landlets grants the
// exact same fully-buildable outcome as POST .../claim — so, unlike the
// unauthenticated unowned-creation branch beside it, it needs the same two
// guards that endpoint enforces: at most one claimed landlet per builder,
// and a rate limit.
const LANDLET_SELF_CLAIM_CREATE_RATE_LIMIT_MAX = 20;
// #964: the unowned/greenbelt creation branch below is deliberately
// unauthenticated (world-generation/admin housekeeping), so there's no
// builder id to bucket by — same clientIp(request) fallback every other
// unauthenticated create endpoint already uses.
const LANDLET_CREATE_RATE_LIMIT_MAX = 20;
// #952: the real /claim endpoint the comment above cites as already having
// this guard never actually did -- this closes that gap for real.
const LANDLET_CLAIM_RATE_LIMIT_MAX = 20;
// #1150: see this constant's own use (PATCH /api/landlets/:id's owned
// branch) for why this needed adding now.
const LANDLET_OWNED_PATCH_RATE_LIMIT_MAX = 20;
// #1476: the owned branch above got its own limit via #1150, but that
// issue's comment explicitly scoped itself to "the owned branch only" and
// left this unauthenticated unowned/world-gen branch unthrottled.
const LANDLET_UNOWNED_PATCH_RATE_LIMIT_MAX = 20;
// #1794: the DELETE branch below is the third anonymous, unowned-only
// landlet mutation in this handler and never got the same guard.
const LANDLET_DELETE_RATE_LIMIT_MAX = 20;
// #2669: this admin-only generation-complete endpoint had no rate limit at
// all, unlike every other admin-gated mutation in this file -- requireAdmin
// always yields a real admin.user_id to bucket on, same shape as this
// file's other admin buckets. 40, not 20, since an admin working through
// a backlog of individually-completed landlets (this is the manual/
// troubleshooting path -- the automatic world-growth sweep completes rings
// via its own internal call, bypassing this HTTP endpoint entirely) can
// legitimately fire it many times in one sitting; same headroom
// LANDLET_LEVEL_RATE_LIMIT_MAX above already uses for comparable bulk use.
const LANDLET_GENERATION_COMPLETE_RATE_LIMIT_MAX = 40;
// #2669: same gap as LANDLET_GENERATION_COMPLETE_RATE_LIMIT_MAX above, on
// the admin-only reassign-owner endpoint.
const LANDLET_REASSIGN_OWNER_RATE_LIMIT_MAX = 20;

// #1721: same #473 pattern as purchaseIdempotencyKey -- the version-number
// computation below is a fresh MAX+1 read inside the batch itself, so a
// dropped-response retry isn't even caught by a uniqueness constraint the
// way a literal duplicate INSERT would be; it lands as a whole new, fully
// duplicate version one number higher than the first. Namespaced with
// landletId (and the calling builder, same collision reasoning as #974)
// so a key can never collide across two different landlets or builders.
function versionIdempotencyKey(landletId, builderId, rawKey) {
  if (typeof rawKey !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(rawKey)) return undefined;
  return `version:${landletId}:${builderId}:${rawKey}`;
}

function encodeVersionCursor(versionNumber) {
  return btoa(String(versionNumber));
}

function decodeVersionCursor(value) {
  if (value === null) return null;
  try {
    const decoded = atob(value);
    if (!/^\d+$/.test(decoded)) throw new Error();
    const versionNumber = Number(decoded);
    if (!Number.isSafeInteger(versionNumber) || versionNumber <= 0) throw new Error();
    return versionNumber;
  } catch {
    throw new HttpError('cursor is invalid', 400);
  }
}

export async function handleLandletVersions(request, db, route, url) {
  const landletId = route[1];

  if (request.method === 'GET' && route.length === 3) {
    await requireLandlet(db, landletId);
    const limit = queryLimit(url.searchParams.get('limit'), 100);
    const cursor = decodeVersionCursor(url.searchParams.get('cursor'));
    const cursorCondition = cursor === null ? '' : 'AND v.version_number < ?';
    const bindings = cursor === null ? [landletId, limit + 1] : [landletId, cursor, limit + 1];
    const { results } = await db.prepare(`
      SELECT v.*, COUNT(i.source_instance_id) AS instance_count
      FROM landlet_versions v
      LEFT JOIN version_instances i ON i.version_id = v.version_id
      WHERE v.landlet_id = ? ${cursorCondition}
      GROUP BY v.version_id
      ORDER BY v.version_number DESC
      LIMIT ?
    `).bind(...bindings).all();
    const hasMore = results.length > limit;
    const page = results.slice(0, limit);
    return json({
      versions: page.map(versionFromRow),
      nextCursor: hasMore ? encodeVersionCursor(page.at(-1).version_number) : null,
    });
  }

  if (request.method === 'POST' && route.length === 3) {
    const landlet = await requireLandlet(db, landletId);
    const sessionBuilder = await requireSessionBuilder(request, db);
    assertOwner(landlet.owner_builder_id, sessionBuilder.builder_id, 'Not your landlet');
    await checkRateLimit(db, `landlet-version:${sessionBuilder.builder_id}`, LANDLET_VERSION_RATE_LIMIT_MAX);
    const input = await readJson(request);
    // #1721: reusing version_id itself as the dedup key, same idiom as
    // writePurchaseRow's purchase_id -- a missing/malformed key just
    // degrades to no idempotency protection for this one request, same as
    // purchaseIdempotencyKey's own "degrades to no protection" behavior.
    // #480: same "optional user-facing short label, no upper bound" gap
    // #337/#358 already closed elsewhere — optionalLabelValue caps it
    // whenever a real value is given, same as absent-or-capped fields
    // like category/subcategory.
    const name = optionalLabelValue(input.name, 'name');
    const metadata = input.metadata || {};
    JSON.stringify(metadata);
    const idempotencyKey = versionIdempotencyKey(landletId, sessionBuilder.builder_id, input.idempotencyKey);
    let versionId = idempotencyKey || crypto.randomUUID();
    if (idempotencyKey) {
      const existing = await getVersion(db, landletId, idempotencyKey);
      if (existing) {
        // #1874: same "a client-supplied idempotency key reused for
        // genuinely different content must not fabricate a stale success"
        // fix already applied to direct messages (#1750), calendar events
        // (#1751), and catalog templates (#1758) -- this endpoint's own
        // version never got it. `name` defaults DB-side to `'Version ' ||
        // version_number` when omitted (see the INSERT below), so the
        // stored `existing.name` already has that default baked in --
        // comparing against the SAME default recomputed at
        // existing.versionNumber (rather than against `name` directly)
        // correctly treats "omitted both times" as a match instead of a
        // false mismatch against the auto-generated label.
        const expectedName = name ?? `Version ${existing.versionNumber}`;
        if (existing.name === expectedName && JSON.stringify(existing.metadata) === JSON.stringify(metadata)) {
          return json({ version: existing });
        }
        versionId = crypto.randomUUID();
      }
    }

    // #415: same guarded-write idiom as handleLandletDraft's PUT below —
    // a leading no-op guard statement re-pinning owner_builder_id (its own
    // meta.changes checked after the batch), plus the same condition
    // folded into each real write's own WHERE/SELECT as a belt-and-
    // suspenders guard, since D1's db.batch runs every statement
    // regardless of an earlier one's row count within the same call.
    // Without this, an auction resolving (transferring ownership) in the
    // await gap between the ownership check above and this batch would
    // still let this request attribute a version snapshot to the
    // landlet's new owner using the old owner's placed_instances.
    const results = await db.batch([
      db.prepare(`
        UPDATE landlets SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE landlet_id = ? AND owner_builder_id IS ?
      `).bind(landletId, landlet.owner_builder_id),
      db.prepare(`
        INSERT INTO landlet_versions (version_id, landlet_id, version_number, name, metadata_json)
        SELECT ?, ?, next_version_number,
               COALESCE(?, 'Version ' || next_version_number), ?
        FROM (
          SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version_number
          FROM landlet_versions WHERE landlet_id = ?
        )
        WHERE EXISTS (SELECT 1 FROM landlets WHERE landlet_id = ? AND owner_builder_id IS ?)
      `).bind(versionId, landletId, name, JSON.stringify(metadata), landletId, landletId, landlet.owner_builder_id),
      db.prepare(`
        INSERT INTO version_instances
          (version_id, source_instance_id, template_id, x_m, y_m, z_m, rotation_x_rad, rotation_y_rad, rotation_z_rad, label, crop_json, scale, is_community_sign, is_community_calendar, group_id)
        SELECT ?, instance_id, template_id, x_m, y_m, z_m, rotation_x_rad, rotation_y_rad, rotation_z_rad, label, crop_json, scale, is_community_sign, is_community_calendar, group_id
        FROM placed_instances WHERE landlet_id = ?
          AND EXISTS (SELECT 1 FROM landlets WHERE landlet_id = ? AND owner_builder_id IS ?)
      `).bind(versionId, landletId, landletId, landlet.owner_builder_id),
    ]);
    if (results[0].meta.changes === 0) {
      throw new HttpError('Landlet changed concurrently — refetch and retry', 409);
    }

    const version = await getVersion(db, landletId, versionId);
    return json({ version }, 201);
  }

  if (request.method === 'GET' && route.length === 4) {
    const version = await getVersion(db, landletId, route[3]);
    if (!version) return json({ error: 'Landlet version not found' }, 404);
    const { results } = await db.prepare(`
      SELECT * FROM version_instances WHERE version_id = ? ORDER BY source_instance_id
    `).bind(route[3]).all();
    return json({ version: { ...version, instances: results.map(versionInstanceFromRow) } });
  }

  if (request.method === 'POST' && route.length === 5 && route[4] === 'activate') {
    const landlet = await requireLandlet(db, landletId);
    const sessionBuilder = await requireSessionBuilder(request, db);
    assertOwner(landlet.owner_builder_id, sessionBuilder.builder_id, 'Not your landlet');
    await checkRateLimit(db, `landlet-version:${sessionBuilder.builder_id}`, LANDLET_VERSION_RATE_LIMIT_MAX);
    const version = await getVersion(db, landletId, route[3]);
    if (!version) return json({ error: 'Landlet version not found' }, 404);
    // #415: re-pins owner_builder_id, the same way the hardened /landlets/:id
    // PUT/PATCH guard does — without it, an auction resolving (transferring
    // ownership) in the await gap between the ownership check above and
    // this write would still let this request set active_version_id on the
    // landlet's new owner using a version that belonged to the old one.
    const result = await db.prepare(`
      UPDATE landlets SET active_version_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE landlet_id = ? AND owner_builder_id IS ?
    `).bind(route[3], landletId, landlet.owner_builder_id).run();
    if (result.meta.changes === 0) {
      throw new HttpError('Landlet changed concurrently — refetch and retry', 409);
    }
    const updatedLandlet = await requireLandlet(db, landletId);
    return json({ landlet: landletFromRow(updatedLandlet), version });
  }

  return json({ error: 'Not found' }, 404);
}

// A level's own cap cost, sampled at z = levelIndex * LEVEL_HEIGHT_M —
// level 1 at z = LEVEL_HEIGHT_M, level -1 at z = -LEVEL_HEIGHT_M, and so
// on. Found via backlog audit (#409): this is each level's boundary
// *nearest ground*, not its outer one — for a below-ground level that's
// also the strictest (deepest, smallest-cross-section) point within it,
// matching the MIN_LEVEL_FOOTPRINT_M2 dig-limit check's own intent above,
// but for an above-ground level it's the cheaper near edge shared with the
// level below, not the pricier far edge the cone-widening formula would
// give at that level's true outer boundary. The resulting undercharge is
// negligible in practice (LEVEL_HEIGHT_M vs. DEFAULT_EARTH_RADIUS_M puts
// it around 1e-6 relative), so this is left as-is rather than changed —
// re-pricing live land-cap costs isn't a call to make unilaterally: flag
// for the project owner if a real formula fix is ever wanted here.
// footprintScaleAtHeight gives the linear cross-section ratio at that
// height; squaring it converts to the area ratio docs/SPEC.md §1 actually
// describes ("cross-sectional area grows/shrinks"), then scales the
// lándlet's own ground-level area by it.
function levelCapConsumedM2(landletAreaM2, levelIndex) {
  const z = levelIndex * LEVEL_HEIGHT_M;
  const scale = footprintScaleAtHeight(z, DEFAULT_EARTH_RADIUS_M);
  return landletAreaM2 * scale * scale;
}

// Levels stack directly on each other with no gaps — level 2 can't exist
// without level 1, in either direction — so "add" only ever extends the
// current range by exactly one, and "remove" only ever removes the
// outermost level still standing. Returns the full current set (ordered
// nearest-to-ground first, both directions) for callers that need to find
// the current extent in a given direction.
async function landletLevels(db, landletId) {
  const { results } = await db.prepare(`
    SELECT * FROM landlet_levels WHERE landlet_id = ? ORDER BY level_index
  `).bind(landletId).all();
  return results;
}

function levelFromRow(row) {
  return {
    levelId: row.level_id,
    landletId: row.landlet_id,
    levelIndex: row.level_index,
    capConsumedM2: row.cap_consumed_m2,
    createdAt: row.created_at,
  };
}

export async function handleLandletLevels(request, db, route) {
  const landletId = route[1];
  if (request.method === 'GET' && route.length === 3) {
    await requireLandlet(db, landletId);
    const levels = await landletLevels(db, landletId);
    return json({ levels: levels.map(levelFromRow) });
  }

  if (request.method === 'POST' && route.length === 3) {
    const landlet = await requireLandlet(db, landletId);
    const sessionBuilder = await requireSessionBuilder(request, db);
    assertOwner(landlet.owner_builder_id, sessionBuilder.builder_id, 'Not your landlet');
    await checkRateLimit(db, `landlet-level-add:${landlet.owner_builder_id}`, LANDLET_LEVEL_RATE_LIMIT_MAX);
    const input = await readJson(request);
    if (input.direction !== 'up' && input.direction !== 'down') {
      throw new HttpError('direction must be "up" or "down"', 400);
    }
    const levels = await landletLevels(db, landletId);
    const levelIndex = input.direction === 'up'
      ? Math.max(0, ...levels.map((level) => level.level_index)) + 1
      : Math.min(0, ...levels.map((level) => level.level_index)) - 1;
    if (input.direction === 'down' && levelIndex * LEVEL_HEIGHT_M <= -DEFAULT_EARTH_RADIUS_M) {
      throw new HttpError('Cannot dig any deeper — reached Earth\'s center', 409);
    }
    const capConsumedM2 = levelCapConsumedM2(landlet.area_m2, levelIndex);
    if (input.direction === 'down' && capConsumedM2 < MIN_LEVEL_FOOTPRINT_M2) {
      throw new HttpError(
        `Cannot dig any deeper — this level's footprint (${capConsumedM2.toFixed(2)}m²) `
        + `would fall below the ${MIN_LEVEL_FOOTPRINT_M2}m² minimum`,
        409,
      );
    }
    // #489 (owner-confirmed): land cap now actually gates vertical
    // construction, not just the depth/footprint limits above. Ratchets
    // the cap to its current value first (recomputeLandCap only ever
    // moves it up, off trailing earnings — see that function's own
    // comment) so a builder who just earned isn't rejected against a
    // stale cap, then checks the level's own consumption against
    // whatever headroom is left. This eager check gives the clear 409
    // message in the common case; the atomic clause folded into the
    // INSERT below is the real race guard (see its own comment).
    const landCap = await recomputeLandCap(db, landlet.owner_builder_id);
    if (landCap.ownedAreaM2 + capConsumedM2 > landCap.nextCap + LAND_CAP_DISPLAY_ROUNDING_BUFFER_M2) {
      throw new HttpError(
        `This would take you to ${(landCap.ownedAreaM2 + capConsumedM2).toFixed(2)}m², `
        + `over your ${landCap.nextCap}m² land cap`,
        409,
      );
    }
    const levelId = `level-${crypto.randomUUID()}`;
    // Found via backlog audit (#395): levelIndex above was computed from a
    // plain SELECT snapshot, then this was a plain INSERT — a concurrent
    // add in the same direction could compute the same levelIndex from its
    // own stale read, and the loser's INSERT would throw a raw UNIQUE
    // constraint violation (an unshaped 500) instead of this file's usual
    // clean 409. Folding the "still the same extent" check into the
    // INSERT's own WHERE clause (same idiom as the auction-start guard
    // above) makes the whole read-derived-index-then-insert one atomic
    // statement: it only succeeds if the table's current extent in this
    // direction still matches what levelIndex was computed from, catching
    // both a same-direction race (another add landed the same index first)
    // and a cross-direction one (a concurrent remove shifted the extent
    // out from under this read).
    // A ground floor of 0 has to be included in the extent comparison even
    // when no row exists on this side yet (e.g. adding the first "down"
    // level while "up" levels already exist) — mirrors the Math.max(0, ...)/
    // Math.min(0, ...) floor levelIndex itself was just computed with above,
    // via a synthetic zero row unioned into the scan.
    const extentBefore = input.direction === 'up' ? levelIndex - 1 : levelIndex + 1;
    // #489: the eager land-cap check above reads a snapshot of the
    // builder's owned area, so two concurrent level-adds on two
    // *different* landlets owned by the same builder (the per-landlet
    // extent check right below can't catch that — it's scoped to this
    // one landlet_id) could each pass it and jointly land over cap. This
    // clause re-derives total owned area (ground + levels, across every
    // claimed landlet) live at INSERT time and folds it into the same
    // atomic statement as the extent guard, same idiom as that guard's
    // own comment above.
    const inserted = await db.prepare(`
      INSERT INTO landlet_levels (level_id, landlet_id, level_index, cap_consumed_m2)
      SELECT ?, ?, ?, ?
      WHERE (
        SELECT ${input.direction === 'up' ? 'MAX' : 'MIN'}(level_index) FROM (
          SELECT level_index FROM landlet_levels WHERE landlet_id = ? UNION ALL SELECT 0
        )
      ) = ?
        AND NOT EXISTS (SELECT 1 FROM landlet_levels WHERE landlet_id = ? AND level_index = ?)
        AND (
          SELECT b.land_cap_m2 FROM builders b WHERE b.builder_id = ?
        ) + ? >= (
          ?
          + COALESCE((
              SELECT SUM(area_m2) FROM landlets AS owned
              WHERE owned.owner_builder_id = ? AND owned.status = 'claimed'
                AND NOT ${LANDLET_RELEASED_VIA_AUCTION_SQL}
            ), 0)
          + COALESCE((
              SELECT SUM(ll.cap_consumed_m2) FROM landlet_levels ll
              JOIN landlets AS owned ON owned.landlet_id = ll.landlet_id
              WHERE owned.owner_builder_id = ? AND owned.status = 'claimed'
                AND NOT ${LANDLET_RELEASED_VIA_AUCTION_SQL}
            ), 0)
        )
        -- #958: re-pins ownership into this same atomic write, same #415
        -- idiom as handleLandletVersions' POST -- without this, an auction
        -- resolving (transferring ownership) in the await gap between the
        -- assertOwner check above and this INSERT would still let this
        -- request plant a level on the landlet's new owner, billed against
        -- the old owner's own land cap above.
        AND EXISTS (SELECT 1 FROM landlets WHERE landlet_id = ? AND owner_builder_id IS ?)
    `).bind(
      levelId, landletId, levelIndex, capConsumedM2,
      landletId, extentBefore, landletId, levelIndex,
      landlet.owner_builder_id, LAND_CAP_DISPLAY_ROUNDING_BUFFER_M2, capConsumedM2, landlet.owner_builder_id, landlet.owner_builder_id,
      landletId, landlet.owner_builder_id,
    ).run();
    if (inserted.meta.changes === 0) {
      throw new HttpError('This landlet\'s levels changed — please retry', 409);
    }
    await recomputeLandCap(db, landlet.owner_builder_id);
    const row = await db.prepare('SELECT * FROM landlet_levels WHERE level_id = ?').bind(levelId).first();
    // #2469: a concurrent removal of this exact (deterministically-indexed,
    // outermost) level from a second tab, a builder self-delete cascade, a
    // concurrent auction resolution (resolveAuction's own
    // DELETE FROM landlet_levels), or an admin reassign-owner can remove
    // this row in the await gap since the INSERT (or recomputeLandCap just
    // above) -- a genuine race, not an uncaught levelFromRow(undefined)
    // crash. Same idiom as #2334/#2354/#2364/#2391/#2392/#2429/#2430, 409
    // to match this branch's own "changed -- please retry" message above.
    if (!row) throw new HttpError('This landlet\'s levels changed — please retry', 409);
    return json({ level: levelFromRow(row) }, 201);
  }

  if (request.method === 'DELETE' && route.length === 4) {
    const landlet = await requireLandlet(db, landletId);
    const sessionBuilder = await requireSessionBuilder(request, db);
    assertOwner(landlet.owner_builder_id, sessionBuilder.builder_id, 'Not your landlet');
    const levelIndex = integerValue(route[3], 'levelIndex');
    if (levelIndex === 0) {
      throw new HttpError('Only the outermost existing level can be removed', 409);
    }
    // #924: everything below (the z-range/sweep-set computation and the
    // rate-limit check it feeds) used to run AFTER the DELETE just below,
    // which meant a caller who'd hit their rate limit still got the real,
    // irreversible level removal committed before the 429 was thrown — with
    // the sweep/save-layout/recomputeLandCap steps that are supposed to
    // follow it never happening. Computing the hypothetical post-delete
    // state from the CURRENT (pre-delete) level list first, and checking
    // the rate limit against it before any write, means a request that
    // gets rate-limited never mutates anything at all — same ordering the
    // sibling POST (add-level) branch above already uses (checkRateLimit,
    // then its own atomic guarded INSERT). A rate-limit slot can still be
    // spent on a request that later loses the #395 race below and gets a
    // 409 instead of actually deleting anything — same accepted tradeoff
    // the POST branch already has for its own atomic INSERT.
    const current = await db.prepare('SELECT level_index FROM landlet_levels WHERE landlet_id = ?').bind(landletId).all();
    const remainingIndices = current.results.map((row) => row.level_index).filter((index) => index !== levelIndex);
    const minZ = Math.min(0, ...remainingIndices) * LEVEL_HEIGHT_M - HALF_LEVEL_HEIGHT_M;
    const maxZ = Math.max(0, ...remainingIndices) * LEVEL_HEIGHT_M + HALF_LEVEL_HEIGHT_M;
    const outOfRange = await db.prepare('SELECT * FROM placed_instances WHERE landlet_id = ? AND (z_m < ? OR z_m > ?)')
      .bind(landletId, minZ, maxZ).all();
    if (outOfRange.results.length > 0) {
      await checkRateLimit(db, `saved-layout-create:${landlet.owner_builder_id}`, SAVED_LAYOUT_CREATE_RATE_LIMIT_MAX);
    } else {
      // #907: the sweep branch above has its own limiter (SAVED_LAYOUT_CREATE_
      // RATE_LIMIT_MAX, since #794) — an ordinary removal with nothing to
      // sweep never hit any checkRateLimit at all before this, despite doing
      // the same atomic DELETE + recomputeLandCap work as any other level
      // removal.
      await checkRateLimit(db, `landlet-level-remove:${landlet.owner_builder_id}`, LANDLET_LEVEL_RATE_LIMIT_MAX);
    }

    // Found via backlog audit (#395): the outermost check below used to run
    // against a plain SELECT snapshot, then the actual DELETE was a
    // separate, unguarded statement — a concurrent add extending past this
    // level (between the read and the delete) would let this DELETE still
    // remove what's no longer the outermost row, leaving a gap the
    // landlet_levels schema comment's own "no gaps" adjacency rule
    // promises never happens. Re-checking "is this still the current
    // outermost in its own direction" as part of the DELETE's own WHERE
    // clause closes that window.
    // #958: same #415 owner-pin idiom as the POST add-level branch above --
    // without this, an auction resolving in the await gap between the
    // assertOwner check above and this DELETE would still let this stale
    // request remove a level the new owner may have since added their own
    // content to, sweeping it into a saved_level_layouts row attributed to
    // the old owner (landlet.owner_builder_id, bound below).
    const deleted = await db.prepare(`
      DELETE FROM landlet_levels
      WHERE landlet_id = ? AND level_index = ?
        AND level_index = (
          SELECT CASE WHEN ? > 0 THEN MAX(level_index) ELSE MIN(level_index) END
          FROM landlet_levels WHERE landlet_id = ?
        )
        AND EXISTS (SELECT 1 FROM landlets WHERE landlet_id = ? AND owner_builder_id IS ?)
    `).bind(landletId, levelIndex, levelIndex, landletId, landletId, landlet.owner_builder_id).run();
    if (deleted.meta.changes === 0) {
      throw new HttpError('Landlet changed concurrently — refetch and retry', 409);
    }
    // #2470: minZ/maxZ above were computed from the pre-DELETE snapshot
    // taken before the rate-limit check and the DELETE's own awaited
    // round-trips — fine for the rate-limit-bucket decision that snapshot
    // feeds (outOfRange above), but a concurrent level add in the *other*
    // direction during that gap (e.g. this request removes the outermost
    // "up" level while another tab adds a new "down" level) would still
    // leave minZ/maxZ reflecting the old, now-wrong extent here, after the
    // DELETE has actually committed. The outermost-level guard folded into
    // the DELETE's own WHERE clause above only protects the direction being
    // removed, so it doesn't catch this. Re-deriving the range from a fresh
    // read of the now-committed landlet_levels table — same formula, same
    // half-level-height slack — keeps the sweep below scoped to the real,
    // live extent instead of a window that may have shifted out from under
    // it.
    const remainingAfterDelete = await db.prepare('SELECT level_index FROM landlet_levels WHERE landlet_id = ?')
      .bind(landletId).all();
    const freshRemainingIndices = remainingAfterDelete.results.map((row) => row.level_index);
    const freshMinZ = Math.min(0, ...freshRemainingIndices) * LEVEL_HEIGHT_M - HALF_LEVEL_HEIGHT_M;
    const freshMaxZ = Math.max(0, ...freshRemainingIndices) * LEVEL_HEIGHT_M + HALF_LEVEL_HEIGHT_M;
    // #522 (owner-confirmed, 2026-09-09): any instance left sitting in the
    // z-range this level was providing is removed from active shoppable
    // space rather than silently drifting out of bounds — nothing else
    // ever re-checks an existing instance's z once placed
    // (assertInstanceZWithinLevels only runs on that instance's own
    // create/move). Same allowed-range formula (and half-level-height
    // slack) as assertInstanceZWithinLevels, computed (above) against the
    // levels that remain once this delete succeeds.
    // #633 (sub-issue of #631, owner-confirmed on #522): before the sweep
    // below deletes these instances from active space, snapshot them into
    // a reusable saved_level_layouts/saved_layout_instances record — "we
    // should save it for the builder's future use" — so this removal isn't
    // a silent loss of their work, just a move out of active shoppable
    // space.
    // #928: the `outOfRange` snapshot taken above (before checkRateLimit and
    // the level DELETE, both awaited round-trips) is stale by the time we
    // get here — a concurrent request from the same owner (two open tabs, or
    // a synced drag-place that validated fine against the still-existing
    // level a moment ago) can land a new instance in this same z-range
    // during that gap. That instance wouldn't be in the stale snapshot, so
    // it would never get a saved_layout_instances row, but the final sweep
    // DELETE below is scoped by z-range, not by snapshotted instance ids, so
    // it would still be destroyed — a silent, unrecorded data loss. Nothing
    // here actually serializes concurrent requests from the same builder
    // (assertOwner is just an equality check, not a lock), so re-querying
    // immediately before building the batch — rather than reusing the
    // earlier snapshot — closes that window down to this batch's own commit
    // latency.
    const freshOutOfRange = await db.prepare('SELECT * FROM placed_instances WHERE landlet_id = ? AND (z_m < ? OR z_m > ?)')
      .bind(landletId, freshMinZ, freshMaxZ).all();
    const statements = [];
    if (freshOutOfRange.results.length > 0) {
      const savedLayoutId = `saved-layout-${crypto.randomUUID()}`;
      statements.push(db.prepare(`
        INSERT INTO saved_level_layouts (saved_layout_id, builder_id, source_landlet_id, source_level_index, name)
        VALUES (?, ?, ?, ?, ?)
      `).bind(
        savedLayoutId, landlet.owner_builder_id, landletId, levelIndex,
        `Level ${levelIndex} from ${landlet.name}, removed ${new Date().toISOString().slice(0, 10)}`,
      ));
      for (const instance of freshOutOfRange.results) {
        statements.push(db.prepare(`
          INSERT INTO saved_layout_instances (
            saved_layout_id, source_instance_id, template_id, x_m, y_m, z_m,
            rotation_x_rad, rotation_y_rad, rotation_z_rad, label, crop_json, scale,
            is_community_sign, is_community_calendar
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          savedLayoutId, instance.instance_id, instance.template_id, instance.x_m, instance.y_m, instance.z_m,
          instance.rotation_x_rad, instance.rotation_y_rad, instance.rotation_z_rad, instance.label,
          instance.crop_json, instance.scale, instance.is_community_sign, instance.is_community_calendar,
        ));
      }
    }
    statements.push(
      db.prepare('DELETE FROM placed_instances WHERE landlet_id = ? AND (z_m < ? OR z_m > ?)').bind(landletId, freshMinZ, freshMaxZ),
    );
    await db.batch(statements);
    await recomputeLandCap(db, landlet.owner_builder_id);
    // #901: the caller's own local scene still has meshes for whatever just
    // got swept above -- without reporting which instance ids those were,
    // nothing tells the frontend to prune them, leaving stale/unselectable
    // "ghost" meshes that can later block an unrelated batch sync.
    return json({ deleted: true, sweptInstanceIds: freshOutOfRange.results.map((instance) => instance.instance_id) });
  }

  return json({ error: 'Not found' }, 404);
}

// #1711 (owner decision, 2026-10-13): surfaces an active auction on a
// landlet as a structured 409 conflict -- "current high bid, bidder
// count, etc." -- for admin reassign-owner to report rather than silently
// proceeding underneath it (resolveAuction would later transfer the
// landlet again, or release it to greenbelt, out from under whoever the
// admin just handed it to, while still crediting the stale previous
// owner -- the exact failure this issue was filed over). Shared by
// reassign-owner's pre-check and its race-window re-check after a 0-row
// transfer attempt, so the two can't drift apart.
async function activeAuctionConflict(db, landletId) {
  const auction = await db.prepare(`
    SELECT * FROM auctions WHERE landlet_id = ? AND status = 'active'
  `).bind(landletId).first();
  if (!auction) return null;
  const bidStats = await db.prepare(`
    SELECT MAX(amount_cents) AS highBidCents, COUNT(DISTINCT bidder_builder_id) AS bidderCount
    FROM auction_bids WHERE auction_id = ?
  `).bind(auction.auction_id).first();
  return {
    auction,
    extra: {
      activeAuction: {
        auctionId: auction.auction_id, startingBidCents: auction.starting_bid_cents,
        highBidCents: bidStats.highBidCents, bidderCount: bidStats.bidderCount, endsAt: auction.ends_at,
      },
    },
  };
}

async function explainClaimConflict(db, landletId, builderId) {
  const landlet = await db.prepare('SELECT status, owner_builder_id, landlet_type, landlet_class FROM landlets WHERE landlet_id = ?').bind(landletId).first();
  if (!landlet) throw new HttpError('Landlet not found', 404);
  if (landlet.landlet_type === 'water') {
    throw new HttpError('Water cannot be claimed', 409);
  }
  if (landlet.status !== 'greenbelt' || landlet.owner_builder_id !== null) {
    throw new HttpError('Landlet is not available to claim', 409);
  }
  // #1703: a Class 2+ landlet (landlet_class > 1) is never free to claim --
  // only an auction win grants more than the free Class 1 starter size.
  if (landlet.landlet_class !== 1) {
    throw new HttpError('This landlet is larger than the free starter size -- it can only be acquired via auction', 409);
  }

  const owned = await db.prepare(`
    SELECT landlet_id FROM landlets AS owned
    WHERE owned.owner_builder_id = ? AND owned.status = 'claimed'
      AND NOT ${LANDLET_RELEASED_VIA_AUCTION_SQL}
    LIMIT 1
  `).bind(builderId).first();
  if (owned) throw new HttpError('Builder already owns a claimed landlet', 409);

  throw new HttpError('Landlet could not be claimed', 409);
}

function landletParams(landlet) {
  return [landlet.landletId, landlet.name, landlet.areaM2, landlet.center.x, landlet.center.y, landlet.status, landlet.ownerBuilderId, landlet.landClass, JSON.stringify(landlet.polygon), landlet.generatedAt, landlet.claimableAt, JSON.stringify(landlet.metadata), landlet.landType, landlet.biome ?? null, landlet.elevationM ?? null];
}

export async function handleLandlets(request, db, route, url) {
  if (route.length >= 3 && route[2] === 'versions') {
    return handleLandletVersions(request, db, route, url);
  }

  // #2068 (leaf sub-issue of #1973/#1947): grayed-out sold-out markers for
  // the builder's own land -- landlet-scoped (not a cross-landlet "my
  // markers" list like GET /builders/me/low-stock above) since a marker's
  // x_m/y_m are landlet-local coordinates, same as placed_instances' own,
  // and only make sense rendered inside the one landlet's scene they
  // belong to.
  if (route.length >= 3 && route[2] === 'sold-out-markers') {
    return handleSoldOutMarkers(request, db, route);
  }

  if (route.length === 3 && route[2] === 'auction') {
    return handleStartAuction(request, db, route[1]);
  }

  if (route.length >= 3 && route[2] === 'levels') {
    return handleLandletLevels(request, db, route);
  }

  if (route.length === 3 && route[2] === 'draft') {
    return handleLandletDraft(request, db, route[1]);
  }

  if (request.method === 'GET' && route.length === 3 && route[2] === 'live') {
    return handleLiveLandlet(db, route[1]);
  }

  if (request.method === 'POST' && route.length === 3 && route[2] === 'generation-complete') {
    const admin = await requireAdmin(request, db);
    await checkRateLimit(db, `landlet-generation-complete:${admin.user_id}`, LANDLET_GENERATION_COMPLETE_RATE_LIMIT_MAX);
    const existing = await requireLandlet(db, route[1]);
    if (existing.generated_at) return json({ landlet: landletFromRow(existing) });
    if (existing.status !== 'generating') {
      throw new HttpError('Landlet is not currently generating', 409);
    }

    // #1055: "is this enclosed" used to be decided from a settings.radius_m
    // JS read taken before this batch commits, unlike #849's own fix for
    // the identical candidate-materialization race -- a concurrent
    // expandWorldOnce bumping the radius in the gap between that read and
    // this write could leave an already-enclosed landlet stuck at
    // 'generating' until some future sweep happened to catch it. Now a
    // live subquery against world_settings, evaluated inside this same
    // UPDATE, the same fix shape candidateMaterializationSweepStatements
    // already uses.
    // #1666: the log INSERT used to be batched with this UPDATE, but the
    // UPDATE's own status='generating' AND generated_at IS NULL guard can
    // legitimately affect 0 rows (the #1055 test above proves two
    // concurrent callers can both reach here) -- db.batch() commits every
    // statement regardless of an earlier one's row count, so the race's
    // loser still logged a completion that never happened. Same "logged
    // only after confirmed" idiom the /admin-forms/:formId/approve handler
    // above already uses for the identical reason (#897).
    const result = await db.prepare(`
      UPDATE landlets
      SET generated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          status = CASE WHEN max_world_radius_m <= (SELECT radius_m FROM world_settings WHERE world_id = 'default-world') THEN 'greenbelt' ELSE status END,
          claimable_at = CASE
            WHEN max_world_radius_m <= (SELECT radius_m FROM world_settings WHERE world_id = 'default-world') THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            ELSE claimable_at
          END,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE landlet_id = ? AND status = 'generating' AND generated_at IS NULL
    `).bind(route[1]).run();
    if (result.meta.changes > 0) {
      await adminActionLogStatement(db, admin.user_id, 'landlet_generation_complete', 'landlet', route[1]).run();
    }
    const updated = await requireLandlet(db, route[1]);
    return json({ landlet: landletFromRow(updated) });
  }

  if (request.method === 'GET' && route.length === 1) {
    const status = url.searchParams.get('status');
    const ownerBuilderIdParam = url.searchParams.get('ownerBuilderId');
    if (status !== null && !['greenbelt', 'claimed', 'generating'].includes(status)) {
      throw new HttpError('status must be greenbelt, claimed, or generating', 400);
    }
    const ownerBuilderId = ownerBuilderIdParam === null
      ? null
      : stringValue(ownerBuilderIdParam, 'ownerBuilderId');
    const limit = queryLimit(url.searchParams.get('limit'), 100);
    const cursor = decodeCursor(url.searchParams.get('cursor'));
    const conditions = [];
    const bindings = [];
    if (status) {
      conditions.push('status = ?');
      bindings.push(status);
    }
    if (ownerBuilderId) {
      conditions.push('owner_builder_id = ?');
      bindings.push(ownerBuilderId);
    }
    if (cursor) {
      conditions.push('(created_at > ? OR (created_at = ? AND landlet_id > ?))');
      bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    // #3005: Shop mode's periodic landlet record re-sync (fetchAllLandlets,
    // this endpoint) needs to detect a mid-session owner suspension to
    // unload a now-hidden builder's content (#2993's own purchasability/
    // instance-listing gate already hides it server-side; the client just
    // never knew to drop what it had already rendered). A correlated EXISTS,
    // same shape builderHasActiveSuspension (worker/lib/auth.js) already
    // queries, computed once per page here instead of N+1 calls from the
    // client.
    const { results } = await db.prepare(`
      SELECT landlets.*, EXISTS (
        SELECT 1 FROM builders
        JOIN account_suspensions ON account_suspensions.user_id = builders.user_id
        WHERE builders.builder_id = landlets.owner_builder_id
          AND account_suspensions.lifted_at IS NULL
          AND account_suspensions.escalated_at IS NULL
      ) AS owner_suspended
      FROM landlets ${where}
      ORDER BY created_at, landlet_id LIMIT ?
    `).bind(...bindings, limit + 1).all();
    const hasMore = results.length > limit;
    const page = results.slice(0, limit);
    const last = page.at(-1);
    return json({
      landlets: page.map(landletFromRow),
      nextCursor: hasMore ? encodeCursor(last.created_at, last.landlet_id) : null,
    });
  }

  if (request.method === 'GET' && route.length === 2) {
    const row = await db.prepare('SELECT * FROM landlets WHERE landlet_id = ?').bind(route[1]).first();
    return row ? json({ landlet: landletFromRow(row) }) : json({ error: 'Landlet not found' }, 404);
  }

  if (request.method === 'POST' && route.length === 3 && route[2] === 'claim') {
    // builderId always comes from the session now, never the request body
    // — claiming "as" a builderId the caller merely typed in was exactly
    // the open vector this whole pass exists to close (any of the
    // publicly-visible ids from GET /builders could otherwise claim land
    // on that builder's behalf without them ever logging in).
    const sessionBuilder = await requireSessionBuilder(request, db);
    const builderId = sessionBuilder.builder_id;
    // #952: this endpoint was the reference implementation
    // LANDLET_SELF_CLAIM_CREATE_RATE_LIMIT_MAX's own comment (and #799's
    // title) cited as already rate-limited -- it never actually was.
    // Mirrors that sibling's constant/bucket shape now that the gap is
    // closed for real.
    await checkRateLimit(db, `landlet-claim:${builderId}`, LANDLET_CLAIM_RATE_LIMIT_MAX);
    // #1703: this free self-claim path never checked landlet_class/area_m2
    // against anything -- docs/SPEC.md's own "every signup can claim one
    // free 1,000 m² lándlet... Class 2+ reachable only via auction" rule
    // means a Class 2+ greenbelt landlet (reachable today via an admin
    // generate-ring call using distribution: 'power-law', per SPEC's own
    // "confirmed authoritative" size distribution) must never be grantable
    // through this free path, regardless of the claiming builder's own
    // land cap -- auction is the only paid route to more than the starter
    // size, by design.
    const [result] = await db.batch([
      db.prepare(`
        UPDATE landlets
        SET status = 'claimed', owner_builder_id = ?,
            claimable_at = COALESCE(claimable_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE landlet_id = ?
          AND status = 'greenbelt'
          AND owner_builder_id IS NULL
          AND landlet_type != 'water'
          AND landlet_class = 1
          AND NOT EXISTS (
            SELECT 1 FROM landlets AS owned
            WHERE owned.owner_builder_id = ? AND owned.status = 'claimed'
              AND NOT ${LANDLET_RELEASED_VIA_AUCTION_SQL}
          )
      `).bind(builderId, route[1], builderId),
      // #2223: spawnCreditOrbIfDue only ever targets a 'greenbelt' landlet,
      // and nothing else in this file ever deletes a credit_orbs row --
      // without this, an orb that spawned here before this claim landed
      // survives forever uncollectible (the client only loads orbs for
      // still-greenbelt landlets), permanently wasting part of the
      // rationed daily budget. Gated on the same EXISTS check so this is a
      // no-op when the claim above didn't actually land (a conflict, a
      // losing race, etc) -- by the time this second statement runs within
      // the same batch, the first one's write is already committed.
      db.prepare(`
        DELETE FROM credit_orbs WHERE landlet_id = ? AND collected_at IS NULL
          AND EXISTS (SELECT 1 FROM landlets WHERE landlet_id = ? AND status = 'claimed' AND owner_builder_id = ?)
      `).bind(route[1], route[1], builderId),
    ]);

    if (result.meta.changes === 0) {
      await explainClaimConflict(db, route[1], builderId);
    }

    const row = await db.prepare('SELECT * FROM landlets WHERE landlet_id = ?').bind(route[1]).first();
    return json({ landlet: landletFromRow(row) });
  }

  // #1177: owner-requested admin tool for handling land-ownership
  // situations by hand -- the generic PUT/PATCH above deliberately can
  // never touch ownerBuilderId (see its own comment on why), and the only
  // other paths that ever change it are a builder's own self-claim, an
  // auction win, or a builder-deletion release. This is the one
  // admin-only, directly-invariant-checked way to move an *already*-
  // claimed landlet to a different builder by hand.
  //
  // Judgment calls flagged in the issue, decided here rather than left
  // unresolved: (1) kept behind the same one-claimed-landlet-per-builder
  // invariant POST .../claim enforces, rather than letting an admin
  // override it -- nothing else in this file (recomputeLandCap,
  // explainClaimConflict, the self-claim/create paths) is built to handle
  // a builder legitimately owning two claimed landlets at once, so
  // bypassing it here would risk a silently inconsistent state elsewhere,
  // not just a one-off exception; (2) API-only, no new admin-page UI --
  // every other admin mutation in this file (land-cap grants, higgles
  // grants, land-candidate CRUD, ...) is API-only too, and a landlet id
  // typed into a request is no heavier an operation than those.
  if (request.method === 'POST' && route.length === 3 && route[2] === 'reassign-owner') {
    const admin = await requireAdmin(request, db);
    await checkRateLimit(db, `landlet-reassign-owner:${admin.user_id}`, LANDLET_REASSIGN_OWNER_RATE_LIMIT_MAX);
    const existing = await requireLandlet(db, route[1]);
    if (existing.status !== 'claimed' || existing.owner_builder_id === null) {
      throw new HttpError('Landlet is not currently claimed -- use POST .../claim instead', 409);
    }
    const input = await readJson(request);
    const newOwnerBuilderId = stringValue(input.ownerBuilderId, 'ownerBuilderId');
    await requireBuilder(db, newOwnerBuilderId);
    if (newOwnerBuilderId === existing.owner_builder_id) {
      throw new HttpError('Landlet is already owned by this builder', 409);
    }
    // #1711 (owner decision, 2026-10-13): "surface the conflict to the
    // admin at reassignment time instead of letting it resolve silently
    // later." Without cancelActiveAuction, an active auction on this
    // landlet blocks the reassignment outright, with the conflict's own
    // details (current high bid, bidder count) in the 409 response so an
    // admin UI can offer the two explicit choices the owner specified --
    // cancel-and-proceed (resubmit with cancelActiveAuction: true) or
    // abort (leave both the auction and current ownership untouched).
    const cancelActiveAuction = input.cancelActiveAuction === true;
    const auctionConflict = await activeAuctionConflict(db, route[1]);
    if (auctionConflict && !cancelActiveAuction) {
      throw new HttpError(
        'Landlet has an active auction -- cancel it first, or pass cancelActiveAuction: true '
        + 'to cancel it and reassign in one step',
        409,
        auctionConflict.extra,
      );
    }

    // Same atomic guard+write idiom as POST .../claim just above: the
    // concurrency check (both the still-matches-what-was-just-read guard
    // and the one-claimed-landlet-per-builder invariant) lives inside the
    // UPDATE's own WHERE, not a separate pre-check, so a concurrent claim/
    // auction/reassignment landing in between can't be silently clobbered
    // or bypassed.
    //
    // #1281 (owner decision, 2026-10-13): "land cap is a hard rule, full
    // stop -- no admin override, ever, including via manual reassignment."
    // Folds the same live land-cap re-derivation resolveAuction's own
    // winner-transfer UPDATE already uses (just above, in this same file)
    // into this UPDATE's own WHERE, for the same TOCTOU reason that
    // comment gives: a plain read-then-compare here could let two
    // concurrent reassignments onto the same new owner each pass against a
    // stale snapshot. Only the landlet's own area_m2 matters, never its
    // levels' cap_consumed_m2 -- the cleanup batch below always deletes
    // landlet_levels for this landlet as part of the same reassignment, so
    // by the time any level could count toward anyone's cap, it's gone.
    //
    // #1705: this guarded UPDATE must run standalone, checked, before the
    // three deletes below -- D1's db.batch can't skip later statements
    // based on an earlier one's row count within the same call (same fact
    // resolveAuction's own comment states), so batching them together let
    // this guard's 0-row "nothing happened" outcome still permanently wipe
    // the previous owner's build content and levels. Mirrors
    // resolveAuction's own split: the guarded transfer runs and is
    // confirmed first, and only then is the cleanup batch built/sent.
    //
    // #1711: folds "no active auction, unless the caller already said to
    // cancel one" into this same guarded WHERE, same TOCTOU reasoning as
    // every other clause here -- a new auction starting in the gap
    // between the pre-check above and this write must still block (or get
    // cancelled, if cancelActiveAuction was set) rather than silently
    // slip through on a stale read.
    const result = await db.prepare(`
      UPDATE landlets
      SET owner_builder_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE landlet_id = ? AND status = 'claimed' AND owner_builder_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM landlets AS owned
          WHERE owned.owner_builder_id = ? AND owned.status = 'claimed'
            AND NOT ${LANDLET_RELEASED_VIA_AUCTION_SQL}
        )
        AND (
          SELECT b.land_cap_m2 FROM builders b WHERE b.builder_id = ?
        ) + ? >= (
          ?
          + COALESCE((
              SELECT SUM(area_m2) FROM landlets AS owned
              WHERE owned.owner_builder_id = ? AND owned.status = 'claimed'
                AND NOT ${LANDLET_RELEASED_VIA_AUCTION_SQL}
            ), 0)
          + COALESCE((
              SELECT SUM(ll.cap_consumed_m2) FROM landlet_levels ll
              JOIN landlets AS owned ON owned.landlet_id = ll.landlet_id
              WHERE owned.owner_builder_id = ? AND owned.status = 'claimed'
                AND NOT ${LANDLET_RELEASED_VIA_AUCTION_SQL}
            ), 0)
        )
        AND (? = 1 OR NOT EXISTS (
          SELECT 1 FROM auctions WHERE landlet_id = ? AND status = 'active'
        ))
    `).bind(
      newOwnerBuilderId, route[1], existing.owner_builder_id, newOwnerBuilderId,
      newOwnerBuilderId, LAND_CAP_DISPLAY_ROUNDING_BUFFER_M2, existing.area_m2,
      newOwnerBuilderId, newOwnerBuilderId,
      cancelActiveAuction ? 1 : 0, route[1],
    ).run();
    if (result.meta.changes === 0) {
      const current = await requireLandlet(db, route[1]);
      if (current.owner_builder_id !== existing.owner_builder_id || current.status !== 'claimed') {
        throw new HttpError('Landlet changed concurrently — refetch and retry', 409);
      }
      const oneClaimedConflict = await db.prepare(`
        SELECT 1 FROM landlets AS owned WHERE owned.owner_builder_id = ? AND owned.status = 'claimed'
          AND NOT ${LANDLET_RELEASED_VIA_AUCTION_SQL}
      `).bind(newOwnerBuilderId).first();
      if (oneClaimedConflict) {
        throw new HttpError('Target builder already owns a claimed landlet', 409);
      }
      if (!cancelActiveAuction) {
        const raceConflict = await activeAuctionConflict(db, route[1]);
        if (raceConflict) {
          throw new HttpError(
            'Landlet has an active auction -- cancel it first, or pass cancelActiveAuction: true '
            + 'to cancel it and reassign in one step',
            409,
            raceConflict.extra,
          );
        }
      }
      throw new HttpError("Target builder's land cap can't cover this landlet", 409);
    }
    // #1711: re-read live, now that the transfer above is confirmed,
    // rather than reusing the pre-check's auctionConflict -- that read is
    // from before the guarded UPDATE ran, and cancelActiveAuction bypasses
    // the UPDATE's own auction clause, so a *new* auction that started in
    // the race window between the pre-check and the write would otherwise
    // go uncancelled (and its bidders un-refunded/unnotified) even though
    // the admin explicitly asked to cancel whatever's active on this
    // landlet.
    const auctionToCancel = cancelActiveAuction
      ? await db.prepare(`SELECT * FROM auctions WHERE landlet_id = ? AND status = 'active'`).bind(route[1]).first()
      : null;
    // Bids never actually debit a bidder's higgles_balance_cents up front
    // (handleAuctionBids' own "held" comment -- the real debit only
    // happens in resolveAuction, at settlement time), so there is no
    // currency in limbo to refund here, unlike the owner's comment on
    // #1711 anticipated as a general possibility -- just the courtesy
    // notification below that their bid no longer stands.
    // #1955: exclude newOwnerBuilderId -- they may have placed a losing-so-
    // far bid on this exact auction before the admin handed them the land
    // outright, and would otherwise get a "your bid was cancelled, no
    // winner" notification contradicting the "it's yours now" one just
    // below (same bug class #966 already fixed for resolveAuction's own
    // winner-who-also-lost-a-bid case).
    const cancelledAuctionBidderIds = auctionToCancel
      ? (await db.prepare('SELECT DISTINCT bidder_builder_id FROM auction_bids WHERE auction_id = ?')
        .bind(auctionToCancel.auction_id).all()).results
        .map((row) => row.bidder_builder_id)
        .filter((bidderBuilderId) => bidderBuilderId !== newOwnerBuilderId)
      : [];
    // #1280: these three deletes match the ones builder-deletion
    // (DELETE /api/builders/:id) and resolveAuction's own ownership-change
    // branches already run, closing the one ownership-change path that
    // left a new owner inheriting the previous owner's build content and
    // levels (docs/API.md's "Ownership-change cleanup" section states this
    // as a blanket invariant, not something scoped to just those paths).
    // Safe to batch together now that the transfer above is confirmed.
    await db.batch([
      db.prepare('DELETE FROM placed_instances WHERE landlet_id = ?').bind(route[1]),
      db.prepare('DELETE FROM landlet_versions WHERE landlet_id = ?').bind(route[1]),
      db.prepare('DELETE FROM landlet_levels WHERE landlet_id = ?').bind(route[1]),
      // #2508: same "new owner inherits the previous owner's stuff" cleanup
      // as the three deletes just above, for sold_out_markers -- missed when
      // #2068 introduced the table, after this cleanup shape was established.
      db.prepare('DELETE FROM sold_out_markers WHERE landlet_id = ?').bind(route[1]),
      adminActionLogStatement(db, admin.user_id, 'reassign_landlet_owner', 'landlet', route[1], {
        fromBuilderId: existing.owner_builder_id, toBuilderId: newOwnerBuilderId,
        ...(auctionToCancel ? { cancelledAuctionId: auctionToCancel.auction_id } : {}),
      }),
      // Guarded by status = 'active' like every other auction-ending
      // write in this file (resolveAuction's own guard above) -- a no-op
      // if this exact auction somehow already ended between the read just
      // above and here, rather than overwriting an already-final row.
      ...(auctionToCancel ? [db.prepare(`
        UPDATE auctions SET status = 'ended', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE auction_id = ? AND status = 'active'
      `).bind(auctionToCancel.auction_id)] : []),
    ]);
    // Non-blocking, like handleLandletLevels' own post-write calls: the
    // transfer itself is already blocked when it would put the new owner
    // over cap (#1281, the guarded UPDATE above) -- this just corrects the
    // new owner's displayed land cap/owned area right away, instead of
    // leaving it stale until some unrelated later action happens to
    // trigger a recompute.
    await recomputeLandCap(db, newOwnerBuilderId);
    // Same post-batch, outside-the-atomic-write shape as auctionWinnerNotifications'
    // own call above (#1122) -- a self-delete race on either recipient must
    // not roll back the ownership transfer itself.
    await fireNotifications(db, [
      { builderId: existing.owner_builder_id,
        message: auctionToCancel
          ? `Your lándlet ${route[1]} was reassigned to another builder by an admin, and your active auction on it was cancelled.`
          : `Your lándlet ${route[1]} was reassigned to another builder by an admin.` },
      { builderId: newOwnerBuilderId,
        message: `A lándlet (${route[1]}) was reassigned to you by an admin. It's yours to build on now.` },
      ...cancelledAuctionBidderIds.map((bidderBuilderId) => ({
        builderId: bidderBuilderId,
        message: `Your bid on ${route[1]} was cancelled — the landlet was reassigned by an admin and the auction ended with no winner.`,
      })),
    ]);
    const updated = await requireLandlet(db, route[1]);
    return json({ landlet: landletFromRow(updated) });
  }

  if (request.method === 'POST' && route.length === 1) {
    const input = await readJson(request);
    const landlet = validateLandlet(input, crypto.randomUUID());
    // Unowned (greenbelt/generating) creation stays unauthenticated — the
    // same "world-generation/admin housekeeping" territory the PUT/PATCH
    // handler below already documents. A caller-supplied owner is a
    // different story: without this check, anyone could fabricate an
    // already-claimed landlet (any polygon, any location) under any
    // builder's id from the request body alone, bypassing every invariant
    // POST .../claim enforces (available-greenbelt-only, one claimed
    // landlet per builder) — the exact vector
    // PUT/PATCH's own comment below describes closing, just never applied
    // to this creation path too. Creating a landlet already claimed by
    // *yourself* is still allowed (existing test/dev-tooling usage relies
    // on it), only ever as the session's own builder.
    let sessionBuilder = null;
    if (landlet.ownerBuilderId !== null) {
      sessionBuilder = await requireSessionBuilder(request, db);
      assertOwner(landlet.ownerBuilderId, sessionBuilder.builder_id, 'Can only create a landlet owned by yourself');
      // #799: an owner with any status other than 'claimed' would dodge
      // recomputeLandCap's own `status = 'claimed'` filter (a few hundred
      // lines up) while still passing every ownership check downstream
      // (requireOwnedLandlet only ever looks at owner_builder_id) — free,
      // permanently uncounted land. The "claimed implies owner" half of
      // this invariant is enforced below for the unowned branch; this is
      // its "owner implies claimed" other half.
      if (landlet.status !== 'claimed') {
        throw new HttpError('An owned landlet must have status "claimed"', 400);
      }
      // #825: this is the one path where a landlet's own `area_m2` is
      // fully client-controlled, yet `levelCapConsumedM2` bills vertical
      // construction against exactly that value while the real buildable
      // footprint (assertInstanceXYWithinLandlet) always uses the fixed
      // LANDLET_AREA_M2 constant regardless — an attacker-chosen tiny
      // areaM2 would grant the real 1000m² footprint for near-zero land-cap
      // cost per level, unboundedly. The real `POST .../claim` flow never
      // lets the client set area at all, so there's nothing legitimate to
      // preserve here; every existing test already passes exactly
      // LANDLET_AREA_M2 for this branch.
      landlet.areaM2 = LANDLET_AREA_M2;
      // #1766: same free-Class-2+ gap #1703 fixed on the sibling
      // POST .../claim endpoint -- areaM2 above is already forced to the
      // free-starter constant regardless of landClass, but nothing
      // stopped a caller from setting landClass itself to anything, self-
      // claiming a "larger" landlet class for free with no auction.
      if (landlet.landClass !== 1) {
        throw new HttpError('This landlet is larger than the free starter size -- it can only be acquired via auction', 409);
      }
      await checkRateLimit(db, `landlet-self-claim-create:${sessionBuilder.builder_id}`, LANDLET_SELF_CLAIM_CREATE_RATE_LIMIT_MAX);
    } else if (landlet.status === 'claimed') {
      // The same "claimed implies non-null owner" invariant PUT/PATCH
      // already protects (see that handler's own comment, and #224) —
      // without this, the ownerBuilderId check above is a no-op for an
      // anonymous request that sets status:'claimed' but simply omits
      // ownerBuilderId: it sails through as "unowned creation," leaving a
      // landlet permanently stuck (un-claimable via POST .../claim, and
      // not eligible for DELETE's owned-land protection either) with no
      // way back. Unlike PUT/PATCH there's no existing row to silently pin
      // this back to, so this rejects outright instead.
      throw new HttpError('A claimed landlet must have an ownerBuilderId', 400);
    } else {
      // #964: the self-claim branch above already rate-limits itself
      // (checkRateLimit a few lines up); this is the genuinely-unowned,
      // fully-unauthenticated path, which had no throttle at all — an
      // unbounded, anonymous way to flood the landlets table.
      await checkRateLimit(db, `landlet-create:${clientIp(request)}`, LANDLET_CREATE_RATE_LIMIT_MAX);
    }
    // #799: folded into the INSERT's own WHERE clause (same atomic idiom as
    // POST .../claim's UPDATE a few dozen lines up, and the landlet-level
    // add's own INSERT) rather than a separate SELECT-then-INSERT, so two
    // concurrent self-claiming creates from the same builder can't both
    // pass a stale "don't already own a claimed landlet" check. The `? = 0`
    // guard skips the subquery (and the still-null ownerBuilderId bind)
    // entirely for the ordinary unowned-creation path, where it never
    // applies.
    const inserted = await db.prepare(`
      INSERT INTO landlets
        (landlet_id, name, area_m2, center_x_m, center_y_m, status, owner_builder_id, landlet_class,
         polygon_json, generated_at, claimable_at, metadata_json, landlet_type, biome, elevation_m, max_world_radius_m)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE ? = 0 OR NOT EXISTS (
        SELECT 1 FROM landlets AS owned
        WHERE owned.owner_builder_id = ? AND owned.status = 'claimed'
          AND NOT ${LANDLET_RELEASED_VIA_AUCTION_SQL}
      )
    `).bind(
      ...landletParams(landlet), landletMaxWorldRadius(candidateRowFromLandlet(landlet)),
      sessionBuilder ? 1 : 0, landlet.ownerBuilderId,
    ).run();
    if (sessionBuilder && inserted.meta.changes === 0) {
      throw new HttpError('You already own a claimed landlet', 409);
    }
    return json({ landlet }, 201);
  }

  if ((request.method === 'PUT' || request.method === 'PATCH') && route.length === 2) {
    const existing = await db.prepare('SELECT * FROM landlets WHERE landlet_id = ?').bind(route[1]).first();
    if (!existing) return json({ error: 'Landlet not found' }, 404);
    // Unowned (greenbelt/generating) landlets stay unauthenticated here —
    // this is world-generation/admin housekeeping (status transitions,
    // polygon/metadata fixes), the same "no builder ownership concept
    // applies yet" territory as unowned creation via POST /api/landlets
    // itself (see that handler's own comment) and the land-candidates/
    // world endpoints. An *owned* landlet is a different story: only its
    // own builder may touch it, and — regardless of who's asking —
    // ownership itself can never change through this endpoint. A full
    // PUT/PATCH that could freely set `ownerBuilderId` was a real "claim
    // any landlet, bypass every invariant POST .../claim enforces" vector
    // with no login required at all; ownership transfer only ever happens
    // through that dedicated, invariant-checked endpoint now.
    if (existing.owner_builder_id !== null) {
      const sessionBuilder = await requireSessionBuilder(request, db);
      assertOwner(existing.owner_builder_id, sessionBuilder.builder_id, 'Not your landlet');
      // #1150: this endpoint had no rate limit at all before "My Lands"
      // gave it a real, repeatable, owner-facing write affordance (rename)
      // — same bucketing convention as BUILDER_RENAME_RATE_LIMIT_MAX/
      // SELLER_RENAME_RATE_LIMIT_MAX. Scoped to the owned branch only; the
      // unauthenticated unowned/world-gen branch below has no builder id
      // to bucket by and isn't the path this issue is about.
      await checkRateLimit(db, `landlet-owned-patch:${sessionBuilder.builder_id}`, LANDLET_OWNED_PATCH_RATE_LIMIT_MAX);
    } else {
      // #1476: the unowned/world-gen branch above had no throttle at all --
      // an unbounded, anonymous way to flood real D1 writes to any
      // unclaimed landlet's status/polygon/metadata.
      await checkRateLimit(db, `landlet-unowned-patch:${clientIp(request)}`, LANDLET_UNOWNED_PATCH_RATE_LIMIT_MAX);
    }
    const input = await readJson(request);
    // `status` needs the same pinning as `ownerBuilderId` above, for the
    // same reason: an unowned landlet's `status` is otherwise settable to
    // `'claimed'` by anyone, with no owner ever assigned — the exact
    // "claimed implies non-null owner" invariant every other call site in
    // this file relies on (recomputeLandCap, explainClaimConflict, ...),
    // broken with no login and no way back (a `'claimed'` landlet never
    // matches `explainClaimConflict`'s available-greenbelt check again).
    // Claimed-state transitions only ever happen through the dedicated
    // claim/auction endpoints, same as ownership transfer itself.
    // #956: this used to only pin status for the unowned branch above,
    // leaving the reverse direction wide open -- an owning builder could
    // PATCH their own claimed landlet's status to 'greenbelt' (owner stays
    // non-null), which drops out of POST .../claim's "already owns a
    // claimed landlet" NOT EXISTS check, letting them claim unlimited
    // additional landlets. Pinned unconditionally now, matching
    // ownerBuilderId's own unconditional pin just above.
    input.status = existing.status;
    // #1786: areaM2/landClass need the exact same pin as status just above
    // -- a landlet's real buildable footprint is always the fixed
    // LANDLET_AREA_M2 constant, independent of this area_m2 column; that
    // column only exists as recomputeLandCap's own SUM(area_m2) input for
    // the land-cap check. Without this, an owning builder could shrink
    // their own claimed landlet's areaM2 down toward zero through this
    // generic PUT/PATCH, making every later land-cap check believe they
    // own almost nothing while every landlet they hold keeps its full,
    // unchanged buildable square -- unlimited free land. #1703/#1766
    // already closed this exact gap on the claim/self-claim-create
    // endpoints; this one was missed.
    input.areaM2 = existing.area_m2;
    input.landClass = existing.landlet_class;
    const landlet = validateLandlet(
      { ...landletFromRow(existing), ...input, landletId: route[1], ownerBuilderId: existing.owner_builder_id },
      route[1],
    );
    // Guarded on status/owner_builder_id still matching what was just read
    // above — without this, a concurrent claim (or auction resolution)
    // landing between that read and this write would get silently
    // clobbered back to the stale values this request pinned status/
    // ownerBuilderId to, undoing the claim with no trace (this endpoint's
    // own response would even report success). `IS` rather than `=` so the
    // owner_builder_id IS NULL case binds correctly. A lost race surfaces
    // as 409 so the caller knows to refetch, the same shape as every other
    // concurrent-write guard in this file.
    // #1150: "names must be unique across all of Higglehaven" — folded
    // into this UPDATE's own WHERE as a NOT EXISTS, same atomic idiom this
    // file already uses for signup/friendships/product_reviews, rather
    // than a schema-level UNIQUE index. A real index would also apply to
    // every *unclaimed* landlet's auto-generated name (candidateMaterializationSweepStatements'
    // own INSERT, landGenerator.js's `${prefix} ${index + 1}`) — ring
    // generation can legitimately reuse a prefix across separate calls
    // (confirmed via #849/#1055's own concurrent-expansion tests, which
    // started failing with a real index in place), so this is scoped to
    // the one write path this issue is actually about instead.
    // renamingTo stays null on every PATCH that isn't actually renaming
    // (the overwhelmingly common case — e.g. every ownership/status
    // housekeeping PATCH elsewhere in this file re-sends the existing name
    // unchanged), short-circuiting the NOT EXISTS subquery via `? IS NULL`
    // below. This can't be a bare `name = ?` comparison inside the UPDATE's
    // own WHERE instead: a bare column reference there reads the row's
    // *pre-update* value, which already always equals `existing.name`
    // outside of a genuine concurrent-write race — so a same-row check like
    // that would short-circuit on every rename attempt too, not just
    // no-op ones, silently defeating this guard entirely (caught by this
    // issue's own test).
    const renamingTo = landlet.name !== existing.name ? landlet.name : null;
    const result = await db.prepare(`
      UPDATE landlets
      SET name = ?, area_m2 = ?, center_x_m = ?, center_y_m = ?, status = ?, owner_builder_id = ?,
          landlet_class = ?, polygon_json = ?, generated_at = ?, claimable_at = ?, metadata_json = ?,
          landlet_type = ?, biome = ?, elevation_m = ?, max_world_radius_m = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE landlet_id = ? AND status = ? AND owner_builder_id IS ?
        AND (
          ? IS NULL OR NOT EXISTS (SELECT 1 FROM landlets WHERE name = ? COLLATE NOCASE AND landlet_id != ?)
        )
    `).bind(
      landlet.name, landlet.areaM2, landlet.center.x, landlet.center.y, landlet.status,
      landlet.ownerBuilderId, landlet.landClass, JSON.stringify(landlet.polygon), landlet.generatedAt,
      landlet.claimableAt, JSON.stringify(landlet.metadata), landlet.landType, landlet.biome ?? null,
      // #2967: this column was missing from the SET clause entirely -- a
      // caller-supplied elevationM silently never persisted, even though
      // the response (built from the local `landlet` object, not a DB
      // re-read) reported success with the new value.
      landlet.elevationM ?? null,
      landletMaxWorldRadius(candidateRowFromLandlet(landlet)), route[1],
      existing.status, existing.owner_builder_id,
      renamingTo, renamingTo, route[1],
    ).run();
    if (result.meta.changes === 0) {
      // The atomic guard above already refused to happen — reading again
      // here only decides which friendly message to show, it can't itself
      // let a duplicate through (same idiom as signup's own email/username
      // disambiguation above).
      if (landlet.name !== existing.name) {
        const nameTaken = await db.prepare('SELECT 1 FROM landlets WHERE name = ? COLLATE NOCASE AND landlet_id != ?')
          .bind(landlet.name, route[1]).first();
        if (nameTaken) throw new HttpError('That land name is already taken — names must be unique across all of Higglehaven', 409);
      }
      throw new HttpError('Landlet changed concurrently — refetch and retry', 409);
    }
    return json({ landlet });
  }

  if (request.method === 'DELETE' && route.length === 2) {
    const existing = await db.prepare('SELECT owner_builder_id FROM landlets WHERE landlet_id = ?').bind(route[1]).first();
    if (!existing) return json({ error: 'Landlet not found' }, 404);
    // Blocked outright once owned, for anyone — this raw DELETE has no
    // cascade for the owner's placed_instances/landlet_versions the way
    // DELETE /api/builders/:id's own release path does, so it would leave
    // orphaned rows behind even for the genuine owner. Releasing owned
    // land already has real paths (deleting the builder; eventually an
    // inactivity/auction reclaim) — this endpoint stays for admin/test
    // cleanup of unowned (greenbelt/generating) rows only.
    if (existing.owner_builder_id !== null) {
      throw new HttpError('Cannot delete an owned landlet directly — release it via its builder instead', 409);
    }
    // #1794: same unauthenticated-flood guard as this handler's own
    // create/#964 and unowned-patch/#1476 branches.
    await checkRateLimit(db, `landlet-delete:${clientIp(request)}`, LANDLET_DELETE_RATE_LIMIT_MAX);
    // Re-checked as part of the DELETE itself, not just the read above — a
    // claim landing in between would otherwise still get deleted out from
    // under its new owner, matching the same race the PUT/PATCH guard just
    // above this now also closes.
    const result = await db.prepare('DELETE FROM landlets WHERE landlet_id = ? AND owner_builder_id IS NULL').bind(route[1]).run();
    if (result.meta.changes === 0) {
      throw new HttpError('Cannot delete an owned landlet directly — release it via its builder instead', 409);
    }
    return json({ deleted: true });
  }

  return json({ error: 'Not found' }, 404);
}

export async function handleLiveLandlet(db, landletId) {
  const row = await requireLandlet(db, landletId);
  const landlet = landletFromRow(row);
  if (!landlet.activeVersionId) {
    return json({ landlet, published: false, version: null, instances: [] });
  }

  const version = await getVersion(db, landletId, landlet.activeVersionId);
  if (!version) throw new HttpError('Active landlet version not found', 500);
  const { results } = await db.prepare(`
    SELECT * FROM version_instances WHERE version_id = ? ORDER BY source_instance_id
  `).bind(landlet.activeVersionId).all();
  return json({
    landlet,
    published: true,
    version,
    instances: results.map(versionInstanceFromRow),
  });
}

// #1726: mirrors purchaseIdempotencyKey's pattern (#473) for this
// endpoint's own auto-version side effect — the client mints+persists a
// key across a retry of what it considers the same save (most importantly
// one whose response never arrived), and a missing/malformed key degrades
// to no idempotency protection rather than failing the save outright.
// Namespaced with landletId and the owner's builder_id so a key can never
// collide across a different landlet or a since-transferred owner.
function landletVersionIdempotencyKey(landletId, ownerBuilderId, rawKey) {
  if (typeof rawKey !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(rawKey)) return undefined;
  return `landlet-draft-version:${landletId}:${ownerBuilderId}:${rawKey}`;
}

export async function handleLandletDraft(request, db, landletId) {
  const landlet = await requireLandlet(db, landletId);

  if (request.method === 'GET') {
    const { results } = await db.prepare('SELECT * FROM placed_instances WHERE landlet_id = ? ORDER BY created_at').bind(landletId).all();
    return json({ instances: results.map(instanceFromRow) });
  }

  if (request.method === 'PUT') {
    // No builderId field exists on this endpoint to spoof (it never took
    // one) — before this check it was a fully open, no-identity-at-all
    // destructive replace of any landlet's entire live draft. The check
    // has to be "does the target landlet's own owner match the session,"
    // there's nothing else to compare against.
    const sessionBuilder = await requireSessionBuilder(request, db);
    assertOwner(landlet.owner_builder_id, sessionBuilder.builder_id, 'Not your landlet');
    await checkRateLimit(db, `landlet-version:${sessionBuilder.builder_id}`, LANDLET_VERSION_RATE_LIMIT_MAX);
    const input = await readJson(request);
    if (!Array.isArray(input.instances)) throw new HttpError('instances must be an array', 400);
    if (input.instances.length > 250) throw new HttpError('instances must contain at most 250 items', 400);

    const instances = input.instances.map((item) => validateInstance({ ...item, landletId }, crypto.randomUUID()));
    const ids = new Set();
    for (const instance of instances) {
      if (ids.has(instance.instanceId)) throw new HttpError('instanceId values must be unique', 400);
      ids.add(instance.instanceId);
    }
    // #860: same "only re-check what actually changed" reasoning as the
    // instances/batch endpoint's own fix above — this endpoint always
    // resends the landlet's *entire* current draft (every instance, not
    // just touched ones, per this endpoint's own "atomically replaces the
    // landlet's entire live draft" contract), so validating every assert
    // unconditionally would brick every future save on the whole landlet
    // — not just an edit to the affected instance — the moment a template
    // shrinks or a level/bound tightens under an already-placed instance.
    const existingInstances = await getInstancesById(db, [...ids]);
    const instancesNeedingCropCheck = instances.filter((instance) => {
      const existing = existingInstances.get(instance.instanceId);
      return !existing || instance.templateId !== existing.templateId || !cropsEqual(instance.crop, existing.crop);
    });
    await assertCropWithinTemplateBounds(db, instancesNeedingCropCheck);
    const instancesNeedingZCheck = instances.filter((instance) => {
      const existing = existingInstances.get(instance.instanceId);
      return !existing || instance.z !== existing.z || instance.landletId !== existing.landletId;
    });
    await assertInstanceZWithinLevels(db, instancesNeedingZCheck);
    // #1048: scale's own [0.001, 1000] domain bound is checked before the
    // footprint-aware XY check below — cheap and DB-lookup-free, so an
    // obviously-malformed scale gets its own specific error rather than
    // being masked by the footprint check's "extends outside landlet"
    // message once that check also starts factoring scale in.
    const instancesNeedingScaleCheck = instances.filter((instance) => {
      const existing = existingInstances.get(instance.instanceId);
      return !existing || instance.scale !== existing.scale;
    });
    assertInstanceScaleWithinBounds(instancesNeedingScaleCheck);
    // The XY check is now footprint-aware (crop and scale affect an
    // instance's rendered edges, not just its center point), so it also
    // needs to re-run whenever crop or scale changed, not just x/y/z/
    // landletId — otherwise an untouched x/y whose *footprint* just grew
    // (a scale bump resent alongside an unrelated move) could slip through.
    const instancesNeedingXYCheck = instances.filter((instance) => {
      const existing = existingInstances.get(instance.instanceId);
      return !existing || instance.x !== existing.x || instance.y !== existing.y || instance.z !== existing.z
        || instance.landletId !== existing.landletId || instance.scale !== existing.scale
        || instance.templateId !== existing.templateId || !cropsEqual(instance.crop, existing.crop);
    });
    await assertInstanceXYWithinLandlet(db, instancesNeedingXYCheck);

    // #2968: same ownership-verification rule #2959/#2961 already applies
    // to a fresh instance created via POST/PUT /instances/batch -- this
    // endpoint accepts the identical client-supplied instances shape, most
    // reachably via "Restore to Editor" (src/build/scene.js) resending an
    // old version's own snapshot, which can now carry a groupId once
    // #2968's version_instances column exists. An unverified value here
    // has the exact same griefing risk #2959 closed for batch-create:
    // silently attaching a (re-created) instance to another builder's
    // group. Only honor a groupId the caller already owns at least one
    // other member of; anything else is treated as null, same as #2959.
    const candidateGroupIds = [...new Set(instances.map((instance) => instance.groupId).filter(Boolean))];
    let verifiedGroupIds = new Set();
    if (candidateGroupIds.length > 0) {
      const placeholders = candidateGroupIds.map(() => '?').join(', ');
      const { results: ownedGroups } = await db.prepare(`
        SELECT DISTINCT group_id FROM placed_instances
        WHERE group_id IN (${placeholders})
          AND EXISTS (SELECT 1 FROM landlets WHERE landlet_id = placed_instances.landlet_id AND owner_builder_id = ?)
      `).bind(...candidateGroupIds, sessionBuilder.builder_id).all();
      verifiedGroupIds = new Set(ownedGroups.map((row) => row.group_id));
    }
    const instancesForInsert = instances.map((instance) => ({
      ...instance,
      groupId: verifiedGroupIds.has(instance.groupId) ? instance.groupId : null,
    }));

    // #1726: a deterministic versionId (from the client's own idempotency
    // key, when present and valid) lets a retry's INSERT below no-op via
    // ON CONFLICT instead of minting a second, fully duplicate version.
    const idempotencyKey = landletVersionIdempotencyKey(landletId, landlet.owner_builder_id, input.idempotencyKey);
    let versionId = idempotencyKey || crypto.randomUUID();
    // #480: same gap as handleLandletVersions' POST above.
    const versionName = optionalLabelValue(input.versionName, 'versionName');
    const versionMetadata = input.versionMetadata || {};
    JSON.stringify(versionMetadata);
    if (idempotencyKey) {
      // #2184: same "a client-supplied idempotency key reused for
      // genuinely different content must not fabricate a stale success"
      // fix handleLandletVersions' own POST above already applies (#1874,
      // itself following #1750/#1751/#1758/#1873) -- this endpoint's
      // auto-version side effect never got it, so a retry with the same
      // idempotencyKey but genuinely different versionName/versionMetadata
      // used to silently no-op on the version INSERT below, leaving the
      // returned (and permanently stored) version mismatched against the
      // live draft it's supposed to represent. Minting a fresh versionId
      // on a real mismatch is the same escape hatch the sibling uses;
      // unlike that POST, this PUT can't just return the existing version
      // early, since replacing the draft's placed_instances always has to
      // run regardless of the version side effect's own dedup outcome.
      const existing = await getVersion(db, landletId, idempotencyKey);
      if (existing) {
        const expectedName = versionName ?? `Version ${existing.versionNumber}`;
        const matches = existing.name === expectedName && JSON.stringify(existing.metadata) === JSON.stringify(versionMetadata);
        if (!matches) versionId = crypto.randomUUID();
      }
    }

    // Upsert-by-instance_id, not delete-all/re-insert: sign_posts and
    // calendar_events both cascade-delete on their own instance_id (see
    // migrations/0041/0042), so a wholesale delete-then-recreate silently
    // wiped every post/event on the lándlet on every single draft save,
    // even though the recreated instance kept the same instance_id and so
    // *looked* untouched in the UI. Genuinely-removed instances (not
    // present in the new set) still get a real DELETE below, which is the
    // one case where losing their posts/events to the cascade is correct.
    //
    // #415: the leading guard statement (re-pinning owner_builder_id, its
    // own meta.changes checked after the batch) plus the same condition
    // folded into every real write's own WHERE/SELECT below is the same
    // belt-and-suspenders idiom as handleLandletVersions' POST above —
    // without it, an auction resolving (transferring ownership, wiping
    // this landlet's placed_instances/landlet_versions) in the await gap
    // between the ownership check above and this batch would still let
    // this request repopulate the new owner's landlet with the old
    // owner's stale content.
    const ownerGuard = 'EXISTS (SELECT 1 FROM landlets WHERE landlet_id = ? AND owner_builder_id IS ?)';
    const batchResults = await db.batch([
      db.prepare(`
        UPDATE landlets SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE landlet_id = ? AND owner_builder_id IS ?
      `).bind(landletId, landlet.owner_builder_id),
      db.prepare(`
        DELETE FROM placed_instances
        WHERE landlet_id = ?
          AND instance_id NOT IN (SELECT json_extract(value, '$.instanceId') FROM json_each(?))
          AND ${ownerGuard}
      `).bind(landletId, JSON.stringify(instances), landletId, landlet.owner_builder_id),
      db.prepare(`
        INSERT INTO placed_instances
          (instance_id, landlet_id, template_id, x_m, y_m, z_m, rotation_x_rad, rotation_y_rad, rotation_z_rad, label, crop_json, scale, is_community_sign, is_community_calendar, group_id)
        SELECT
          json_extract(value, '$.instanceId'), ?, json_extract(value, '$.templateId'),
          json_extract(value, '$.x'), json_extract(value, '$.y'), json_extract(value, '$.z'),
          json_extract(value, '$.rotationX'), json_extract(value, '$.rotationY'), json_extract(value, '$.rotationZ'),
          json_extract(value, '$.label'), json_extract(value, '$.crop'), json_extract(value, '$.scale'),
          json_extract(value, '$.isCommunitySign'), json_extract(value, '$.isCommunityCalendar'), json_extract(value, '$.groupId')
        FROM json_each(?)
        -- Doubles as the ownership guard and as the non-trivial WHERE
        -- SQLite's upsert grammar requires here (a bare "ON" after
        -- "INSERT ... SELECT ... FROM" is otherwise ambiguous with a
        -- join's ON clause — see sqlite.org/lang_upsert.html; confirmed
        -- by hand, this statement 400s with "near DO: syntax error"
        -- without some WHERE clause).
        WHERE ${ownerGuard}
        ON CONFLICT(instance_id) DO UPDATE SET
          landlet_id = excluded.landlet_id, template_id = excluded.template_id,
          x_m = excluded.x_m, y_m = excluded.y_m, z_m = excluded.z_m,
          rotation_x_rad = excluded.rotation_x_rad, rotation_y_rad = excluded.rotation_y_rad,
          rotation_z_rad = excluded.rotation_z_rad, label = excluded.label, crop_json = excluded.crop_json,
          scale = excluded.scale, is_community_sign = excluded.is_community_sign,
          is_community_calendar = excluded.is_community_calendar,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      `).bind(landletId, JSON.stringify(instancesForInsert), landletId, landlet.owner_builder_id),
      db.prepare(`
        INSERT INTO landlet_versions (version_id, landlet_id, version_number, name, metadata_json)
        SELECT ?, ?, next_version_number,
               COALESCE(?, 'Version ' || next_version_number), ?
        FROM (
          SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version_number
          FROM landlet_versions WHERE landlet_id = ?
        )
        WHERE ${ownerGuard}
        -- #1726: a retry bearing the same idempotency-derived versionId
        -- no-ops here instead of racing a second version_number for it.
        ON CONFLICT(version_id) DO NOTHING
      `).bind(versionId, landletId, versionName, JSON.stringify(versionMetadata), landletId, landletId, landlet.owner_builder_id),
      db.prepare(`
        INSERT INTO version_instances
          (version_id, source_instance_id, template_id, x_m, y_m, z_m, rotation_x_rad, rotation_y_rad, rotation_z_rad, label, crop_json, scale, is_community_sign, is_community_calendar, group_id)
        SELECT ?, instance_id, template_id, x_m, y_m, z_m, rotation_x_rad, rotation_y_rad, rotation_z_rad, label, crop_json, scale, is_community_sign, is_community_calendar, group_id
        FROM placed_instances WHERE landlet_id = ?
          AND ${ownerGuard}
        -- #1726: same no-op-on-retry reasoning as the INSERT above — this
        -- table's PK is (version_id, source_instance_id).
        ON CONFLICT(version_id, source_instance_id) DO NOTHING
      `).bind(versionId, landletId, landletId, landlet.owner_builder_id),
    ]);
    if (batchResults[0].meta.changes === 0) {
      throw new HttpError('Landlet changed concurrently — refetch and retry', 409);
    }
    // #1695: same #1022/#1675 cleanup, the third call site sharing this
    // upsert's own is_community_sign/is_community_calendar flip --
    // existingInstances (fetched above for the crop/scale/XY re-validation)
    // already has each instance's prior flag value to diff against, same
    // as #1675's own loop over the batch endpoint.
    for (const instance of instances) {
      const existing = existingInstances.get(instance.instanceId);
      if (existing?.isCommunitySign && !instance.isCommunitySign) {
        await db.prepare('DELETE FROM sign_posts WHERE instance_id = ?').bind(instance.instanceId).run();
      }
      if (existing?.isCommunityCalendar && !instance.isCommunityCalendar) {
        await db.prepare('DELETE FROM calendar_events WHERE instance_id = ?').bind(instance.instanceId).run();
      }
    }

    const { results } = await db.prepare('SELECT * FROM placed_instances WHERE landlet_id = ? ORDER BY created_at').bind(landletId).all();
    const version = await getVersion(db, landletId, versionId);
    return json({ instances: results.map(instanceFromRow), version });
  }

  return json({ error: 'Not found' }, 404);
}
