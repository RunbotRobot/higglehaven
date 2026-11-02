// #3011: two independent bugs blocked POST /land-candidates/generate-ring's
// adjacentToRingId reuse feature against a water-containing parent ring --
// both fixed here, both exercised by this one test:
//
// 1. The reuse path re-derived each reused plot's angular width from its
//    own areaM2 via generateLandletRing's asin formula (worker/landGenerator.js)
//    -- correct only when every plot in the ring shared one uniform
//    full-circle angular budget. generateWaterAwareLandletRing (worker/lib/
//    water-aware-ring.js) splits its own budget unevenly per plot once real
//    water intersects the ring, and a water-arc entry's own stored areaM2
//    is a back-computed real polygon area, not an asin-invertible target at
//    all -- re-deriving silently produced different angles than the parent
//    actually used, 409ing with "Adjacent generated rings must use matching
//    boundary seams". Fixed by having both generators stamp each landlet's
//    own exact angular width into its metadata (widthRad) and having the
//    reuse path read it straight back instead of re-deriving it from area.
// 2. landlet_candidate_rings.candidate_count was stored as the caller's
//    requested land-plot count, not the ring's own actual stored candidate
//    row count -- the two only coincide when generateLandletRing is used
//    (always exactly one row per plot); generateWaterAwareLandletRing can
//    and does produce MORE rows than the requested plot count (a water-arc
//    entry, or a land plot split into fragments, each becomes its own
//    row). This silently 409'd reuse with "Adjacent ring candidate
//    membership is incomplete" even with every row present and correct,
//    independent of bug 1 above -- confirmed by reaching it even with bug 1
//    fixed, for a ring whose own real water split any plot at all. Fixed by
//    storing the ring's own actual row count instead.
//
// Neither bug is reachable by real auto-growth today (generateNextAutoRing
// always calls with adjacentToRingId null, never wiring two consecutive
// rings together this way) -- see the issue's own comment thread for why
// that's a separate, larger piece of work left open.
import {
  applyD1Migrations, env,
} from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api, signupAdmin } from './test-helpers.js';

let adminSession;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const admin = await signupAdmin('water-ring-adjacency-admin');
  adminSession = admin.session;
});

// Isolates this file's own water-aware ring from migrations/0167's real
// seeded data and from any other test's own leftover rows -- same
// "DELETE then seed synthetic" discipline water-aware-ring.test.js already
// uses, needed here too since this ring's own generation reads real
// geo_water_cells_fine the same way.
beforeEach(async () => {
  await env.DB.exec('DELETE FROM geo_water_cells_fine');
});

const SPACING_M = 5;
const TAU = Math.PI * 2;

// Seeds water across the lower half of the circle (angle [PI, 2*PI)) for
// the full radial band a ring at this test's own innerRadiusM could
// plausibly land in -- generous enough to safely cover wherever the ring's
// own fixed-point outerRadiusM solve converges, without needing to predict
// it exactly. Mirrors worker/lib/water-aware-ring.test.js's own
// seedWaterArc, trimmed to this file's one shape.
async function seedHalfCircleWater(innerRadiusM, outerRadiusM) {
  const now = new Date().toISOString();
  const statements = [];
  for (let x = -outerRadiusM; x <= outerRadiusM; x += SPACING_M) {
    for (let y = -outerRadiusM; y <= outerRadiusM; y += SPACING_M) {
      const radius = Math.hypot(x, y);
      if (radius < innerRadiusM || radius > outerRadiusM) continue;
      const angle = (Math.atan2(y, x) + TAU) % TAU;
      if (angle < Math.PI) continue; // upper half stays dry land
      statements.push(env.DB.prepare(
        'INSERT OR IGNORE INTO geo_water_cells_fine (x_m, y_m, spacing_m, generated_at) VALUES (?, ?, ?, ?)',
      ).bind(x, y, SPACING_M, now));
    }
  }
  if (statements.length > 0) await env.DB.batch(statements);
}

describe('Adjacent-ring reuse against a water-containing parent (#3011)', () => {
  it('reproduces the parent ring\'s exact seam instead of 409ing on a boundary mismatch', async () => {
    const innerRadiusM = 1000;
    // Generous margin over the ring's own small expected outerRadiusM
    // growth (6 tiny 1000m^2 plots at this radius barely grow the radius
    // at all) -- safely covers the real band regardless of exactly where
    // the fixed-point solve lands, while staying small enough that the
    // synthetic lattice seed below (O(radius^2) points) runs quickly.
    await seedHalfCircleWater(innerRadiusM, innerRadiusM + 60);

    const parent = await api('/land-candidates/generate-ring', adminSession({
      method: 'POST',
      body: JSON.stringify({ prefix: 'water-ring-3011-parent', count: 6, innerRadiusM }),
    }));
    expect(parent.response.status).toBe(201);

    // Confirms the parent ring actually went through the water-aware path
    // and really did split its own angular budget unevenly -- otherwise
    // this test would pass even without the fix (the pre-fix bug only
    // manifests once water is actually involved).
    const parentCandidates = await env.DB.prepare(
      'SELECT landlet_type FROM landlet_candidates WHERE ring_id = ?',
    ).bind('water-ring-3011-parent').all();
    expect(parentCandidates.results.some((row) => row.landlet_type === 'water')).toBe(true);
    // The real water split at least one of the 6 requested land plots into
    // extra rows -- otherwise bug 2 above could never have been reached,
    // and this test would only exercise bug 1.
    expect(parentCandidates.results.length).toBeGreaterThan(6);

    const parentRow = await env.DB.prepare(
      'SELECT candidate_count FROM landlet_candidate_rings WHERE ring_id = ?',
    ).bind('water-ring-3011-parent').first();
    expect(parentRow.candidate_count).toBe(parentCandidates.results.length);

    const child = await api('/land-candidates/generate-ring', adminSession({
      method: 'POST',
      body: JSON.stringify({
        prefix: 'water-ring-3011-child', count: parentRow.candidate_count, adjacentToRingId: 'water-ring-3011-parent',
      }),
    }));
    expect(child.response.status).toBe(201);
    expect(child.body.error).toBeUndefined();

    const [parentRing, childRing] = await Promise.all([
      env.DB.prepare('SELECT boundary_signature, outer_radius_m FROM landlet_candidate_rings WHERE ring_id = ?')
        .bind('water-ring-3011-parent').first(),
      env.DB.prepare('SELECT boundary_signature, inner_radius_m FROM landlet_candidate_rings WHERE ring_id = ?')
        .bind('water-ring-3011-child').first(),
    ]);
    expect(childRing.inner_radius_m).toBe(parentRing.outer_radius_m);
    expect(childRing.boundary_signature).toBe(parentRing.boundary_signature);
  });
});
