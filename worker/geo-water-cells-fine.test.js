// #2805 (sub-issue of #2804, water-first/variable-size landlet generation):
// geo_water_cells_fine (migrations/0156) is the new higher-granularity
// companion to geo_water_cells, fed by scripts/ingest-geo-data.mjs's new
// fine pass (lakes at higher granularity + rivers). This covers its own
// two query helpers, worker/lib/world-generation.js's isWaterAtFinePoint
// (mirrors geo-water-cells.test.js's isNearWaterCell coverage, against the
// fine table) and fractionOfRegionWater (the "is this candidate shape
// predominantly water" primitive #2805's own scope text calls for).
// Neither is wired into any real generation path yet -- that's #2806's
// scope, not this one's -- so unlike geo-water-cells.test.js there's no
// generate-mosaic/generate-ring integration coverage here, only the
// helpers themselves.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { fractionOfRegionWater, isWaterAtFinePoint } from './lib/world-generation.js';
import { GEO_WATER_FINE_GRID_SPACING_M } from './geoData.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

async function seedFineWaterCell(x, y, spacingM = GEO_WATER_FINE_GRID_SPACING_M) {
  await env.DB.prepare(`
    INSERT INTO geo_water_cells_fine (x_m, y_m, spacing_m, generated_at) VALUES (?, ?, ?, ?)
  `).bind(x, y, spacingM, new Date().toISOString()).run();
}

describe('isWaterAtFinePoint (#2805)', () => {
  it('is false against an empty table', async () => {
    expect(await isWaterAtFinePoint(env.DB, 0, 0)).toBe(false);
  });

  it('is true exactly on a seeded fine cell', async () => {
    await seedFineWaterCell(1000, 2000);
    expect(await isWaterAtFinePoint(env.DB, 1000, 2000)).toBe(true);
  });

  it('is true within the cell\'s own spacing, false just beyond it', async () => {
    await seedFineWaterCell(3000, 3000, 5);
    expect(await isWaterAtFinePoint(env.DB, 3004, 3000)).toBe(true); // 4m away, within 5m spacing
    expect(await isWaterAtFinePoint(env.DB, 3010, 3000)).toBe(false); // 10m away, outside it
  });

  it('is false for a point far from every seeded fine cell', async () => {
    await seedFineWaterCell(-9000, -9000);
    expect(await isWaterAtFinePoint(env.DB, 0, 0)).toBe(false);
  });
});

describe('fractionOfRegionWater (#2805)', () => {
  const spacing = GEO_WATER_FINE_GRID_SPACING_M;

  // A square padded half a spacing beyond an N-lattice-point-wide block
  // starting at (baseX, baseY) -- the padding keeps every one of the N*N
  // lattice points strictly interior to the polygon, away from
  // pointInPolygon's own documented unreliability exactly on a boundary
  // (worker/geometry.js's own comment on strictlyInsidePolygon), rather
  // than landing test assertions on that ambiguity. baseX/baseY must
  // themselves be exact multiples of spacing.
  function paddedSquare(baseX, baseY, cellsWide) {
    const half = spacing / 2;
    const span = spacing * (cellsWide - 1);
    return [
      { x: baseX - half, y: baseY - half },
      { x: baseX + span + half, y: baseY - half },
      { x: baseX + span + half, y: baseY + span + half },
      { x: baseX - half, y: baseY + span + half },
    ];
  }

  it('is 0 for a polygon whose one lattice point is not seeded as water', async () => {
    const square = paddedSquare(10000, 10000, 1);
    expect(await fractionOfRegionWater(env.DB, square)).toBe(0);
  });

  it('is 1 when every lattice point inside the polygon is seeded as water', async () => {
    const baseX = 20000;
    const baseY = 20000;
    const square = paddedSquare(baseX, baseY, 2); // lattice points at baseX/baseX+spacing x baseY/baseY+spacing
    for (const x of [baseX, baseX + spacing]) {
      for (const y of [baseY, baseY + spacing]) {
        // eslint-disable-next-line no-await-in-loop -- test setup, small fixed count
        await seedFineWaterCell(x, y);
      }
    }
    expect(await fractionOfRegionWater(env.DB, square)).toBeCloseTo(1, 6);
  });

  it('is a partial fraction when only some lattice points inside the polygon are seeded as water', async () => {
    const baseX = 30000;
    const baseY = 30000;
    const square = paddedSquare(baseX, baseY, 3); // 3x3 = 9 lattice points
    await seedFineWaterCell(baseX + spacing, baseY + spacing); // the center one only
    const fraction = await fractionOfRegionWater(env.DB, square);
    expect(fraction).toBeCloseTo(1 / 9, 6);
  });

  it('never counts a water cell seeded outside the polygon\'s own bounding box', async () => {
    const baseX = 40000;
    const baseY = 40000;
    const square = paddedSquare(baseX, baseY, 1);
    await seedFineWaterCell(baseX + spacing * 50, baseY + spacing * 50); // far outside
    expect(await fractionOfRegionWater(env.DB, square)).toBe(0);
  });
});
