// #2370 (sub-issue of #2368, following up on #2013's precedent for
// water): geo_biome_cells (migrations/0149) is where a deployed Worker
// can actually read the real biome classification scripts/ingest-geo-data.mjs
// produces -- Workers have no filesystem at request time to read that
// script's own JSON output directly. This covers biomeAt, the one lookup
// against it. Wiring it into actual generation is #2371's own scope, not
// this one.
//
// Unlike geo-water-cells.test.js's own sparse real dataset (only ~43
// actual water cells out of hundreds of possible grid points, so its
// arbitrary test coordinates never happen to collide), migrations/0149's
// real seed data is dense -- every sampled point out to radius 300m
// around the world origin has its own row. Every coordinate this file
// seeds is therefore chosen well outside that radius (the 20000+ range)
// so it can never collide with (or be contaminated by) the real ingested
// dataset migrations/0149 bakes into every test run's own D1 instance.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll } from 'vitest';
import { describe, expect, it } from 'vitest';
import { biomeAt, elevationAt } from './lib/world-generation.js';
import { defaultMosaicBoundaryRadiusM, generateWaterAwareMosaic } from './lib/water-aware-mosaic.js';
import { discBoundary } from './weightedVoronoiGenerator.js';
import { generateLandletRing } from './landGenerator.js';
import { pointInPolygon } from './geometry.js';
import { api, signupAdmin } from './test-helpers.js';

let adminSession;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const admin = await signupAdmin('geo-biome-cells-admin');
  adminSession = admin.session;
});

async function seedBiomeCell(x, y, biome, spacingM = 25, elevationM = null) {
  await env.DB.prepare(`
    INSERT INTO geo_biome_cells (x_m, y_m, biome, spacing_m, generated_at, elevation_m) VALUES (?, ?, ?, ?, ?, ?)
  `).bind(x, y, biome, spacingM, new Date().toISOString(), elevationM).run();
}

describe('biomeAt (#2370)', () => {
  it('is null far outside the real ingested dataset, with no cell seeded', async () => {
    expect(await biomeAt(env.DB, 20000, 20000)).toBeNull();
  });

  it('returns the exact biome of a seeded cell', async () => {
    await seedBiomeCell(20100, 20200, 'upland');
    expect(await biomeAt(env.DB, 20100, 20200)).toBe('upland');
  });

  it('returns the biome within the cell\'s own spacing, null just beyond it', async () => {
    await seedBiomeCell(20500, 20500, 'alpine', 25);
    expect(await biomeAt(env.DB, 20520, 20500)).toBe('alpine'); // 20m away, within 25m spacing
    expect(await biomeAt(env.DB, 20560, 20500)).toBeNull(); // 60m away, outside it
  });

  it('returns the nearest cell\'s biome when two different cells are both in range', async () => {
    await seedBiomeCell(21000, 21000, 'lowland', 30);
    await seedBiomeCell(21040, 21000, 'near_water', 30);
    // 10m from the first cell, 30m from the second -- nearest wins.
    expect(await biomeAt(env.DB, 21010, 21000)).toBe('lowland');
  });

  it('is null for a point far from every seeded cell', async () => {
    await seedBiomeCell(19000, 19000, 'lowland');
    expect(await biomeAt(env.DB, 20000, 20000)).toBeNull();
  });
});

// #2850 (leaf of #2373, sub-issue of #2368): elevationAt, mirroring
// biomeAt's own coverage above exactly -- same table, same nearest-cell
// lookup shape, just a different column and a real "predates #2850,
// elevation_m never backfilled" gap to cover that biome doesn't have.
describe('elevationAt (#2850)', () => {
  it('is null far outside the real ingested dataset, with no cell seeded', async () => {
    expect(await elevationAt(env.DB, 22000, 22000)).toBeNull();
  });

  it('returns the exact elevation of a seeded cell', async () => {
    await seedBiomeCell(22100, 22200, 'upland', 25, 123.456);
    expect(await elevationAt(env.DB, 22100, 22200)).toBe(123.456);
  });

  it('returns the elevation within the cell\'s own spacing, null just beyond it', async () => {
    await seedBiomeCell(22500, 22500, 'alpine', 25, 500);
    expect(await elevationAt(env.DB, 22520, 22500)).toBe(500); // 20m away, within 25m spacing
    expect(await elevationAt(env.DB, 22560, 22500)).toBeNull(); // 60m away, outside it
  });

  it('returns the nearest cell\'s elevation when two different cells are both in range', async () => {
    await seedBiomeCell(23000, 23000, 'lowland', 30, 10);
    await seedBiomeCell(23040, 23000, 'near_water', 30, 2);
    // 10m from the first cell, 30m from the second -- nearest wins.
    expect(await elevationAt(env.DB, 23010, 23000)).toBe(10);
  });

  it('is null for a cell that predates #2850 and was never backfilled, even though biomeAt still resolves it', async () => {
    await seedBiomeCell(24000, 24000, 'lowland', 25, null);
    expect(await biomeAt(env.DB, 24000, 24000)).toBe('lowland');
    expect(await elevationAt(env.DB, 24000, 24000)).toBeNull();
  });

  it('skips a nearer cell with no elevation reading in favor of a farther one that has it', async () => {
    await seedBiomeCell(25000, 25000, 'lowland', 30, null); // nearer, but no elevation
    await seedBiomeCell(25020, 25000, 'lowland', 30, 42); // farther, has elevation
    expect(await elevationAt(env.DB, 25005, 25000)).toBe(42);
  });
});

// #2371 (sub-issue of #2368): the real consumer of biomeAt, mirroring
// geo-water-cells.test.js's own "#2014" consumer coverage for water --
// both real production generation paths should set `biome` on a plot/
// cell when a real ingested biome cell sits at or near its center, and
// otherwise leave today's always-unclassified (null) behavior exactly as
// it was.
describe('Real biome data upgrades newly-generated landlets to a real biome (#2371)', () => {
  it('sets biome on a ring-generated plot when seeded near a real biome cell, leaving the rest unclassified', async () => {
    // Pure prediction of the exact geometry POST .../generate-ring will
    // produce for these same params, same technique geo-water-cells.test.js
    // already relies on. innerRadiusM is chosen well outside migrations/0149's
    // real dense dataset (radius 300m around the world origin), so the
    // "rest stays unclassified" assertion below is actually meaningful --
    // unlike the mosaic case further down, whose disc always sits on the
    // real data.
    const predicted = generateLandletRing({ prefix: 'biome-ring-test', count: 4, innerRadiusM: 5000, startAngleRad: 0 });
    const biomeCenter = predicted.landlets[1].center;
    await seedBiomeCell(biomeCenter.x, biomeCenter.y, 'alpine', 25);

    const generated = await api('/land-candidates/generate-ring', adminSession({
      method: 'POST',
      body: JSON.stringify({ prefix: 'biome-ring-test', count: 4, innerRadiusM: 5000, startAngleRad: 0 }),
    }));
    expect(generated.response.status).toBe(201);
    const byId = Object.fromEntries(generated.body.candidates.map((candidate) => [candidate.landletId, candidate]));
    expect(byId['biome-ring-test-002'].biome).toBe('alpine');
    expect(byId['biome-ring-test-001'].biome).toBeNull();
    expect(byId['biome-ring-test-003'].biome).toBeNull();
    expect(byId['biome-ring-test-004'].biome).toBeNull();
  });

  it('generates an all-unclassified ring exactly as before when no biome cell is seeded nearby', async () => {
    const generated = await api('/land-candidates/generate-ring', adminSession({
      method: 'POST',
      body: JSON.stringify({ prefix: 'unclassified-ring-test', count: 4, innerRadiusM: 6000, startAngleRad: 0 }),
    }));
    expect(generated.response.status).toBe(201);
    for (const candidate of generated.body.candidates) {
      expect(candidate.biome).toBeNull();
    }
  });

  // Same "one test, not two" constraint geo-water-cells.test.js's own
  // mosaic test documents: generate-mosaic's disc is always centered at
  // the world origin regardless of prefix, so a second call in this same
  // D1 instance always conflicts with the first. Unlike the ring test
  // above, this disc (~71m radius for 16 class-1 cells) sits entirely
  // inside migrations/0149's real dense dataset -- so this only asserts
  // the one specifically-seeded cell gets the seeded value (an exact,
  // distance-0 match always wins over any real grid cell, whatever its
  // own real classification happens to be), not that the rest of the
  // mosaic stays unclassified, which real data already makes untrue.
  // #2812: generateOrganicMosaic is gone from this call path -- predicting
  // the real layout now means calling the new generator the same way
  // generateLandletMosaicCandidates itself does (no fine-grained water is
  // ever seeded in this file, so the tessellation itself is unaffected;
  // only biomeAt's own lookup, applied after generation, is this test's
  // real subject).
  it('sets biome on a mosaic-generated cell when seeded near a real biome cell', async () => {
    const radiusM = defaultMosaicBoundaryRadiusM(16, 'biome-mosaic-test');
    const predicted = await generateWaterAwareMosaic(env.DB, {
      boundary: discBoundary(radiusM), landletCount: 16, seed: 'biome-mosaic-test',
    });
    // Same origin-exclusion logic generateLandletMosaicCandidates applies
    // internally -- the cell covering (0, 0) is folded into starter-landlet
    // directly and never becomes its own candidate.
    const centralIndex = predicted.cells.findIndex((cell) => pointInPolygon({ x: 0, y: 0 }, cell.polygon));
    const nonCentralIndex = centralIndex === 0 ? 1 : 0;
    const biomeCenter = predicted.cells[nonCentralIndex].center;
    await seedBiomeCell(biomeCenter.x, biomeCenter.y, 'alpine', 25);

    const generated = await api('/land-candidates/generate-mosaic', adminSession({
      method: 'POST',
      body: JSON.stringify({ prefix: 'biome-mosaic-test', count: 16 }),
    }));
    expect(generated.response.status).toBe(201);
    const expectedId = `biome-mosaic-test-${String(nonCentralIndex + 1).padStart(3, '0')}`;
    const byId = Object.fromEntries(generated.body.candidates.map((candidate) => [candidate.landletId, candidate]));
    expect(byId[expectedId].biome).toBe('alpine');
  });
});
