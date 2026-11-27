// #4560: the shop polls GET /api/credit-orbs?landletId=... about once a second per person, and both of its
// queries filter on landlet_id. With only collected_at and spawned_at indexed, each call read every uncollected
// orb in the world (149 rows live). This pins that a call now reads about the asked-about landlet's rows only.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { handleCreditOrbs } from './lib/credit-orbs.js';
import { createD1Timing } from './lib/d1-timing.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const inserts = [];
  for (let i = 0; i < 200; i += 1) {
    inserts.push(env.DB.prepare('INSERT INTO credit_orbs (orb_id, landlet_id, x_m, y_m) VALUES (?, ?, 0, 0)').bind(`other-${i}`, `other-landlet-${i % 7}`));
  }
  for (let i = 0; i < 3; i += 1) {
    inserts.push(env.DB.prepare('INSERT INTO credit_orbs (orb_id, landlet_id, x_m, y_m) VALUES (?, ?, 0, 0)').bind(`mine-${i}`, 'read-cost-landlet'));
  }
  await env.DB.batch(inserts);
});

describe('GET /api/credit-orbs?landletId= read cost (#4560)', () => {
  it('both queries use the landlet index', async () => {
    for (const sql of [
      "SELECT orb_id FROM credit_orbs WHERE collected_at IS NULL AND landlet_id = 'x' ORDER BY spawned_at",
      "SELECT orb_id FROM credit_orbs WHERE landlet_id = 'x' AND collected_at >= '2026-01-01'",
    ]) {
      const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).all();
      expect(results.map((row) => row.detail).join(' ')).toContain('idx_credit_orbs_landlet_collected');
    }
  });

  it('a call reads the landlet\'s own rows, not every uncollected orb', async () => {
    const timing = createD1Timing();
    const db = timing.wrap(env.DB);
    const url = new URL('https://example.test/api/credit-orbs?landletId=read-cost-landlet');
    const response = await handleCreditOrbs(new Request(url), db, ['credit-orbs'], url);
    const body = await response.json();
    expect(body.orbs).toHaveLength(3);
    expect(timing.stats.rowsRead).toBeLessThan(20);
  });
});
