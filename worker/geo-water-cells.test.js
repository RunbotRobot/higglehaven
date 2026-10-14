// #2013 (sub-issue of #2012, following up on #1266): geo_water_cells
// (migrations/0128) is where a deployed Worker can actually read the real
// water-cell data scripts/ingest-geo-data.mjs produces -- Workers have no
// filesystem at request time to read that script's own JSON output
// directly. This covers isNearWaterCell, the one lookup against it. Not yet
// called from any generation path -- #2012's second sub-issue is what wires
// this into actual landlet generation.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { isNearWaterCell } from './index.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
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
