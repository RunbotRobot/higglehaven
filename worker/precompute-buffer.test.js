// #2807 (sub-issue of #2804, water-first/variable-size landlet
// generation): maintainPrecomputeBuffer keeps a buffer of pre-generated
// land staged `precompute_lead_m` ahead of the live world radius, rather
// than only ever generating reactively right when expandWorldOnce needs
// more room (autoGrowWorldIfNeeded's own existing, unchanged behavior).
// A dedicated, freshly-migrated D1 instance (same reasoning
// auto-mosaic-preference.test.js's own header comment gives) -- a fresh
// world's own trivially-satisfied greenbelt ratio (just starter-landlet)
// means autoGrowWorldIfNeeded never fires on its own here, so these tests
// can observe maintainPrecomputeBuffer's own effects in isolation.
import {
  applyD1Migrations, env, createExecutionContext, createScheduledController, waitOnExecutionContext,
} from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { maintainPrecomputeBuffer } from './lib/world-generation.js';
import worker from './index.js';

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

// See its own citation below -- generously bounds the inherent chord-
// bowing of a ring's straight-edged polygon approximation of its true
// circular inner boundary, well above the ~0.07m real effect measured
// for this ring's own geometry.
const RING_INNER_EDGE_BOW_TOLERANCE_M = 1;

async function worldSettings() {
  return env.DB.prepare("SELECT * FROM world_settings WHERE world_id = 'default-world'").first();
}

async function autoRingOuterRadii() {
  const { results } = await env.DB.prepare(
    "SELECT outer_radius_m FROM landlet_candidate_rings WHERE ring_id LIKE 'auto-ring-%' ORDER BY outer_radius_m",
  ).all();
  return results.map((row) => row.outer_radius_m);
}

describe('maintainPrecomputeBuffer (#2807)', () => {
  it('builds a fresh buffer out to radius_m + precompute_lead_m on the first run, without widening the lead', async () => {
    const before = await worldSettings();
    expect(before.precompute_lead_m).toBe(30); // migrations/0158's own default

    await maintainPrecomputeBuffer(env.DB);

    const radii = await autoRingOuterRadii();
    expect(radii.length).toBeGreaterThan(0);
    const bufferOuterRadiusM = radii.at(-1);
    expect(bufferOuterRadiusM).toBeGreaterThanOrEqual(before.radius_m + before.precompute_lead_m);

    const after = await worldSettings();
    expect(after.precompute_lead_m).toBe(before.precompute_lead_m); // never built before -> no widening
  });

  it('does not generate any additional ring when the buffer is already sufficiently ahead', async () => {
    await maintainPrecomputeBuffer(env.DB);
    const radiiAfterFirst = await autoRingOuterRadii();

    await maintainPrecomputeBuffer(env.DB);
    const radiiAfterSecond = await autoRingOuterRadii();

    expect(radiiAfterSecond).toEqual(radiiAfterFirst);
  });

  it('widens precompute_lead_m and tops back up once the buffer is found genuinely caught up and consumed', async () => {
    await maintainPrecomputeBuffer(env.DB); // build a real buffer first
    const builtRadii = await autoRingOuterRadii();
    const bufferOuterRadiusM = builtRadii.at(-1);
    const beforeWiden = await worldSettings();

    // Simulate live growth having caught all the way up to the buffer's
    // own outer edge -- the real "did catch up" signal, same invariant
    // expandWorldOnce itself maintains (radius_m only ever grows via its
    // own expansion_increment_m steps, but forcing it directly here keeps
    // this test about maintainPrecomputeBuffer's own reaction to that
    // state, not expandWorldOnce's unrelated mechanics).
    await env.DB.prepare(
      "UPDATE world_settings SET radius_m = ? WHERE world_id = 'default-world'",
    ).bind(bufferOuterRadiusM).run();

    await maintainPrecomputeBuffer(env.DB);

    const afterWiden = await worldSettings();
    expect(afterWiden.precompute_lead_m).toBeCloseTo(beforeWiden.precompute_lead_m * 1.5, 6);

    const radiiAfterWiden = await autoRingOuterRadii();
    expect(radiiAfterWiden.at(-1)).toBeGreaterThanOrEqual(bufferOuterRadiusM + afterWiden.precompute_lead_m);
  });

  it('never force-materializes or encloses the outermost ring it generates -- it sits staged until real growth reaches it', async () => {
    const before = await worldSettings();
    await maintainPrecomputeBuffer(env.DB);
    const radii = await autoRingOuterRadii();
    const outermostRingId = (await env.DB.prepare(
      "SELECT ring_id FROM landlet_candidate_rings WHERE ring_id LIKE 'auto-ring-%' AND outer_radius_m = ?",
    ).bind(radii.at(-1)).first()).ring_id;

    // The outermost ring's own inner edge sits at or past the live radius
    // (never inside it -- that's the whole point of staying
    // `precompute_lead_m` ahead), so unlike a ring generated to fill an
    // actual gap behind the live radius, this one's candidates must still
    // be sitting staged, untouched by the normal materialization sweep.
    const { results } = await env.DB.prepare(
      'SELECT * FROM landlet_candidates WHERE ring_id = ?',
    ).bind(outermostRingId).all();
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((row) => row.materialized_at === null)).toBe(true);
    // #2895: generateLandletRingCandidates' own comment (worker/lib/
    // world-generation.js, the #2807 skipMaterializationSweep note)
    // already documents this exact effect -- a ring's nominal inner edge
    // sits right at the live radius, but its straight-edged polygon
    // approximation of that circular boundary bows slightly inward, so a
    // candidate right at the inner edge can report a real
    // min_world_radius_m a little *less* than the live radius despite
    // never being meant to materialize. RING_INNER_EDGE_BOW_TOLERANCE_M
    // absorbs that documented, inherent discretization artifact (measured
    // ~0.07m for this ring's own geometry) without weakening this test's
    // real invariant, which the materialized_at assertion above already
    // covers directly -- this check still catches a genuine regression
    // (candidates generated meters, not centimeters, inside the live
    // radius).
    expect(results.every((row) => row.min_world_radius_m > before.radius_m - RING_INNER_EDGE_BOW_TOLERANCE_M)).toBe(true);
  });

  // #2894: the widen above is supposed to apply once per genuine catch-up,
  // not compound every tick a stall persists -- distinguished here by
  // planting a candidate that conflicts with every possible ring position
  // (min_world_radius_m 0, max_world_radius_m NULL so it's structurally
  // invisible to currentPrecomputeBufferOuterRadiusM's own measurement
  // query, which only reads rows with max_world_radius_m IS NOT NULL) so
  // generateNextAutoRing can never make real progress, independent of how
  // far out the target radius is pushed. Placed after every other test
  // that depends on a real (non-stuck) buffer actually being buildable --
  // this file's whole describe block shares one D1 instance across all
  // its own tests (vitest.config.js's own comment on why -- one instance
  // per test *file*, not per test), so the blocker planted here would
  // otherwise permanently stop any later test from generating a new ring
  // at all, regardless of the cleanup below.
  it('does not keep widening precompute_lead_m on repeated ticks when generation is genuinely stuck', async () => {
    await maintainPrecomputeBuffer(env.DB); // build a real buffer first
    const builtRadii = await autoRingOuterRadii();
    const bufferOuterRadiusM = builtRadii.at(-1);

    await env.DB.prepare(
      "UPDATE world_settings SET radius_m = ? WHERE world_id = 'default-world'",
    ).bind(bufferOuterRadiusM).run();
    await env.DB.prepare(`
      INSERT INTO landlet_candidates
        (landlet_id, name, area_m2, center_x_m, center_y_m, landlet_class, landlet_type,
         polygon_json, metadata_json, min_world_radius_m, max_world_radius_m)
      VALUES ('blocker-001', 'blocker', 1000, 0, 0, 1, 'buildable', '[]', '{}', 0, NULL)
    `).run();

    const beforeStuck = await worldSettings();

    await maintainPrecomputeBuffer(env.DB);
    const afterTick1 = await worldSettings();
    expect(afterTick1.precompute_lead_m).toBeCloseTo(beforeStuck.precompute_lead_m, 6);

    await maintainPrecomputeBuffer(env.DB);
    const afterTick2 = await worldSettings();
    expect(afterTick2.precompute_lead_m).toBeCloseTo(beforeStuck.precompute_lead_m, 6);

    await maintainPrecomputeBuffer(env.DB);
    const afterTick3 = await worldSettings();
    expect(afterTick3.precompute_lead_m).toBeCloseTo(beforeStuck.precompute_lead_m, 6);

    const radiiAfterStuck = await autoRingOuterRadii();
    expect(radiiAfterStuck).toEqual(builtRadii);

    // #2895: clean up so this planted blocker can't also poison the
    // scheduled()-cron test below (same shared-D1-instance reasoning as
    // this test's own placement above).
    await env.DB.prepare("DELETE FROM landlet_candidates WHERE landlet_id = 'blocker-001'").run();
  });

  it('is actually wired into the scheduled() cron, not just reachable directly', async () => {
    const controller = createScheduledController();
    const ctx = createExecutionContext();
    await worker.scheduled(controller, env, ctx);
    await waitOnExecutionContext(ctx);

    const radii = await autoRingOuterRadii();
    expect(radii.length).toBeGreaterThan(0);
  }, 15000);
});
