// #2811 (sub-issue of #2806, itself sub-issue of #2804): water-aware
// generation built on top of #2810's weighted-Voronoi core, reading real
// geo_water_cells_fine (#2805) data -- still empty in production pending
// the NHD-service outage noted on #2805's own follow-up, so this tests
// against synthetic seeded rows, per #2811's own text ("don't block this
// work on that specific blocker").
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { polygonsOverlap } from '../geometry.js';
import { discBoundary, polygonArea } from '../weightedVoronoiGenerator.js';
import { fetchWaterBlobs, generateWaterAwareMosaic, PREDOMINANTLY_WATER_THRESHOLD } from './water-aware-mosaic.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const SPACING_M = 5;

async function seedFineWaterGrid(originX, originY, cellsWide, spacingM = SPACING_M) {
  const now = new Date().toISOString();
  for (let i = 0; i < cellsWide; i += 1) {
    for (let j = 0; j < cellsWide; j += 1) {
      // eslint-disable-next-line no-await-in-loop -- test setup, small fixed grid
      await env.DB.prepare(`
        INSERT INTO geo_water_cells_fine (x_m, y_m, spacing_m, generated_at) VALUES (?, ?, ?, ?)
      `).bind(originX + i * spacingM, originY + j * spacingM, spacingM, now).run();
    }
  }
}

describe('fetchWaterBlobs (#2811)', () => {
  it('returns no blobs against an empty table', async () => {
    const boundary = discBoundary(50, 24);
    expect(await fetchWaterBlobs(env.DB, boundary)).toEqual([]);
  });

  it('clusters an adjacent grid of sample points into one blob', async () => {
    await seedFineWaterGrid(1000, 1000, 4); // 4x4 = 16 points, 5m apart
    const boundary = discBoundary(50, 24).map((point) => ({ x: point.x + 1010, y: point.y + 1010 }));
    const blobs = await fetchWaterBlobs(env.DB, boundary);
    expect(blobs).toHaveLength(1);
    expect(blobs[0].areaM2).toBeCloseTo(16 * SPACING_M * SPACING_M, 6);
    expect(blobs[0].x).toBeCloseTo(1000 + 1.5 * SPACING_M, 6);
    expect(blobs[0].y).toBeCloseTo(1000 + 1.5 * SPACING_M, 6);
  });

  it('keeps two far-apart clusters as separate blobs', async () => {
    await seedFineWaterGrid(2000, 2000, 2);
    await seedFineWaterGrid(2500, 2000, 2); // 500m away -- nowhere near clusterDistanceM
    const boundary = discBoundary(1000, 32).map((point) => ({ x: point.x + 2250, y: point.y + 2000 }));
    const blobs = await fetchWaterBlobs(env.DB, boundary);
    expect(blobs).toHaveLength(2);
  });

  it('never includes a sample point outside the given boundary', async () => {
    await seedFineWaterGrid(3000, 3000, 2);
    const tinyBoundaryFarAway = discBoundary(10, 16).map((point) => ({ x: point.x + 9000, y: point.y + 9000 }));
    expect(await fetchWaterBlobs(env.DB, tinyBoundaryFarAway)).toEqual([]);
  });
});

describe('generateWaterAwareMosaic (#2811)', () => {
  it('generates an all-buildable mosaic matching the boundary area when no water is seeded', async () => {
    const boundary = discBoundary(100, 32).map((point) => ({ x: point.x + 5000, y: point.y + 5000 }));
    const result = await generateWaterAwareMosaic(env.DB, { boundary, landletCount: 10, seed: 'no-water' });
    expect(result.waterBlobCount).toBe(0);
    expect(result.cells.every((cell) => cell.landType === 'buildable')).toBe(true);
    const sumAreas = result.cells.reduce((sum, cell) => sum + cell.areaM2, 0);
    expect(Math.abs(sumAreas - polygonArea(boundary)) / polygonArea(boundary)).toBeLessThanOrEqual(0.02);
    // #2812's own wiring needs landClass on every land cell to shape a
    // real candidate row (the free-self-claim landlet_class = 1 gate
    // depends on this being correct, not just present).
    expect(result.cells.every((cell) => Number.isInteger(cell.landClass) && cell.landClass >= 1)).toBe(true);
  });

  it('classifies a seeded water blob as its own water cell, and shrinks land cells\' total budget to compensate', async () => {
    const centerX = 6000;
    const centerY = 6000;
    await seedFineWaterGrid(centerX - 50, centerY - 50, 20); // a real, contiguous ~100m x 100m lake
    const boundary = discBoundary(300, 48).map((point) => ({ x: point.x + centerX, y: point.y + centerY }));
    const boundaryAreaM2 = polygonArea(boundary);

    const result = await generateWaterAwareMosaic(env.DB, { boundary, landletCount: 16, seed: 'one-lake' });
    expect(result.waterBlobCount).toBe(1);

    const waterCells = result.cells.filter((cell) => cell.landType === 'water');
    const landCells = result.cells.filter((cell) => cell.landType === 'buildable');
    expect(waterCells.length).toBeGreaterThanOrEqual(1);
    expect(landCells.length).toBeGreaterThan(0);
    expect(waterCells.every((cell) => cell.landClass === null)).toBe(true);
    expect(landCells.every((cell) => Number.isInteger(cell.landClass) && cell.landClass >= 1)).toBe(true);

    const totalWaterAreaM2 = waterCells.reduce((sum, cell) => sum + cell.areaM2, 0);
    const totalLandAreaM2 = landCells.reduce((sum, cell) => sum + cell.areaM2, 0);
    // The whole tiling (water + land) must still gap-freely cover the boundary...
    expect(Math.abs((totalWaterAreaM2 + totalLandAreaM2) - boundaryAreaM2) / boundaryAreaM2).toBeLessThanOrEqual(0.02);
    // ...and land's own share must be visibly reduced by the real lake's presence, not just
    // incidentally smaller -- it should track (boundary - lake), not boundary itself.
    const expectedLandBudget = boundaryAreaM2 - 20 * 20 * SPACING_M * SPACING_M;
    expect(Math.abs(totalLandAreaM2 - expectedLandBudget) / expectedLandBudget).toBeLessThanOrEqual(0.05);
  });

  it('never overlaps a land cell with the water cell carved out of the same tiling', async () => {
    const centerX = 7000;
    const centerY = 7000;
    await seedFineWaterGrid(centerX - 30, centerY - 30, 12);
    const boundary = discBoundary(250, 48).map((point) => ({ x: point.x + centerX, y: point.y + centerY }));

    const result = await generateWaterAwareMosaic(env.DB, { boundary, landletCount: 12, seed: 'no-overlap' });
    for (let i = 0; i < result.cells.length; i += 1) {
      for (let j = i + 1; j < result.cells.length; j += 1) {
        expect(polygonsOverlap(result.cells[i].polygon, result.cells[j].polygon)).toBe(false);
      }
    }
  });

  it('is deterministic for the same seed', async () => {
    const centerX = 8000;
    const centerY = 8000;
    await seedFineWaterGrid(centerX - 20, centerY - 20, 8);
    const boundary = discBoundary(200, 32).map((point) => ({ x: point.x + centerX, y: point.y + centerY }));

    const first = await generateWaterAwareMosaic(env.DB, { boundary, landletCount: 8, seed: 'determinism' });
    const second = await generateWaterAwareMosaic(env.DB, { boundary, landletCount: 8, seed: 'determinism' });
    expect(first.cells.map((cell) => [cell.center, cell.landType])).toEqual(second.cells.map((cell) => [cell.center, cell.landType]));
  });

  it('always classifies a fixed water-blob cell as water regardless of PREDOMINANTLY_WATER_THRESHOLD', async () => {
    const centerX = 9000;
    const centerY = 9000;
    await seedFineWaterGrid(centerX - 15, centerY - 15, 6);
    const boundary = discBoundary(150, 32).map((point) => ({ x: point.x + centerX, y: point.y + centerY }));

    const result = await generateWaterAwareMosaic(env.DB, {
      boundary, landletCount: 10, seed: 'threshold-check', waterThreshold: 0.999,
    });
    const waterCells = result.cells.filter((cell) => cell.landType === 'water');
    expect(waterCells.length).toBeGreaterThanOrEqual(1);
    expect(PREDOMINANTLY_WATER_THRESHOLD).toBeGreaterThan(0);
    expect(PREDOMINANTLY_WATER_THRESHOLD).toBeLessThan(1);
  });
});
