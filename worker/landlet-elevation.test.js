// #2851 (leaf of #2373, sub-issue of #2368, Option C real terrain --
// owner decision 2026-10-27): applyRealElevationClassification, the
// generation-time write path that turns #2850's own raw elevationAt
// reading into the already-baselined `elevationM` every ground-mesh
// consumer (src/build/scene.js, src/shop/mode.js, src/world/models.js)
// just adds directly onto a vertex's local z. Mirrors geo-biome-cells.
// test.js's own real-dataset-avoidance convention: every seeded
// coordinate here is well outside the real ingested radius (migrations/
// 0149/0162's own seed data), so this test never collides with it.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyRealElevationClassification, WORLD_ELEVATION_BASELINE_M } from './lib/world-generation.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

async function seedElevationCell(x, y, elevationM, spacingM = 25) {
  await env.DB.prepare(`
    INSERT INTO geo_biome_cells (x_m, y_m, biome, spacing_m, generated_at, elevation_m)
    VALUES (?, ?, 'lowland', ?, ?, ?)
  `).bind(x, y, spacingM, new Date().toISOString(), elevationM).run();
}

describe('WORLD_ELEVATION_BASELINE_M (#2851)', () => {
  it('matches the real reading migrations/0162 baked in at the world origin', async () => {
    // Confirms the frozen constant hasn't drifted from the real seed data
    // it was taken from -- the whole point of freezing it is that this
    // stays stable even as more of the world gets ingested later, so this
    // guards against someone "helpfully" re-deriving it from a live query.
    const origin = await env.DB.prepare(
      'SELECT elevation_m FROM geo_biome_cells WHERE x_m = 0 AND y_m = 0',
    ).first();
    expect(origin.elevation_m).toBe(WORLD_ELEVATION_BASELINE_M);
  });
});

describe('applyRealElevationClassification (#2851)', () => {
  it('stores elevation relative to the baseline, not the raw reading', async () => {
    await seedElevationCell(22000, 22000, WORLD_ELEVATION_BASELINE_M + 50);
    const candidates = [{ center: { x: 22000, y: 22000 } }];
    await applyRealElevationClassification(env.DB, candidates);
    expect(candidates[0].elevationM).toBeCloseTo(50, 5);
  });

  it('produces a negative offset for a point below the baseline (a valley)', async () => {
    await seedElevationCell(22100, 22100, WORLD_ELEVATION_BASELINE_M - 12);
    const candidates = [{ center: { x: 22100, y: 22100 } }];
    await applyRealElevationClassification(env.DB, candidates);
    expect(candidates[0].elevationM).toBeCloseTo(-12, 5);
  });

  it('leaves elevationM unset when no sampled cell is close enough', async () => {
    const candidates = [{ center: { x: 23000, y: 23000 } }];
    await applyRealElevationClassification(env.DB, candidates);
    expect(candidates[0].elevationM).toBeUndefined();
  });

  it('leaves elevationM unset for a cell whose elevation_m was never backfilled (NULL)', async () => {
    await seedElevationCell(22200, 22200, null);
    const candidates = [{ center: { x: 22200, y: 22200 } }];
    await applyRealElevationClassification(env.DB, candidates);
    expect(candidates[0].elevationM).toBeUndefined();
  });

  it('never overwrites an elevationM a caller already set', async () => {
    await seedElevationCell(22300, 22300, WORLD_ELEVATION_BASELINE_M + 999);
    const candidates = [{ center: { x: 22300, y: 22300 }, elevationM: 7 }];
    await applyRealElevationClassification(env.DB, candidates);
    expect(candidates[0].elevationM).toBe(7);
  });

  it('classifies several candidates independently in one call', async () => {
    await seedElevationCell(22400, 22400, WORLD_ELEVATION_BASELINE_M + 10);
    await seedElevationCell(22500, 22500, WORLD_ELEVATION_BASELINE_M + 20);
    const candidates = [
      { center: { x: 22400, y: 22400 } },
      { center: { x: 22500, y: 22500 } },
      { center: { x: 29000, y: 29000 } }, // no cell nearby
    ];
    await applyRealElevationClassification(env.DB, candidates);
    expect(candidates[0].elevationM).toBeCloseTo(10, 5);
    expect(candidates[1].elevationM).toBeCloseTo(20, 5);
    expect(candidates[2].elevationM).toBeUndefined();
  });
});
