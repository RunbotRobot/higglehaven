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
import { biomeAt } from './index.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

async function seedBiomeCell(x, y, biome, spacingM = 25) {
  await env.DB.prepare(`
    INSERT INTO geo_biome_cells (x_m, y_m, biome, spacing_m, generated_at) VALUES (?, ?, ?, ?, ?)
  `).bind(x, y, biome, spacingM, new Date().toISOString()).run();
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
