// #2541 (sub-issue of #2502, itself sub-issue of #2500's worker/index.js
// module split): credit orbs (#1994, sub-issue of #1976, "Orb-collection
// mechanic to ration free video-to-3D generation credits within a hard
// $5/day budget") -- the spawn-sweep, read, and collect route handler/
// helpers. Extracted verbatim, zero behavior change.
//
// Deliberately NOT included here: requireSessionBuilder/requireAdmin --
// requireAdmin is already extracted (worker/lib/auth.js); requireSessionBuilder
// is the builder-profile domain's own auth-chain internal (#2535), not yet
// extracted itself (blocked on #2543, see worker/lib/auth.js's own comment
// on why) -- so it stays in worker/index.js and is imported back below,
// the same shape worker/lib/builder-profile.js's own comment documents for
// its own templateFromRow/recomputeLandCap imports (#2535). LANDLET_SIDE_M/
// PRESENCE_STALE_AFTER_MS are likewise genuinely shared beyond this file
// (every per-landlet placement calculation; every presence-staleness
// check), not credit-orb-specific.
import { json, HttpError } from './http.js';
import { checkRateLimit } from './rate-limit.js';
import { requireAdmin } from './auth.js';
import { readJson, stringValue, finiteNumber } from './validation.js';
import { adminActionLogStatement } from './admin-log.js';
import { requireSessionBuilder } from '../index.js';

// #1978: workerd requires every named export of the main Worker entry
// module (worker/index.js) to be a function/class binding, not a plain
// const -- confirmed the hard way, per worker/lib/builder-profile.js's own
// comment on its identical D1_MAX_BOUND_PARAMETERS duplication. Both
// duplicated here rather than exported-and-imported for that reason;
// worker/index.js stays the source of truth for every other reader
// (every per-landlet placement calculation for LANDLET_SIDE_M; every other
// presence-staleness check for PRESENCE_STALE_AFTER_MS).
const LANDLET_SIDE_M = Math.sqrt(1000);
const PRESENCE_STALE_AFTER_MS = 10_000;

// #1994 (sub-issue of #1976, "Orb-collection mechanic to ration free
// video-to-3D generation credits within a hard $5/day budget"): the real
// per-generation cost isn't tracked anywhere in this codebase yet (see
// VIDEO_GENERATION_RATE_LIMIT_MAX's own comment, worker/lib/video-generation.js),
// so this is a named, adjustable placeholder rather than derived from live
// cost data. #1617's own research cites ~$0.20-0.30/generation -- a
// conservative $0.25 mid-point (CREDIT_ORB_COST_CENTS_PER_GENERATION below)
// against a $5/day budget funds 20 credits/day, not the owner's own
// original "5/day" illustrative example (that used a hypothetical
// $1/generation). Raise or lower CREDIT_ORB_COST_CENTS_PER_GENERATION once
// real Tripo billing is confirmed -- neither constant is load-bearing
// beyond this feature.
const CREDIT_ORB_BUDGET_CENTS_PER_DAY = 500;
const CREDIT_ORB_COST_CENTS_PER_GENERATION = 25;
const CREDIT_ORBS_PER_DAY = Math.floor(CREDIT_ORB_BUDGET_CENTS_PER_DAY / CREDIT_ORB_COST_CENTS_PER_GENERATION);
// Owner's own spec: interval = 1440 minutes ÷ credits-funded-that-day, so
// orbs spawn spread evenly across the day rather than in a burst.
const CREDIT_ORB_SPAWN_INTERVAL_MS = (24 * 60 * 60 * 1000) / CREDIT_ORBS_PER_DAY;

// Keeps a spawned orb's center comfortably inside the buildable footprint
// landlets.live/handleInstances already enforce (LANDLET_SIDE_M, #789) --
// an 0.8 margin so it never spawns flush against the very edge, which
// would read as half-buried in a neighboring landlet once rendered.
const CREDIT_ORB_SPAWN_MARGIN_FACTOR = 0.8;

// Called from scheduled() on the existing */10 cron (no dedicated cron of
// its own needed -- the 10-minute granularity is well under
// CREDIT_ORB_SPAWN_INTERVAL_MS at any plausible CREDIT_ORBS_PER_DAY, so the
// actual cadence this produces stays close to even). Reuses credit_orbs'
// own most recent spawned_at (across every orb, collected or not) as the
// "last spawn time" anchor rather than a separate single-row state table
// -- there's already exactly one row to read it from once any orb exists,
// and the INSERT...WHERE NOT EXISTS below folds the "is one due" check and
// the spawn into one atomic statement, the same race-proofing idiom
// reserveVideoGenerationJob/reserveDiditSession already use for their own
// concurrent-caller races: two overlapping cron ticks can never both spawn
// one, because D1/SQLite serializes writes and the second caller's own
// NOT EXISTS subquery sees the first caller's already-committed INSERT.
export async function spawnCreditOrbIfDue(db) {
  const cutoff = new Date(Date.now() - CREDIT_ORB_SPAWN_INTERVAL_MS).toISOString();
  const halfSpan = (LANDLET_SIDE_M / 2) * CREDIT_ORB_SPAWN_MARGIN_FACTOR;
  const x = (Math.random() * 2 - 1) * halfSpan;
  const y = (Math.random() * 2 - 1) * halfSpan;
  const orbId = `orb-${crypto.randomUUID()}`;
  await db.prepare(`
    INSERT INTO credit_orbs (orb_id, landlet_id, x_m, y_m, z_m)
    SELECT ?, landlet_id, ?, ?, 0 FROM landlets
    WHERE status = 'greenbelt'
      AND NOT EXISTS (SELECT 1 FROM credit_orbs WHERE spawned_at > ?)
    ORDER BY RANDOM() LIMIT 1
  `).bind(orbId, x, y, cutoff).run();
}

function creditOrbFromRow(row) {
  return {
    orbId: row.orb_id,
    landletId: row.landlet_id,
    x: row.x_m,
    y: row.y_m,
    z: row.z_m,
    spawnedAt: row.spawned_at,
  };
}

// #2092: every other authenticated, repeatable-write endpoint in this file
// rate-limits itself -- the collect branch below never did, letting a
// scripted caller drive unbounded D1 load via repeated claim attempts
// (including against bogus/already-collected orb ids, which 404 cheaply but
// still cost a full batch round-trip).
const CREDIT_ORB_COLLECT_RATE_LIMIT_MAX = 20;

// #2222: the collect branch had no server-side presence/proximity check at
// all -- a scripted caller could skip the client's own "walk up to it"
// gesture (src/main.js's CREDIT_ORB_COLLECT_RADIUS_M = 1.5m check) entirely
// and drain the whole CREDIT_ORB_BUDGET_CENTS_PER_DAY budget via direct API
// calls. Reuses this file's only other avatar_presence-freshness idiom
// (PRESENCE_STALE_AFTER_MS, #1767) rather than inventing a second one, and
// a radius generous enough to tolerate that same staleness window's worth
// of real movement at SHOP_RUN_SPEED_M_S (#2481: 4.4704m/s/10mph as of
// #2444, ~45m -- was 2.7m/s/~27m when this constant was first set, see
// #2481) on top of the client's own 1.5m collect radius -- the point of
// this check is requiring *some* fresh, correctly-landletted presence at
// all (what the scripted exploit has none of), not pixel-perfect
// anti-cheat precision.
const CREDIT_ORB_COLLECT_PROXIMITY_RADIUS_M = 50;

// GET /api/credit-orbs (optionally ?landletId=... to scope to one landlet,
// per #1994's own "or scoped by landlet" note) -- the frontend's read path
// for #1995's own rendering/collection sub-issue. Deliberately
// unauthenticated/unsession-gated: an active orb's existence and position
// are the same kind of public, visible-in-the-3D-scene information
// GET /api/instances already serves for ordinary placed items, not a
// builder-specific secret.
export async function handleCreditOrbs(request, db, route, url) {
  if (request.method === 'GET' && route.length === 1) {
    const landletId = url.searchParams.get('landletId');
    const conditions = ['collected_at IS NULL'];
    const bindings = [];
    if (landletId !== null) {
      conditions.push('landlet_id = ?');
      bindings.push(stringValue(landletId, 'landletId'));
    }
    const { results } = await db.prepare(`
      SELECT orb_id, landlet_id, x_m, y_m, z_m, spawned_at FROM credit_orbs
      WHERE ${conditions.join(' AND ')}
      ORDER BY spawned_at
    `).bind(...bindings).all();
    return json({ orbs: results.map(creditOrbFromRow) });
  }
  // POST /api/credit-orbs -- admin-gated test/ops fixture, same escape-hatch
  // reasoning as POST /api/landlets/.../land-cap-grants/higgles-grants: the
  // real spawn cadence (spawnCreditOrbIfDue, ~70min apart by default) is far
  // too slow for a test that only cares about what happens once an orb
  // exists to self-time against reliably. Inserts directly into a caller-
  // specified landlet (any status, not gated to 'greenbelt' -- a caller
  // using this already knows exactly what it wants to seed).
  if (request.method === 'POST' && route.length === 1) {
    const admin = await requireAdmin(request, db);
    const input = await readJson(request);
    const landletId = stringValue(input.landletId, 'landletId');
    const x = input.x === undefined ? 0 : finiteNumber(input.x, 'x');
    const y = input.y === undefined ? 0 : finiteNumber(input.y, 'y');
    const orbId = `orb-${crypto.randomUUID()}`;
    const inserted = await db.prepare(`
      INSERT INTO credit_orbs (orb_id, landlet_id, x_m, y_m, z_m)
      SELECT ?, landlet_id, ?, ?, 0 FROM landlets WHERE landlet_id = ?
    `).bind(orbId, x, y, landletId).run();
    if (inserted.meta.changes === 0) throw new HttpError('Landlet not found', 404);
    await adminActionLogStatement(db, admin.user_id, 'credit_orb_seed', 'landlet', landletId, { orbId }).run();
    return json({ orbId }, 201);
  }
  // POST /api/credit-orbs/:orbId/collect (#1995) -- session-gated (unlike
  // the GET above) since collecting actually credits the calling builder's
  // own video_generation_credits. Race-safe the same way every other
  // claim-before-act endpoint in this file already is: the UPDATE's own
  // `WHERE collected_at IS NULL` is the atomic "first builder wins" claim,
  // and the credit grant is batched in the same D1 transaction, gated on
  // an EXISTS check against the row this same batch's first statement just
  // committed -- so a crash between the two can never happen (they're one
  // atomic unit), and two shoppers racing the same orb can never both grant
  // themselves a credit for it.
  if (request.method === 'POST' && route.length === 3 && route[2] === 'collect') {
    const sessionBuilder = await requireSessionBuilder(request, db);
    await checkRateLimit(db, `credit-orb-collect:${sessionBuilder.builder_id}`, CREDIT_ORB_COLLECT_RATE_LIMIT_MAX);
    const orbId = stringValue(route[1], 'orbId');
    // x_m/y_m are landlet-local offsets (added to the owning landlet's own
    // center_x_m/center_y_m to get a world position, same convention every
    // other per-landlet placed thing in this file uses) -- joined here
    // since avatar_presence (below) only ever stores a world x/y.
    const orb = await db.prepare(`
      SELECT credit_orbs.landlet_id, landlets.center_x_m + credit_orbs.x_m AS world_x,
        landlets.center_y_m + credit_orbs.y_m AS world_y
      FROM credit_orbs JOIN landlets ON landlets.landlet_id = credit_orbs.landlet_id
      WHERE credit_orbs.orb_id = ? AND credit_orbs.collected_at IS NULL
    `).bind(orbId).first();
    if (!orb) {
      throw new HttpError('This credit orb is no longer available -- someone else may have already collected it.', 404);
    }
    // Deliberately no landlet_id match against avatar_presence here, unlike
    // the "nearby avatars" GET above -- updateShopLandletInfo (src/main.js)
    // only ever sets a reported landletId while standing on a *claimed*
    // landlet (whose land is this), and every credit orb spawns on a
    // greenbelt one (spawnCreditOrbIfDue's own `WHERE status = 'greenbelt'`)
    // by definition, so a real collector's own presence row would always
    // report landlet_id: null here. World-position proximity (below) is
    // the actual "walked up to it" signal, independent of land ownership.
    const staleBefore = new Date(Date.now() - PRESENCE_STALE_AFTER_MS).toISOString();
    const presence = await db.prepare('SELECT x, y, updated_at FROM avatar_presence WHERE builder_id = ?')
      .bind(sessionBuilder.builder_id).first();
    const nearby = presence
      && presence.updated_at >= staleBefore
      && Math.hypot(presence.x - orb.world_x, presence.y - orb.world_y) <= CREDIT_ORB_COLLECT_PROXIMITY_RADIUS_M;
    if (!nearby) {
      throw new HttpError('You need to be near this credit orb in the world to collect it', 403);
    }
    const [claim] = await db.batch([
      db.prepare(`
        UPDATE credit_orbs SET collected_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), collected_by_builder_id = ?
        WHERE orb_id = ? AND collected_at IS NULL
      `).bind(sessionBuilder.builder_id, orbId),
      db.prepare(`
        UPDATE builders SET video_generation_credits = video_generation_credits + 1
        WHERE builder_id = ? AND EXISTS (
          SELECT 1 FROM credit_orbs WHERE orb_id = ? AND collected_by_builder_id = ?
        )
      `).bind(sessionBuilder.builder_id, orbId, sessionBuilder.builder_id),
    ]);
    if (claim.meta.changes === 0) {
      throw new HttpError('This credit orb is no longer available -- someone else may have already collected it.', 404);
    }
    return json({ collected: true });
  }
  return json({ error: 'Not found' }, 404);
}
