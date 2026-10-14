// #2013 (sub-issue of #2012, following up on #1266): geo_water_cells
// (migrations/0128) is where a deployed Worker can actually read the real
// water-cell data scripts/ingest-geo-data.mjs produces -- Workers have no
// filesystem at request time to read that script's own JSON output
// directly. This covers isNearWaterCell, the one lookup against it, plus
// (#2014) the two real generators that now consult it.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { isNearWaterCell } from './index.js';
import { generateLandletRing } from './landGenerator.js';
import { generateOrganicMosaic } from './organicLandGenerator.js';
import { pointInPolygon } from './geometry.js';
import { api, signupAdmin } from './test-helpers.js';

let adminSession;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const admin = await signupAdmin('geo-water-cells-admin');
  adminSession = admin.session;
});

async function seedWaterCell(x, y, spacingM = 25) {
  await env.DB.prepare(`
    INSERT INTO geo_water_cells (x_m, y_m, spacing_m, generated_at) VALUES (?, ?, ?, ?)
  `).bind(x, y, spacingM, new Date().toISOString()).run();
}

describe('isNearWaterCell (#2013)', () => {
  it('is false against an empty table', async () => {
    expect(await isNearWaterCell(env.DB, 0, 0)).toBe(false);
  });

  it('is true exactly on a seeded cell', async () => {
    await seedWaterCell(100, 200);
    expect(await isNearWaterCell(env.DB, 100, 200)).toBe(true);
  });

  it('is true within the cell\'s own spacing, false just beyond it', async () => {
    await seedWaterCell(500, 500, 25);
    expect(await isNearWaterCell(env.DB, 520, 500)).toBe(true); // 20m away, within 25m spacing
    expect(await isNearWaterCell(env.DB, 560, 500)).toBe(false); // 60m away, outside it
  });

  it('is false for a point far from every seeded cell', async () => {
    await seedWaterCell(-1000, -1000);
    expect(await isNearWaterCell(env.DB, 0, 0)).toBe(false);
  });
});

// #2014 (sub-issue of #2012): the real consumer of isNearWaterCell -- both
// production generation paths should upgrade a plot/cell to 'water' when a
// real ingested water cell sits at or near its center, and otherwise leave
// today's always-'buildable' behavior exactly as it was.
describe('Real water-cell data upgrades newly-generated landlets to water (#2014)', () => {
  it('upgrades a ring-generated plot to water when seeded near a real water cell, leaving the rest buildable', async () => {
    // Pure prediction of the exact geometry POST .../generate-ring will
    // produce for these same params -- generateLandletRing/powerLawPlots
    // are deterministic, so the plot's real center is knowable up front.
    const predicted = generateLandletRing({ prefix: 'water-ring-test', count: 4, innerRadiusM: 500, startAngleRad: 0 });
    const waterCenter = predicted.landlets[1].center;
    await seedWaterCell(waterCenter.x, waterCenter.y, 25);

    const generated = await api('/land-candidates/generate-ring', adminSession({
      method: 'POST',
      body: JSON.stringify({ prefix: 'water-ring-test', count: 4, innerRadiusM: 500, startAngleRad: 0 }),
    }));
    expect(generated.response.status).toBe(201);
    const byId = Object.fromEntries(generated.body.candidates.map((candidate) => [candidate.landletId, candidate]));
    expect(byId['water-ring-test-002'].landType).toBe('water');
    expect(byId['water-ring-test-001'].landType).toBe('buildable');
    expect(byId['water-ring-test-003'].landType).toBe('buildable');
    expect(byId['water-ring-test-004'].landType).toBe('buildable');
  });

  it('generates an all-buildable ring exactly as before when no water cell is seeded nearby', async () => {
    const generated = await api('/land-candidates/generate-ring', adminSession({
      method: 'POST',
      body: JSON.stringify({ prefix: 'buildable-ring-test', count: 4, innerRadiusM: 5000, startAngleRad: 0 }),
    }));
    expect(generated.response.status).toBe(201);
    for (const candidate of generated.body.candidates) {
      expect(candidate.landType).toBe('buildable');
    }
  });

  // One test, not two: generate-mosaic's disc is always centered at the
  // world origin regardless of prefix (only its rotation varies by seed),
  // so a second call in this same D1 instance always hits the real
  // "Generated mosaic would overlap existing land" guard -- the same
  // "inherently a one-time operation" constraint generateAutoMosaicIfFresh-
  // World's own comment describes. The unseeded cells' assertion below
  // covers the no-regression case within this one call instead.
  it('upgrades a mosaic-generated cell to water when seeded near a real water cell, leaving the rest buildable', async () => {
    const predictedCells = generateOrganicMosaic({ prefix: 'water-mosaic-test', count: 16 });
    // Same origin-exclusion logic generateLandletMosaicCandidates applies
    // internally -- the cell covering (0, 0) is folded into starter-landlet
    // directly and never becomes its own candidate, so the water cell must
    // land on a different one to actually show up in the response below.
    const centralIndex = predictedCells.findIndex((cell) => pointInPolygon(
      { x: 0, y: 0 },
      cell.polygon.map((point) => ({ x: point.x + cell.center.x, y: point.y + cell.center.y })),
    ));
    const nonCentralIndex = centralIndex === 0 ? 1 : 0;
    const waterCenter = predictedCells[nonCentralIndex].center;
    await seedWaterCell(waterCenter.x, waterCenter.y, 25);

    const generated = await api('/land-candidates/generate-mosaic', adminSession({
      method: 'POST',
      body: JSON.stringify({ prefix: 'water-mosaic-test', count: 16 }),
    }));
    expect(generated.response.status).toBe(201);
    const expectedId = `water-mosaic-test-${String(nonCentralIndex + 1).padStart(3, '0')}`;
    const byId = Object.fromEntries(generated.body.candidates.map((candidate) => [candidate.landletId, candidate]));
    expect(byId[expectedId].landType).toBe('water');
    const otherLandTypes = generated.body.candidates
      .filter((candidate) => candidate.landletId !== expectedId)
      .map((candidate) => candidate.landType);
    expect(otherLandTypes.every((landType) => landType === 'buildable')).toBe(true);
  });
});
