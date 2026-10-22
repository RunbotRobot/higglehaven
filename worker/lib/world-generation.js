// #2534: the land-candidates/world-generation domain -- the admin-facing
// land-candidate/ring/world endpoints, plus the auto-growth machinery the
// scheduled() cron trigger drives (see autoGrowWorldIfNeeded's own comment
// for the history). Extracted verbatim from worker/index.js, zero behavior
// change (sub-issue of #2502, itself sub-issue of #2500's worker/index.js
// module split).
//
// Deliberately does NOT include autoAuctionInactiveLandlets/
// warnInactiveLandletOwners (the scheduled() cron's other two calls,
// previously defined in between generateAutoMosaicIfFreshWorld and
// generateRingAtWorldBoundary here) -- those are the auctions/inactivity
// domain (#2538's own territory, still blocked), not world-generation; they
// share nothing from this file beyond being called from the same cron tick,
// and stay in worker/index.js for that sub-issue to pick up.
//
// handleLandlets itself (the /api/landlets CRUD dispatcher) also stays in
// worker/index.js -- it's the landlet-core domain (#2533, not yet started),
// not world-generation -- but it shares candidateRowFromLandlet (both
// domains build the same landlet_candidates row shape) with the handlers
// here, so worker/index.js imports that one back from this module rather
// than duplicating it. worldFromRow (staying in worker/index.js) similarly
// imports computeGreenbeltRatio back. Both are one-directional
// (worker/index.js -> this file), not circular -- this module never needs
// anything back from worker/index.js at module-evaluation time, following
// the same safe-cycle precedent #2501/#2528/#2535 already established where
// the dependency genuinely does run the other way.
import {
  landletMaxWorldRadius, landletMinWorldRadius, landletWorldPolygon, pointInPolygon, pointToSegmentDistance,
  polygonsOverlap, sameAreaRadius,
} from '../geometry.js';
import { generateLandletRing, powerLawPlots } from '../landGenerator.js';
import { generateOrganicMosaic } from '../organicLandGenerator.js';
import { json, HttpError } from './http.js';
import {
  readJson, stringValue, finiteNumber, queryLimit, decodeCursor, encodeCursor, positiveInteger,
} from './validation.js';
import { adminActionLogStatement } from './admin-log.js';
import { requireAdmin } from './auth.js';
import { checkRateLimit } from './rate-limit.js';
import {
  candidateFromRow, landletFromRow, landCandidateRingFromRow, worldFromRow, validateLandlet, validateWorld,
  requireLandlet,
} from '../index.js';

// Owner (issue-570, 2026-09-09 -- picked option (a), "apply unconditionally
// like generate-mosaic"): the manual/bulk-import creation endpoints below
// (single POST and POST .../batch) used to skip the spatial overlap check
// generate-mosaic and generate-ring already enforce procedurally, so an
// admin-supplied candidate could silently overlap already-claimed,
// already-rendered land. Shared here so generate-mosaic and both of these
// endpoints all enforce the exact same check instead of duplicating it.
//
// Takes full rows (not pre-extracted polygons): a row with no explicit
// polygon (the plain manual-candidate shape — just center+areaM2) isn't a
// degenerate zero-area shape to skip. Everywhere else that reads such a row
// (landletMinWorldRadius/landletMaxWorldRadius above) treats it as a circle
// of radius sameAreaRadius(areaM2) around its center, so this represents
// both shapes rather than letting polygonsOverlap silently see an empty
// polygon and report no conflict.
function landletFootprint(row) {
  const polygon = landletWorldPolygon(row);
  if (polygon.length >= 3) return { polygon };
  return { circle: { x: row.center_x_m, y: row.center_y_m, radius: sameAreaRadius(row.area_m2) } };
}

function footprintsOverlap(a, b) {
  if (a.polygon && b.polygon) return polygonsOverlap(a.polygon, b.polygon);
  if (a.circle && b.circle) {
    return Math.hypot(a.circle.x - b.circle.x, a.circle.y - b.circle.y) < a.circle.radius + b.circle.radius;
  }
  const [circle, polygon] = a.circle ? [a.circle, b.polygon] : [b.circle, a.polygon];
  if (pointInPolygon(circle, polygon)) return true;
  return polygon.some((point, index) =>
    pointToSegmentDistance(circle, point, polygon[(index + 1) % polygon.length]) < circle.radius);
}

async function assertLandCandidatesDontOverlapExisting(db, newRows, message) {
  const [existingLandlets, existingCandidates] = await Promise.all([
    db.prepare("SELECT center_x_m, center_y_m, area_m2, polygon_json FROM landlets WHERE landlet_id <> 'starter-landlet'").all(),
    db.prepare('SELECT center_x_m, center_y_m, area_m2, polygon_json FROM landlet_candidates').all(),
  ]);
  // Only a landlet with a real polygon represents genuinely-positioned land
  // here -- landletWorldPolygon's own comment already treats a polygon-less
  // row as "the plain-square fallback landlets predating procedural
  // generation," not real geometry to defend. POST /landlets' own comment
  // ("existing test/dev-tooling usage relies on it") confirms this is a
  // real, ongoing shape: an unowned/self-owned landlet can be created there
  // with no polygon and no spatial check at all, purely as scaffolding for
  // whatever the test actually cares about (an instance, a version, ...),
  // often left at the coordinate default (0,0). Falling back to a circle
  // footprint for those too (as the new incoming candidates below still do)
  // would make every one of them permanently block any future land-
  // candidate generation near the origin -- not the invariant this check is
  // meant to enforce. landlet_candidates rows keep full circle-fallback
  // treatment regardless: those exist specifically to reserve real future
  // land, polygon or not.
  const existingFootprints = [
    ...existingLandlets.results.filter((row) => landletWorldPolygon(row).length >= 3),
    ...existingCandidates.results,
  ].map(landletFootprint);
  const newFootprints = newRows.map(landletFootprint);
  const conflict = newFootprints.some((footprint) => existingFootprints.some((other) => footprintsOverlap(footprint, other)));
  if (conflict) throw new HttpError(message, 409);
}

// Only for the manual/batch endpoints below, not generate-mosaic/-ring:
// those generators' own output is already structurally self-consistent (by
// construction, adjacent cells only ever share an edge, never overlap), so
// checking their cells against each other here would risk a false-positive
// conflict from the same float-noise-at-a-shared-edge case polygonsOverlap's
// own TOUCH_EPSILON_M exists to absorb -- one degenerate reading of that
// noise for a many-cell batch is more exposure than a manually-submitted
// batch (never guaranteed internally non-overlapping in the first place)
// needs to accept just to get the same protection.
async function assertLandCandidatesDontOverlapEachOther(newRows, message) {
  const newFootprints = newRows.map(landletFootprint);
  const conflict = newFootprints.some((footprint, index) =>
    newFootprints.some((other, otherIndex) => otherIndex !== index && footprintsOverlap(footprint, other)));
  if (conflict) throw new HttpError(message, 409);
}

// #2013 (sub-issue of #2012): whether a point falls near one of the real
// pre-1916 water cells scripts/ingest-geo-data.mjs ingested into
// geo_water_cells (migrations/0128). "Near" means within that cell's own
// sampling spacing — cells that close together are effectively the same
// continuous water region the ingestion script sampled, not an isolated
// point. A full-table scan is fine at this dataset's size (at most a few
// hundred rows for any radius this world will need for a long while); add
// an index later only if that changes.
export async function isNearWaterCell(db, x, y) {
  const row = await db.prepare(`
    SELECT 1 FROM geo_water_cells
    WHERE (x_m - ?) * (x_m - ?) + (y_m - ?) * (y_m - ?) <= spacing_m * spacing_m
    LIMIT 1
  `).bind(x, x, y, y).first();
  return !!row;
}

// #2370 (sub-issue of #2368): the real biome classification at a point,
// from geo_biome_cells (migrations/0149), or null when no sampled cell is
// close enough to have an opinion -- #2369's own biome column is nullable
// for exactly this "genuinely unclassified" case, not defaulted to a
// band. Unlike isNearWaterCell's plain boolean (water only ever needs
// "is there a cell here or not"), biome needs to know *which* band, so
// this returns the nearest matching cell's own value -- ORDER BY the same
// squared-distance expression the WHERE clause already computes, rather
// than a second computed column, since D1/SQLite has no CTE-free way to
// reuse it without repeating the expression.
export async function biomeAt(db, x, y) {
  const row = await db.prepare(`
    SELECT biome FROM geo_biome_cells
    WHERE (x_m - ?) * (x_m - ?) + (y_m - ?) * (y_m - ?) <= spacing_m * spacing_m
    ORDER BY (x_m - ?) * (x_m - ?) + (y_m - ?) * (y_m - ?) ASC
    LIMIT 1
  `).bind(x, x, y, y, x, x, y, y).first();
  return row ? row.biome : null;
}

// #2014 (sub-issue of #2012): the one real consumer of isNearWaterCell.
// Every freshly-generated plot/cell from either generator defaults to
// 'buildable' today (generateOrganicMosaic never sets landType at all;
// generateLandletRing's own plots never request 'water' either, since
// powerLawPlots -- the only real caller feeding it -- doesn't set one).
// This upgrades a candidate to 'water' when its center falls near a real
// ingested water cell, and otherwise leaves it exactly as the generator
// produced it -- including an already-'water' candidate (the admin-only
// manual generate-ring caller can still request one explicitly via
// `plots`; this only ever upgrades toward 'water', never downgrades back
// to 'buildable'). Forward-only by construction: it mutates candidates
// fresh out of a generator, before they ever become a stored
// landlets/landlet_candidates row, and never touches an existing one.
async function applyRealWaterClassification(db, candidates) {
  await Promise.all(candidates.map(async (candidate) => {
    if (candidate.landType === 'water') return;
    if (await isNearWaterCell(db, candidate.center.x, candidate.center.y)) {
      candidate.landType = 'water';
    }
  }));
}

// #2371 (sub-issue of #2368): mirrors applyRealWaterClassification's exact
// shape just above, for biome. Unlike water (an upgrade-only binary toward
// 'water', never downgrading back to 'buildable'), biome has no ordering
// to preserve -- the `if (candidate.biome) return` guard below plays the
// same "don't clobber an already-set value" role water's own `landType
// === 'water'` early-return does, just without a direction attached to
// it. Every plot/cell outside current data coverage is left exactly at
// today's default (undefined, normalized to null by candidateRowFromLandlet),
// matching water's own "no data = default" precedent.
async function applyRealBiomeClassification(db, candidates) {
  await Promise.all(candidates.map(async (candidate) => {
    if (candidate.biome) return;
    const biome = await biomeAt(db, candidate.center.x, candidate.center.y);
    if (biome) candidate.biome = biome;
  }));
}

// Split out from the generate-mosaic handler below so #1085's automatic
// path (generateAutoMosaicIfFreshWorld) can reuse the exact same
// generation/validation/overlap-guard logic without an admin session —
// same split generateLandletRingCandidates already uses for generate-ring,
// including the optional adminUserId (action log entry only written when
// a real admin is the one calling it).
async function generateLandletMosaicCandidates(db, { prefix, count }, adminUserId) {
  const mosaicCells = generateOrganicMosaic({ prefix, count });
  await applyRealWaterClassification(db, mosaicCells);
  await applyRealBiomeClassification(db, mosaicCells);
  const generated = mosaicCells.map((candidate) =>
    validateLandlet({ ...candidate, status: 'generating', ownerBuilderId: null }, candidate.landletId));

  // The mosaic template always covers the world origin as part of its
  // 16-cell disc (organicLandGenerator.js only rotates it, never
  // translates it) — the same point 'starter-landlet' sits on. Rather than
  // inserting a competing candidate there, the cell containing the origin
  // becomes starter-landlet's own shape directly, so there's exactly one
  // polygon at the center instead of two independently-placed ones.
  const centralIndex = generated.findIndex((candidate) => pointInPolygon(
    { x: 0, y: 0 },
    candidate.polygon.map((point) => ({ x: point.x + candidate.center.x, y: point.y + candidate.center.y })),
  ));
  if (centralIndex === -1) throw new HttpError('Generated mosaic does not cover the world origin', 500);
  const central = generated[centralIndex];
  const landlets = generated.filter((_candidate, index) => index !== centralIndex);

  const rows = landlets.map(candidateRowFromLandlet);
  const centralRow = candidateRowFromLandlet(central);
  const duplicate = await db.prepare(`
    SELECT landlet_id FROM landlet_candidates
    WHERE landlet_id >= ? AND landlet_id <= ? LIMIT 1
  `).bind(`${prefix}-001`, `${prefix}-999`).first();
  if (duplicate) throw new HttpError('Land candidate already exists', 409);

  // Safety net beyond the origin cell handled above: two mosaic calls (or
  // a mosaic call landing near existing ring-generated land) would
  // otherwise silently overlap, since this generator has no radial
  // structure for a band-based check like generate-ring's to work with.
  await assertLandCandidatesDontOverlapExisting(db, [...rows, centralRow], 'Generated mosaic would overlap existing land');

  // Every other cell in the mosaic reaches greenbelt/claimable the normal
  // way: materialize as 'generating' (candidateMaterializationStatements,
  // above), then a later generation-complete/world-expand call promotes
  // it once it's enclosed. starter-landlet already exists as a landlet
  // row rather than a fresh candidate, so it skips that pipeline
  // entirely — this mirrors the same "enclosed -> greenbelt, claimable
  // now" transition directly, rather than leaving it stuck at whatever
  // status it already had (historically 'claimed' with no owner, from
  // the seed row in 0001_initial.sql — permanently unclaimable and
  // invisible to the builder-delete release logic, which matches by
  // owner_builder_id). Guarded on owner_builder_id IS NULL so a
  // genuinely-claimed center plot is never clobbered.
  //
  // #1055: the enclosure decision itself is a live SQL subquery against
  // world_settings (not a JS comparison against a pre-batch settings
  // read, which could go stale against a concurrent expandWorldOnce) --
  // same fix shape as the two generation-complete endpoints. The radius
  // being compared still has to come from JS, though: centralRow's
  // polygon/center are being freshly set in this very statement, so
  // there's no already-stored max_world_radius_m column value that
  // reflects it yet.
  const centralMaxWorldRadius = landletMaxWorldRadius(centralRow);
  await db.batch([
    db.prepare(`
      UPDATE landlets
      SET center_x_m = ?, center_y_m = ?, polygon_json = ?, metadata_json = ?,
          generated_at = COALESCE(generated_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          status = CASE WHEN owner_builder_id IS NULL AND ? <= (SELECT radius_m FROM world_settings WHERE world_id = 'default-world') THEN 'greenbelt' ELSE status END,
          claimable_at = CASE
            WHEN owner_builder_id IS NULL AND ? <= (SELECT radius_m FROM world_settings WHERE world_id = 'default-world') THEN COALESCE(claimable_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            ELSE claimable_at
          END,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE landlet_id = 'starter-landlet'
    `).bind(
      central.center.x, central.center.y, centralRow.polygon_json, centralRow.metadata_json,
      centralMaxWorldRadius, centralMaxWorldRadius,
    ),
    ...rows.map((row) => candidateInsertStatement(db, row)),
    ...candidateMaterializationSweepStatements(db, rows.map((row) => row.landlet_id)),
    ...(adminUserId ? [adminActionLogStatement(db, adminUserId, 'generate_mosaic', 'landlet_candidate_prefix', prefix, { count: rows.length + 1 })] : []),
  ]);
  const stored = await db.prepare(`
    SELECT * FROM landlet_candidates WHERE landlet_id >= ? AND landlet_id <= ? ORDER BY landlet_id
  `).bind(`${prefix}-001`, `${prefix}-999`).all();
  const materializedLandletIds = stored.results
    .filter((row) => row.materialized_at)
    .map((row) => row.landlet_id);
  return {
    candidates: stored.results.map(candidateFromRow),
    materializedLandletIds,
    starterLandletId: 'starter-landlet',
  };
}

// Generous-but-bounded bursts, matching the house convention elsewhere in
// this codebase (e.g. purchases-admin.js's SELF_DEALING_FLAG_REVIEW_RATE_
// LIMIT_MAX) for repeatable admin-authenticated mutating actions: these are
// real operational tools used in bursts (growing the world by generating
// several rings/mosaics/batches in a row), not single-shot actions, so the
// limit bounds runaway/scripted abuse (a compromised credential, a buggy
// admin-tooling script, a double-click bug) without interfering with normal
// admin workflows. #2657.
const LAND_CANDIDATE_GENERATE_MOSAIC_RATE_LIMIT_MAX = 20;
const LAND_CANDIDATE_GENERATE_RING_RATE_LIMIT_MAX = 20;
const LAND_CANDIDATE_DELETE_RATE_LIMIT_MAX = 20;
const LAND_CANDIDATE_UPDATE_RATE_LIMIT_MAX = 20;
const LAND_CANDIDATE_BATCH_CREATE_RATE_LIMIT_MAX = 20;
// Higher than this file's other admin buckets: the manual single-candidate
// creation endpoint is also the one worker/worker-api.test.js's own
// land-candidate test suite (one shared admin session for the whole file,
// per that file's own top-of-file comment) exercises most heavily on its
// own, well past the 20 the other buckets here use.
const LAND_CANDIDATE_CREATE_RATE_LIMIT_MAX = 30;

async function handleLandCandidates(request, db, route, url) {
  if (request.method === 'POST' && route.length === 2 && route[1] === 'generate-mosaic') {
    const admin = await requireAdmin(request, db);
    await checkRateLimit(db, `land-candidates-generate-mosaic:${admin.user_id}`, LAND_CANDIDATE_GENERATE_MOSAIC_RATE_LIMIT_MAX);
    const input = await readJson(request);
    const prefix = stringValue(input.prefix, 'prefix');
    if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(prefix)) {
      throw new HttpError('prefix must contain only lowercase letters, numbers, and hyphens', 400);
    }
    const count = positiveInteger(input.count, 'count');
    if (count !== 16) throw new HttpError('count must be 16', 400);
    const result = await generateLandletMosaicCandidates(db, { prefix, count }, admin.user_id);
    return json(result, 201);
  }

  if (request.method === 'POST' && route.length === 2 && route[1] === 'generate-ring') {
    const admin = await requireAdmin(request, db);
    await checkRateLimit(db, `land-candidates-generate-ring:${admin.user_id}`, LAND_CANDIDATE_GENERATE_RING_RATE_LIMIT_MAX);
    const input = await readJson(request);
    const prefix = stringValue(input.prefix, 'prefix');
    if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(prefix)) {
      throw new HttpError('prefix must contain only lowercase letters, numbers, and hyphens', 400);
    }
    const count = positiveInteger(input.count, 'count');
    if (count < 3 || count > 100) throw new HttpError('count must be between 3 and 100', 400);
    const settings = await getWorldSettings(db);
    let innerRadiusM = input.innerRadiusM === undefined
      ? settings.radius_m
      : finiteNumber(input.innerRadiusM, 'innerRadiusM');
    let startAngleRad = input.startAngleRad === undefined ? 0 : finiteNumber(input.startAngleRad, 'startAngleRad');
    if (input.distribution !== undefined && input.distribution !== 'power-law') {
      throw new HttpError('distribution must be power-law', 400);
    }
    let distribution = input.distribution || null;
    let plots;
    let adjacentToRingId = null;
    if (input.adjacentToRingId !== undefined) {
      if (input.innerRadiusM !== undefined || input.startAngleRad !== undefined) {
        throw new HttpError('innerRadiusM and startAngleRad are derived when adjacentToRingId is used', 400);
      }
      adjacentToRingId = stringValue(input.adjacentToRingId, 'adjacentToRingId');
      const adjacentRing = await db.prepare('SELECT * FROM landlet_candidate_rings WHERE ring_id = ?')
        .bind(adjacentToRingId).first();
      if (!adjacentRing) throw new HttpError('Adjacent land candidate ring not found', 404);
      if (count !== adjacentRing.candidate_count) {
        throw new HttpError('count must match the adjacent ring candidate count', 400);
      }
      if (input.distribution !== undefined && input.distribution !== adjacentRing.distribution) {
        throw new HttpError('distribution must match the adjacent ring', 400);
      }
      const adjacentCandidates = await db.prepare(`
        SELECT * FROM landlet_candidates WHERE ring_id = ? ORDER BY landlet_id
      `).bind(adjacentToRingId).all();
      if (adjacentCandidates.results.length !== count) {
        throw new HttpError('Adjacent ring candidate membership is incomplete', 409);
      }
      innerRadiusM = adjacentRing.outer_radius_m;
      startAngleRad = adjacentRing.start_angle_rad;
      distribution = adjacentRing.distribution;
      plots = adjacentCandidates.results.map((row) => ({
        areaM2: row.area_m2,
        landClass: row.landlet_class,
        landType: row.landlet_type,
        metadata: distribution ? { sizeDistribution: 'power-law-v1' } : {},
      }));
    } else if (distribution === 'power-law') {
      plots = powerLawPlots(count, prefix);
    }
    const result = await generateLandletRingCandidates(db, {
      prefix, count, innerRadiusM, startAngleRad, distribution, plots, adjacentToRingId,
    }, admin.user_id);
    return json(result, 201);
  }

  if (request.method === 'GET' && route.length === 1) {
    await requireAdmin(request, db);
    const state = url.searchParams.get('state');
    if (state !== null && state !== 'pending' && state !== 'materialized') {
      throw new HttpError('state must be pending or materialized', 400);
    }
    const limit = queryLimit(url.searchParams.get('limit'), 100);
    const cursor = decodeCursor(url.searchParams.get('cursor'));
    const conditions = [];
    const bindings = [];
    const ringIdParam = url.searchParams.get('ringId');
    if (ringIdParam !== null) {
      conditions.push('ring_id = ?');
      bindings.push(stringValue(ringIdParam, 'ringId'));
    }
    if (state) conditions.push(`materialized_at IS ${state === 'pending' ? '' : 'NOT '}NULL`);
    if (cursor) {
      conditions.push('(created_at > ? OR (created_at = ? AND landlet_id > ?))');
      bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { results } = await db.prepare(`
      SELECT * FROM landlet_candidates ${where}
      ORDER BY created_at, landlet_id LIMIT ?
    `).bind(...bindings, limit + 1).all();
    const hasMore = results.length > limit;
    const page = results.slice(0, limit);
    const last = page.at(-1);
    return json({
      candidates: page.map(candidateFromRow),
      nextCursor: hasMore ? encodeCursor(last.created_at, last.landlet_id) : null,
    });
  }

  if (request.method === 'GET' && route.length === 2) {
    await requireAdmin(request, db);
    const row = await db.prepare('SELECT * FROM landlet_candidates WHERE landlet_id = ?').bind(route[1]).first();
    return row ? json({ candidate: candidateFromRow(row) }) : json({ error: 'Land candidate not found' }, 404);
  }

  if (request.method === 'DELETE' && route.length === 2) {
    const admin = await requireAdmin(request, db);
    await checkRateLimit(db, `land-candidates-delete:${admin.user_id}`, LAND_CANDIDATE_DELETE_RATE_LIMIT_MAX);
    const existing = await db.prepare(`
      SELECT materialized_at, ring_id FROM landlet_candidates WHERE landlet_id = ?
    `).bind(route[1]).first();
    if (!existing) throw new HttpError('Land candidate not found', 404);
    if (existing.ring_id) throw new HttpError('Generated ring candidates cannot be deleted individually', 409);
    if (existing.materialized_at) throw new HttpError('Materialized land candidates cannot be deleted', 409);
    const result = await db.prepare('DELETE FROM landlet_candidates WHERE landlet_id = ? AND materialized_at IS NULL')
      .bind(route[1]).run();
    if (result.meta.changes === 0) throw new HttpError('Land candidate started generation during deletion', 409);
    // Logged only after the delete is confirmed to have actually happened
    // (not batched with it) — this statement's own race guard above means
    // the delete can still lose a race and throw, and a log row for an
    // action that didn't happen would misattribute it to this admin.
    await adminActionLogStatement(db, admin.user_id, 'delete_land_candidate', 'landlet_candidate', route[1]).run();
    return json({ deleted: true });
  }

  if ((request.method === 'PUT' || request.method === 'PATCH') && route.length === 2) {
    const admin = await requireAdmin(request, db);
    await checkRateLimit(db, `land-candidates-update:${admin.user_id}`, LAND_CANDIDATE_UPDATE_RATE_LIMIT_MAX);
    const existing = await db.prepare(`
      SELECT * FROM landlet_candidates WHERE landlet_id = ?
    `).bind(route[1]).first();
    if (!existing) throw new HttpError('Land candidate not found', 404);
    if (existing.materialized_at) throw new HttpError('Materialized land candidates cannot be updated', 409);
    if (existing.ring_id) throw new HttpError('Generated ring candidates cannot be updated individually', 409);

    const input = await readJson(request);
    const candidate = candidateFromRow(existing);
    const landlet = validateLandlet({
      ...candidate,
      ...input,
      landletId: route[1],
      status: 'generating',
      ownerBuilderId: null,
    }, route[1]);
    const row = candidateRowFromLandlet(landlet);
    row.ring_id = existing.ring_id;
    const update = db.prepare(`
      UPDATE landlet_candidates
      SET name = ?, area_m2 = ?, center_x_m = ?, center_y_m = ?, landlet_class = ?, landlet_type = ?, biome = ?,
          polygon_json = ?, metadata_json = ?, min_world_radius_m = ?, max_world_radius_m = ?
      WHERE landlet_id = ? AND materialized_at IS NULL
    `).bind(
      landlet.name, landlet.areaM2, landlet.center.x, landlet.center.y, landlet.landClass, landlet.landType,
      landlet.biome ?? null, JSON.stringify(landlet.polygon), JSON.stringify(landlet.metadata),
      landletMinWorldRadius(row), landletMaxWorldRadius(row), route[1],
    );
    const results = await db.batch([
      update,
      ...candidateMaterializationSweepStatements(db, [route[1]]),
    ]);
    if (results[0].meta.changes === 0) throw new HttpError('Land candidate started generation during update', 409);
    await adminActionLogStatement(db, admin.user_id, 'update_land_candidate', 'landlet_candidate', route[1]).run();
    const updated = await db.prepare(`
      SELECT * FROM landlet_candidates WHERE landlet_id = ?
    `).bind(route[1]).first();
    // #2391: the UPDATE above is guarded, but this re-SELECT isn't -- a
    // concurrent DELETE (allowed here since materialized_at/ring_id were
    // both still NULL a moment ago) can remove the row in the await gap
    // between the update batch and this read.
    if (!updated) throw new HttpError('Land candidate not found', 409);
    const materialized = updated.materialized_at ? await requireLandlet(db, route[1]) : null;
    return json({
      candidate: candidateFromRow(updated),
      landlet: materialized ? landletFromRow(materialized) : null,
    });
  }

  if (request.method === 'POST' && route.length === 2 && route[1] === 'batch') {
    const admin = await requireAdmin(request, db);
    await checkRateLimit(db, `land-candidates-batch-create:${admin.user_id}`, LAND_CANDIDATE_BATCH_CREATE_RATE_LIMIT_MAX);
    const input = await readJson(request);
    if (!Array.isArray(input.candidates)) throw new HttpError('candidates must be an array', 400);
    if (input.candidates.length === 0) throw new HttpError('candidates must contain at least one item', 400);
    if (input.candidates.length > 100) throw new HttpError('candidates must contain at most 100 items', 400);

    const landlets = input.candidates.map((candidate) =>
      validateLandlet({ ...candidate, status: 'generating', ownerBuilderId: null }, crypto.randomUUID()));
    const ids = new Set();
    for (const landlet of landlets) {
      if (ids.has(landlet.landletId)) throw new HttpError('landletId values must be unique', 400);
      ids.add(landlet.landletId);
    }

    const rows = landlets.map(candidateRowFromLandlet);
    await assertLandCandidatesDontOverlapExisting(db, rows, 'One or more candidates would overlap existing land');
    await assertLandCandidatesDontOverlapEachOther(rows, 'One or more candidates would overlap each other');
    await db.batch([
      ...rows.map((row) => candidateInsertStatement(db, row)),
      ...candidateMaterializationSweepStatements(db, rows.map((row) => row.landlet_id)),
      adminActionLogStatement(db, admin.user_id, 'create_land_candidates_batch', 'landlet_candidate_batch', null, { landletIds: [...ids] }),
    ]);
    const placeholders = landlets.map(() => '?').join(', ');
    const storedCandidates = await db.prepare(`
      SELECT * FROM landlet_candidates WHERE landlet_id IN (${placeholders}) ORDER BY created_at
    `).bind(...ids).all();
    const materializedLandlets = await db.prepare(`
      SELECT * FROM landlets WHERE landlet_id IN (${placeholders}) ORDER BY created_at
    `).bind(...ids).all();
    return json({
      candidates: storedCandidates.results.map(candidateFromRow),
      landlets: materializedLandlets.results.map(landletFromRow),
    }, 201);
  }

  if (request.method === 'POST' && route.length === 1) {
    const admin = await requireAdmin(request, db);
    await checkRateLimit(db, `land-candidates-create:${admin.user_id}`, LAND_CANDIDATE_CREATE_RATE_LIMIT_MAX);
    const input = await readJson(request);
    const landlet = validateLandlet({ ...input, status: 'generating', ownerBuilderId: null }, crypto.randomUUID());
    const row = candidateRowFromLandlet(landlet);
    await assertLandCandidatesDontOverlapExisting(db, [row], 'Candidate would overlap existing land');
    await db.batch([
      candidateInsertStatement(db, row),
      ...candidateMaterializationSweepStatements(db, [row.landlet_id]),
      adminActionLogStatement(db, admin.user_id, 'create_land_candidate', 'landlet_candidate', landlet.landletId),
    ]);

    const candidate = await db.prepare('SELECT * FROM landlet_candidates WHERE landlet_id = ?').bind(landlet.landletId).first();
    const materialized = candidate.materialized_at ? await requireLandlet(db, landlet.landletId) : null;
    return json({ candidate: candidateFromRow(candidate), landlet: materialized ? landletFromRow(materialized) : null }, 201);
  }

  return json({ error: 'Not found' }, 404);
}

// #2657: same generous-but-bounded-burst convention as the land-candidate
// rate limits above.
const LAND_CANDIDATE_RING_GENERATION_COMPLETE_RATE_LIMIT_MAX = 20;

async function handleLandCandidateRings(request, db, route, url) {
  if (request.method === 'GET' && route.length === 1) {
    await requireAdmin(request, db);
    const limit = queryLimit(url.searchParams.get('limit'), 100);
    const cursor = decodeCursor(url.searchParams.get('cursor'));
    const conditions = [];
    const bindings = [];
    const adjacentToRingIdParam = url.searchParams.get('adjacentToRingId');
    if (adjacentToRingIdParam !== null) {
      conditions.push('adjacent_to_ring_id = ?');
      bindings.push(stringValue(adjacentToRingIdParam, 'adjacentToRingId'));
    }
    if (cursor) {
      conditions.push('(created_at > ? OR (created_at = ? AND ring_id > ?))');
      bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { results } = await db.prepare(`
      SELECT * FROM landlet_candidate_rings ${where}
      ORDER BY created_at, ring_id LIMIT ?
    `).bind(...bindings, limit + 1).all();
    const hasMore = results.length > limit;
    const page = results.slice(0, limit);
    const last = page.at(-1);
    return json({
      rings: page.map(landCandidateRingFromRow),
      nextCursor: hasMore ? encodeCursor(last.created_at, last.ring_id) : null,
    });
  }

  if (request.method === 'GET' && route.length === 2) {
    await requireAdmin(request, db);
    const row = await getLandCandidateRingWithLifecycle(db, route[1]);
    return row
      ? json({ ring: landCandidateRingFromRow(row) })
      : json({ error: 'Land candidate ring not found' }, 404);
  }

  if (request.method === 'POST' && route.length === 3 && route[2] === 'generation-complete') {
    const admin = await requireAdmin(request, db);
    await checkRateLimit(db, `land-candidate-ring-generation-complete:${admin.user_id}`, LAND_CANDIDATE_RING_GENERATION_COMPLETE_RATE_LIMIT_MAX);
    const { changed, ...result } = await completeRingGenerationInternal(db, route[1]);
    // #829: unlike its landlet-level sibling (see that handler's own
    // adminActionLogStatement call), this endpoint never logged who
    // completed a ring's generation — missed by #817's own sweep.
    // #2037: logging unconditionally missed the same race #1666 already
    // fixed for the landlet-level sibling above — completeRingGeneration-
    // Internal's own UPDATE can legitimately affect 0 rows (every member
    // already enclosed by an earlier call, admin or automatic), and this
    // handler still logged a completion that didn't happen on this call.
    if (changed) {
      await adminActionLogStatement(db, admin.user_id, 'ring_generation_complete', 'landlet_candidate_ring', route[1]).run();
    }
    return json(result);
  }

  return json({ error: 'Not found' }, 404);
}

// Split out of the generation-complete HTTP handler above for the same
// reason generateLandletRingCandidates was — autoGrowWorldIfNeeded (below)
// needs to complete a ring it just generated itself, with no HTTP request
// to gate.
async function completeRingGenerationInternal(db, ringId) {
  const ringRow = await db.prepare(`
    SELECT * FROM landlet_candidate_rings WHERE ring_id = ?
  `).bind(ringId).first();
  if (!ringRow) throw new HttpError('Land candidate ring not found', 404);

  const membership = await db.prepare(`
    SELECT COUNT(*) AS candidate_count,
      SUM(CASE WHEN materialized_at IS NOT NULL THEN 1 ELSE 0 END) AS materialized_count
    FROM landlet_candidates WHERE ring_id = ?
  `).bind(ringId).first();
  if (membership.candidate_count !== ringRow.candidate_count
    || membership.materialized_count !== ringRow.candidate_count) {
    throw new HttpError('All ring candidates must be materialized before generation can complete', 409);
  }

  // #1055: same live-subquery fix as the single-landlet generation-complete
  // endpoint above -- a JS-read settings.radius_m here could go stale
  // against a concurrent expandWorldOnce.
  // #2037: added "AND generated_at IS NULL", matching the landlet-level
  // sibling's own WHERE guard -- without it, a member that's already
  // completed but not yet enclosed (still 'generating', COALESCE-preserved
  // generated_at) keeps matching this UPDATE on every retry, since
  // status = 'generating' alone stays true until enclosure. The SET clause
  // was already a no-op for such a row either way; this only fixes what
  // `changed` below actually measures.
  const result = await db.prepare(`
    UPDATE landlets
    SET generated_at = COALESCE(generated_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        status = CASE WHEN max_world_radius_m <= (SELECT radius_m FROM world_settings WHERE world_id = 'default-world') THEN 'greenbelt' ELSE status END,
        claimable_at = CASE
          WHEN max_world_radius_m <= (SELECT radius_m FROM world_settings WHERE world_id = 'default-world') THEN COALESCE(claimable_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
          ELSE claimable_at
        END,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE landlet_id IN (SELECT landlet_id FROM landlet_candidates WHERE ring_id = ?)
      AND status = 'generating' AND generated_at IS NULL
  `).bind(ringId).run();
  const completed = await db.prepare(`
    SELECT landlets.* FROM landlets
    JOIN landlet_candidates USING (landlet_id)
    WHERE landlet_candidates.ring_id = ? ORDER BY landlets.created_at, landlets.landlet_id
  `).bind(ringId).all();
  const updatedRing = await getLandCandidateRingWithLifecycle(db, ringId);
  return {
    ring: landCandidateRingFromRow(updatedRing),
    landlets: completed.results.map(landletFromRow),
    // #2037: lets the HTTP handler log only when this call itself actually
    // enclosed something, not just that the ring is (now, or already)
    // fully complete -- same "logged only after confirmed" idiom as the
    // landlet-level sibling handler above.
    changed: result.meta.changes > 0,
  };
}

async function getLandCandidateRingWithLifecycle(db, ringId) {
  return db.prepare(`
    SELECT ring.*,
      (SELECT child.ring_id FROM landlet_candidate_rings AS child
       WHERE child.adjacent_to_ring_id = ring.ring_id) AS adjacent_child_ring_id,
      COUNT(candidate.landlet_id) AS stored_candidate_count,
      SUM(CASE WHEN candidate.landlet_id IS NOT NULL AND candidate.materialized_at IS NULL THEN 1 ELSE 0 END) AS pending_candidate_count,
      SUM(CASE WHEN candidate.materialized_at IS NOT NULL THEN 1 ELSE 0 END) AS materialized_candidate_count,
      SUM(CASE WHEN landlet.generated_at IS NOT NULL THEN 1 ELSE 0 END) AS completed_landlet_count,
      SUM(CASE WHEN landlet.status = 'greenbelt' THEN 1 ELSE 0 END) AS greenbelt_landlet_count
    FROM landlet_candidate_rings AS ring
    LEFT JOIN landlet_candidates AS candidate ON candidate.ring_id = ring.ring_id
    LEFT JOIN landlets AS landlet ON landlet.landlet_id = candidate.landlet_id
    WHERE ring.ring_id = ? GROUP BY ring.ring_id
  `).bind(ringId).first();
}

function candidateRowFromLandlet(landlet) {
  return {
    landlet_id: landlet.landletId,
    name: landlet.name,
    area_m2: landlet.areaM2,
    center_x_m: landlet.center.x,
    center_y_m: landlet.center.y,
    landlet_class: landlet.landClass,
    landlet_type: landlet.landType,
    biome: landlet.biome ?? null,
    polygon_json: JSON.stringify(landlet.polygon),
    metadata_json: JSON.stringify(landlet.metadata),
  };
}

function candidateInsertStatement(db, row) {
  return db.prepare(`
    INSERT INTO landlet_candidates
      (landlet_id, name, area_m2, center_x_m, center_y_m, landlet_class, landlet_type, biome, polygon_json,
       metadata_json, min_world_radius_m, max_world_radius_m, ring_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    row.landlet_id, row.name, row.area_m2, row.center_x_m, row.center_y_m, row.landlet_class, row.landlet_type,
    row.biome ?? null, row.polygon_json, row.metadata_json, landletMinWorldRadius(row), landletMaxWorldRadius(row),
    row.ring_id || null,
  );
}

// #849: the call sites below used to decide "does this candidate qualify
// for immediate materialization" in JS, from a `settings.radius_m` read
// taken before ever entering the db.batch() transaction that inserts the
// candidate. If a concurrent expandWorldOnce (an admin action, or the
// 10-minute auto-growth cron) committed a radius increase in the window
// between that read and this batch's own commit, a candidate whose
// min_world_radius_m qualified under the *current* radius but not the
// stale snapshot landed as materialized_at IS NULL with no guaranteed
// catch-up — it would sit un-materialized until some *future* expansion
// happened to re-sweep it (expandWorldOnce's own pending-candidate query
// is unconditional over the whole table, so it does eventually catch up,
// but only on the next expansion, which may be long delayed or may never
// come if growth stops).
//
// This closes that window the same way expandWorldOnce closes its own
// (see its comment above): the materialize-or-not decision is made by SQL
// reading world_settings live, inside the very same db.batch() transaction
// as the candidate insert/update it's paired with, instead of by a JS
// filter computed beforehand. Scoped to the specific landlet_ids the
// caller just wrote (rather than sweeping every pending candidate
// globally) so behavior for those rows is decided exactly once, atomically,
// at the moment they're written — callers determine what actually
// materialized via a post-batch SELECT of just these ids, not from a
// pre-batch JS list.
function candidateMaterializationSweepStatements(db, landletIds) {
  if (landletIds.length === 0) return [];
  const placeholders = landletIds.map(() => '?').join(', ');
  return [
    db.prepare(`
      INSERT INTO landlets
        (landlet_id, name, area_m2, center_x_m, center_y_m, status, owner_builder_id, landlet_class,
         landlet_type, biome, polygon_json, generated_at, claimable_at, metadata_json, max_world_radius_m)
      SELECT landlet_id, name, area_m2, center_x_m, center_y_m, 'generating', NULL, landlet_class,
             landlet_type, biome, polygon_json, NULL, NULL, metadata_json, max_world_radius_m
      FROM landlet_candidates
      WHERE landlet_id IN (${placeholders})
        AND materialized_at IS NULL
        AND min_world_radius_m <= (SELECT radius_m FROM world_settings WHERE world_id = 'default-world')
    `).bind(...landletIds),
    db.prepare(`
      UPDATE landlet_candidates SET materialized_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE landlet_id IN (${placeholders})
        AND materialized_at IS NULL
        AND min_world_radius_m <= (SELECT radius_m FROM world_settings WHERE world_id = 'default-world')
    `).bind(...landletIds),
  ];
}

// The actual generation + persistence half of POST /land-candidates/
// generate-ring, split out so autoGrowWorldIfNeeded (below) can generate a
// ring itself without going through an HTTP request — the caller is
// expected to have already resolved/validated prefix/count/innerRadiusM/
// startAngleRad/distribution/plots/adjacentToRingId (the HTTP handler does
// this for a real request; autoGrowWorldIfNeeded's own caller constructs
// them directly, always with adjacentToRingId null).
// adminUserId is optional and present only when called from the admin HTTP
// handler above — omitted by autoGrowWorldIfNeeded's own call below, so an
// auto-generated ring never gets misattributed to whichever admin happens
// to be logged in (there isn't one; it's the trusted server itself).
async function generateLandletRingCandidates(db, { prefix, count, innerRadiusM, startAngleRad, distribution, plots, adjacentToRingId }, adminUserId) {
  const settings = await getWorldSettings(db);
  if (innerRadiusM < settings.radius_m) {
    throw new HttpError('innerRadiusM cannot be inside the current world radius', 400);
  }
  const generated = generateLandletRing({ prefix, count, innerRadiusM, startAngleRad, plots });
  const radialConflict = await db.prepare(`
    SELECT landlet_id FROM landlet_candidates
    WHERE min_world_radius_m < ? - 0.0000001
      AND (max_world_radius_m IS NULL OR max_world_radius_m > ? + 0.0000001)
    LIMIT 1
  `).bind(generated.outerRadiusM, innerRadiusM).first();
  if (radialConflict) {
    throw new HttpError('Generated ring would overlap existing land candidates', 409);
  }
  await applyRealWaterClassification(db, generated.landlets);
  await applyRealBiomeClassification(db, generated.landlets);
  const landlets = generated.landlets.map((candidate) =>
    validateLandlet({ ...candidate, status: 'generating', ownerBuilderId: null }, candidate.landletId));
  const rows = landlets.map((landlet) => ({ ...candidateRowFromLandlet(landlet), ring_id: prefix }));
  await db.batch([
    db.prepare(`
      INSERT INTO landlet_candidate_rings
        (ring_id, inner_radius_m, outer_radius_m, candidate_count, distribution, start_angle_rad,
         boundary_signature, adjacent_to_ring_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      prefix, innerRadiusM, generated.outerRadiusM, count, distribution, startAngleRad,
      generated.boundarySignature, adjacentToRingId,
    ),
    ...rows.map((row) => candidateInsertStatement(db, row)),
    ...candidateMaterializationSweepStatements(db, rows.map((row) => row.landlet_id)),
    ...(adminUserId ? [adminActionLogStatement(db, adminUserId, 'generate_ring', 'landlet_candidate_ring', prefix, { count })] : []),
  ]);
  const storedCandidates = await db.prepare(`
    SELECT * FROM landlet_candidates WHERE ring_id = ? ORDER BY created_at, landlet_id
  `).bind(prefix).all();
  const materializedLandletIds = storedCandidates.results
    .filter((row) => row.materialized_at)
    .map((row) => row.landlet_id);
  return {
    candidates: storedCandidates.results.map(candidateFromRow),
    materializedLandletIds,
    readyForGenerationCompletion: materializedLandletIds.length === rows.length,
    innerRadiusM,
    outerRadiusM: generated.outerRadiusM,
  };
}

const WORLD_SETTINGS_CONCURRENT_RETRY_LIMIT = 5;

// #2657: same generous-but-bounded-burst convention as the land-candidate
// rate limits above.
const WORLD_EXPAND_RATE_LIMIT_MAX = 20;
const WORLD_SETTINGS_UPDATE_RATE_LIMIT_MAX = 20;

async function handleWorld(request, db, route) {
  if (request.method === 'GET' && route.length === 1) {
    const settings = await getWorldSettings(db);
    const counts = await getLandletCounts(db);
    return json({ world: worldFromRow(settings, counts) });
  }

  if (request.method === 'POST' && route.length === 2 && route[1] === 'expand') {
    const admin = await requireAdmin(request, db);
    await checkRateLimit(db, `world-expand:${admin.user_id}`, WORLD_EXPAND_RATE_LIMIT_MAX);
    const settings = await getWorldSettings(db);
    const countsBefore = await getLandletCounts(db);
    const greenbeltRatio = computeGreenbeltRatio(countsBefore);
    if (greenbeltRatio >= settings.greenbelt_min_ratio) {
      throw new HttpError('Greenbelt reserve is at or above the expansion threshold', 409);
    }
    const result = await expandWorldOnce(db, admin.user_id);
    return json(result);
  }

  if ((request.method === 'PUT' || request.method === 'PATCH') && route.length === 1) {
    const admin = await requireAdmin(request, db);
    await checkRateLimit(db, `world-settings-update:${admin.user_id}`, WORLD_SETTINGS_UPDATE_RATE_LIMIT_MAX);
    const input = await readJson(request);
    // #881: same TOCTOU shape #837 fixed in expandWorldOnce — the UPDATE
    // below used to have no WHERE guard tying it back to the `existing` row
    // this handler actually read, so two concurrent PUT/PATCH calls (or one
    // racing an expandWorldOnce radius bump) could each overwrite whatever
    // the other just wrote, silently discarding an update while
    // admin_action_log recorded both as if each succeeded cleanly. Claim the
    // write via a conditional UPDATE first, same idiom expandWorldOnce uses.
    let existing;
    let world;
    for (let attempt = 0; ; attempt++) {
      existing = await getWorldSettings(db);
      world = validateWorld({ ...worldFromRow(existing), ...input });
      // #523: nothing here re-validates already-materialized/greenbelt land
      // against a smaller radius, and expandWorldOnce (the only other writer
      // of radius_m) only ever grows it — so a shrink here was the one path
      // that could leave existing landlets sitting outside the world's own
      // stated bounds. Owner direction (reply yyjnvw3ueii8zn0k5cs3): block
      // shrinking outright; if the radius is ever wrong by accident, that's
      // a one-time manual/engineered fix, not something this endpoint should
      // allow as routine input.
      if (world.radiusM < existing.radius_m) {
        throw new HttpError('World radius cannot be decreased', 400);
      }
      const claimed = await db.prepare(`
        UPDATE world_settings
        SET radius_m = ?, expansion_increment_m = ?, greenbelt_min_ratio = ?, coordinate_rotation_deg = ?,
            day_cycle_hours = ?, metadata_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE world_id = 'default-world' AND radius_m = ? AND expansion_increment_m = ?
          AND greenbelt_min_ratio = ? AND coordinate_rotation_deg = ? AND day_cycle_hours = ?
          AND metadata_json = ?
      `).bind(
        world.radiusM, world.expansionIncrementM, world.greenbeltMinRatio, world.coordinateRotationDeg, world.dayCycleHours, JSON.stringify(world.metadata),
        existing.radius_m, existing.expansion_increment_m, existing.greenbelt_min_ratio, existing.coordinate_rotation_deg, existing.day_cycle_hours, existing.metadata_json,
      ).run();
      if (claimed.meta.changes > 0) break;
      if (attempt >= WORLD_SETTINGS_CONCURRENT_RETRY_LIMIT) {
        throw new HttpError('World settings are being updated concurrently — please retry', 409);
      }
    }
    await adminActionLogStatement(db, admin.user_id, 'update_world_settings', 'world', 'default-world').run();
    const updated = await getWorldSettings(db);
    // #976: pass counts through like GET does above -- worldFromRow leaves
    // landletCounts undefined when called with one argument, unlike GET's
    // always-populated response for the identical resource.
    const updatedCounts = await getLandletCounts(db);
    return json({ world: worldFromRow(updated, updatedCounts) });
  }

  return json({ error: 'Not found' }, 404);
}

async function getWorldSettings(db) {
  const row = await db.prepare("SELECT * FROM world_settings WHERE world_id = 'default-world'").first();
  if (!row) throw new HttpError('World settings are not initialized', 500);
  return row;
}

async function getLandletCounts(db) {
  return db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'greenbelt' AND landlet_type != 'water' THEN 1 ELSE 0 END) AS greenbelt,
      SUM(CASE WHEN status = 'claimed' THEN 1 ELSE 0 END) AS claimed,
      SUM(CASE WHEN status = 'generating' THEN 1 ELSE 0 END) AS generating,
      SUM(CASE WHEN landlet_type = 'water' THEN 1 ELSE 0 END) AS water
    FROM landlets
  `).first();
}

// #755: a water landlet can never become greenbelt or be claimed (see the
// CASE exclusion above, and POST .../claim's own landlet_type != 'water'
// check), so it needs to come out of this ratio's denominator too, not
// just stay out of its numerator -- otherwise every water tile the map
// ever grows to enclose permanently drags the ratio down without ever
// being able to satisfy it, since it can never count toward greenbelt.
// Shared by worldNeedsGrowth, POST /world/expand's gate, and worldFromRow's
// reported greenbeltRatio so all three keep meaning the same thing:
// "greenbelt as a fraction of claimable land."
function computeGreenbeltRatio(counts) {
  const claimable = (counts?.total || 0) - (counts?.water || 0);
  return claimable === 0 ? 0 : (counts?.greenbelt || 0) / claimable;
}

// The actual radius-bump + promotion half of POST /world/expand, split out
// so autoGrowWorldIfNeeded (below) can expand the world itself without
// going through an HTTP request or its ratio-gate 409 — the caller decides
// whether expanding is warranted (the HTTP handler checks once up front;
// the auto-grow loop below checks on every iteration). adminUserId is
// optional and present only when called from the admin HTTP handler —
// autoGrowWorldIfNeeded's own calls below omit it, so an automatic
// expansion never gets logged as if some admin triggered it.
// #837: previousRadiusM/newRadiusM used to be computed from a plain read
// here, with the actual radius_m write further down a bare SET with no
// guard tying it back to that read — two genuinely concurrent calls (an
// admin double-click, a retried request, or an HTTP call racing an
// internal auto-growth one) could both read the same previousRadiusM and
// both write the same newRadiusM, silently dropping one whole increment
// of growth while logging two separate admin_action_log entries both
// claiming the same transition. Claiming the radius bump via a
// WHERE-guarded conditional UPDATE first (same idiom this file already
// uses for auctions — see resolveAuction/handleStartAuction) closes that
// race: only the caller whose read is still current gets to proceed, and
// a loser retries against fresh state rather than corrupting the log or
// the enclosed/materialized landlet sets it computes from a stale radius.
const EXPAND_WORLD_CONCURRENT_RETRY_LIMIT = 5;

async function expandWorldOnce(db, adminUserId) {
  let previousRadiusM;
  let newRadiusM;
  let settings;
  for (let attempt = 0; ; attempt++) {
    settings = await getWorldSettings(db);
    previousRadiusM = settings.radius_m;
    newRadiusM = previousRadiusM + settings.expansion_increment_m;
    const claimed = await db.prepare(`
      UPDATE world_settings
      SET radius_m = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE world_id = 'default-world' AND radius_m = ?
    `).bind(newRadiusM, previousRadiusM).run();
    if (claimed.meta.changes > 0) break;
    if (attempt >= EXPAND_WORLD_CONCURRENT_RETRY_LIMIT) {
      throw new HttpError('World expansion is being updated concurrently — please retry', 409);
    }
  }
  const { results } = await db.prepare(`
    SELECT * FROM landlets
    WHERE status = 'generating' AND generated_at IS NOT NULL
      AND (max_world_radius_m IS NULL OR max_world_radius_m <= ?)
  `).bind(newRadiusM).all();
  const enclosed = results.filter((row) => landletMaxWorldRadius(row) <= newRadiusM);
  const pending = await db.prepare(`
    SELECT * FROM landlet_candidates
    WHERE materialized_at IS NULL AND min_world_radius_m <= ?
  `).bind(newRadiusM).all();
  const overlapping = pending.results.filter((row) => landletMinWorldRadius(row) <= newRadiusM);
  const followUpStatements = [
    ...enclosed.map((row) => db.prepare(`
      UPDATE landlets
      SET status = 'greenbelt', claimable_at = COALESCE(claimable_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE landlet_id = ? AND status = 'generating'
    `).bind(row.landlet_id)),
    ...candidateMaterializationStatements(db, overlapping),
    ...(adminUserId
      ? [adminActionLogStatement(db, adminUserId, 'expand_world', 'world', 'default-world', { previousRadiusM, newRadiusM })]
      : []),
  ];
  if (followUpStatements.length > 0) await db.batch(followUpStatements);
  const touchedRingIds = [...new Set(overlapping.map((row) => row.ring_id).filter(Boolean))];
  let readyRingIds = [];
  if (touchedRingIds.length > 0) {
    const placeholders = touchedRingIds.map(() => '?').join(', ');
    const ready = await db.prepare(`
      SELECT candidate.ring_id FROM landlet_candidates AS candidate
      JOIN landlet_candidate_rings AS ring ON ring.ring_id = candidate.ring_id
      WHERE candidate.ring_id IN (${placeholders})
      GROUP BY candidate.ring_id, ring.candidate_count
      HAVING COUNT(*) = ring.candidate_count
        AND SUM(CASE WHEN candidate.materialized_at IS NOT NULL THEN 1 ELSE 0 END) = ring.candidate_count
      ORDER BY candidate.ring_id
    `).bind(...touchedRingIds).all();
    readyRingIds = ready.results.map((row) => row.ring_id);
  }

  const updated = await getWorldSettings(db);
  const countsAfter = await getLandletCounts(db);
  return {
    world: worldFromRow(updated, countsAfter),
    expansion: {
      previousRadiusM,
      newRadiusM,
      incrementM: settings.expansion_increment_m,
      promotedLandletIds: enclosed.map((row) => row.landlet_id),
      startedGeneratingLandletIds: overlapping.map((row) => row.landlet_id),
      readyRingIds,
    },
  };
}

// Automatic world growth — see the default export's scheduled() near the
// top of this file and wrangler.jsonc's triggers.crons. Before this
// existed, "grow the world" was a player-triggered action (the claim
// modal's own "Grow the world" button, now retired — see git history):
// any logged-in builder's browser would expand the world and/or generate a
// fresh ring whenever nothing was claimable. That was always a dev-mode
// stand-in ("a real deployment would want this driven by an actual
// world-building process rather than a builder's own browser session," per
// that button's own removed comment) — this *is* that real process,
// running on a schedule instead of a click, checking exactly the same
// condition `POST /world/expand` already gates on: the greenbelt ratio
// dropping below `world_settings.greenbelt_min_ratio`. The manual
// /world/expand, /land-candidates/generate-ring, /generate-mosaic, and
// generation-complete endpoints all still exist, admin-gated, for
// troubleshooting — this function is a second caller of the same
// generation/expansion primitives (expandWorldOnce, generateLandletRing-
// Candidates, completeRingGenerationInternal), not a replacement for them.
const WORLD_GROWTH_MAX_STEPS = 20;
// Matches the old player-triggered generateRingAtBoundary's own ring size
// — no reason for the automatic version to generate a differently-shaped
// world than the one already tuned by hand.
const AUTO_RING_CANDIDATE_COUNT = 12;

async function worldNeedsGrowth(db) {
  const settings = await getWorldSettings(db);
  const counts = await getLandletCounts(db);
  return computeGreenbeltRatio(counts) < settings.greenbelt_min_ratio;
}

async function autoGrowWorldIfNeeded(db) {
  if (!(await worldNeedsGrowth(db))) return { grew: false };

  // Phase 1: expand to enclose anything already generating and due — the
  // cheapest way to surface more greenbelt, since it needs no new content,
  // mirroring the old expandToEncloseGenerating.
  for (let i = 0; i < WORLD_GROWTH_MAX_STEPS; i++) {
    if (!(await worldNeedsGrowth(db))) break;
    // Matches expandWorldOnce's own enclosure criteria exactly — a
    // 'generating' landlet with no generated_at yet isn't eligible to be
    // enclosed no matter how far the radius grows, so it shouldn't keep
    // this loop spinning either.
    const enclosable = await db.prepare(
      `SELECT 1 FROM landlets WHERE status = 'generating' AND generated_at IS NOT NULL LIMIT 1`,
    ).first();
    if (!enclosable) break;
    await expandWorldOnce(db);
  }

  // Phase 2: Phase 1's loop above already broke out once nothing enclosable
  // was left, so if the ratio is still below threshold here, more land
  // actually needs generating — mirroring the old generateRingAtBoundary.
  // #942: this used to re-check for literally zero greenbelt landlets
  // instead of trusting worldNeedsGrowth's own ratio-based verdict, so this
  // phase silently never fired once at least one greenbelt landlet existed
  // anywhere -- true almost all the time, since the threshold is a
  // percentage, not "run out completely". That defeated the entire feature
  // in its realistic steady state.
  //
  // #1085: owner's decision, 2026-10-01 -- prefer the organic mosaic
  // generator over the legacy ring generator first, falling back to the
  // ring generator only once mosaic is unavailable (it's a deliberately
  // one-time operation; see generateAutoMosaicIfFreshWorld's own comment).
  if (await worldNeedsGrowth(db)) {
    const mosaicGenerated = await generateAutoMosaicIfFreshWorld(db);
    if (!mosaicGenerated) {
      await generateRingAtWorldBoundary(db);
    }
  }

  return { grew: true };
}

// #1085: generate-mosaic's own disc always covers the same origin-centered
// area (organicLandGenerator.js only rotates the template, never
// translates it), so it is inherently a one-time operation across the
// world's whole lifetime -- once it has succeeded once (here, or via a
// prior manual admin call with any prefix), every later attempt hits its
// own duplicate/overlap guards and throws. That makes "is the world still
// fresh enough for mosaic" self-limiting to detect: just attempt it and
// let those guards decide, rather than adding new world_settings state to
// track "has an organic seed been attempted here" independently. A rare,
// genuinely-unexpected failure (not one of this function's own guards)
// still propagates, instead of silently masking a real bug as "mosaic
// unavailable, fall back to ring."
async function generateAutoMosaicIfFreshWorld(db) {
  try {
    await generateLandletMosaicCandidates(db, { prefix: 'auto-mosaic', count: 16 });
    return true;
  } catch (err) {
    if (err instanceof HttpError) return false;
    throw err;
  }
}

async function generateRingAtWorldBoundary(db) {
  let settings = await getWorldSettings(db);
  let innerRadiusM = settings.radius_m;
  let ring = null;
  for (let attempt = 0; attempt < WORLD_GROWTH_MAX_STEPS && !ring; attempt++) {
    // Radius-derived, not random/sequential — naturally unique per call
    // (radius only ever grows) the same way the old frontend flow's own
    // `dev-ring-${Math.round(innerRadiusM)}` prefix was.
    const prefix = `auto-ring-${Math.round(innerRadiusM)}`;

    // #1314: a previous, interrupted run (e.g. the Worker was recycled
    // mid-cycle) may have already committed this exact reservation --
    // generateLandletRingCandidates' own db.batch is atomic, so the ring
    // row and its candidates are either both there or neither is, but the
    // completion/enclosure steps below never got to run. Checked *before*
    // attempting generation, not caught as an error afterward: a fresh
    // attempt at this same radius would generate candidates with the exact
    // same footprint as the ones already stored, so generateLandletRingCandidates'
    // own radial-overlap precheck would always report a conflict against
    // itself first (an HttpError, not the raw D1 UNIQUE-constraint error
    // the old reactive check here used to key off) -- silently bumping past
    // its own prior reservation and abandoning it in 'generating' limbo
    // forever, rather than ever finishing it.
    const existing = await db.prepare(
      'SELECT outer_radius_m FROM landlet_candidate_rings WHERE ring_id = ?',
    ).bind(prefix).first();
    if (existing) {
      ring = { ringId: prefix, outerRadiusM: existing.outer_radius_m };
      break;
    }

    try {
      const result = await generateLandletRingCandidates(db, {
        prefix, count: AUTO_RING_CANDIDATE_COUNT, innerRadiusM, startAngleRad: 0, distribution: null,
        adjacentToRingId: null,
      });
      ring = { ringId: prefix, outerRadiusM: result.outerRadiusM };
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      if (err.message === 'Generated ring would overlap existing land candidates') {
        innerRadiusM += settings.expansion_increment_m;
      } else {
        throw err;
      }
    }
  }
  if (!ring) return; // no clear room found this pass — the next scheduled run tries again

  try {
    await completeRingGenerationInternal(db, ring.ringId);
  } catch {
    // Not every member has materialized yet — expand toward its outer
    // edge and retry once, same fallback the old frontend flow used.
    for (let i = 0; i < WORLD_GROWTH_MAX_STEPS; i++) {
      settings = await getWorldSettings(db);
      if (settings.radius_m >= ring.outerRadiusM) break;
      await expandWorldOnce(db);
    }
    await completeRingGenerationInternal(db, ring.ringId);
  }

  for (let i = 0; i < WORLD_GROWTH_MAX_STEPS; i++) {
    settings = await getWorldSettings(db);
    if (settings.radius_m >= ring.outerRadiusM) break;
    await expandWorldOnce(db);
  }
}

function candidateMaterializationStatements(db, candidates) {
  return candidates.flatMap((row) => [
    db.prepare(`
      INSERT INTO landlets
        (landlet_id, name, area_m2, center_x_m, center_y_m, status, owner_builder_id, landlet_class,
         landlet_type, biome, polygon_json, generated_at, claimable_at, metadata_json, max_world_radius_m)
      VALUES (?, ?, ?, ?, ?, 'generating', NULL, ?, ?, ?, ?, NULL, NULL, ?, ?)
    `).bind(
      row.landlet_id, row.name, row.area_m2, row.center_x_m, row.center_y_m, row.landlet_class,
      row.landlet_type, row.biome, row.polygon_json, row.metadata_json, landletMaxWorldRadius(row),
    ),
    db.prepare(`
      UPDATE landlet_candidates SET materialized_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE landlet_id = ? AND materialized_at IS NULL
    `).bind(row.landlet_id),
  ]);
}

export {
  handleLandCandidates, handleLandCandidateRings, handleWorld, autoGrowWorldIfNeeded,
  candidateRowFromLandlet, computeGreenbeltRatio,
};
