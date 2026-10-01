// #1085: owner's decision, 2026-10-01 -- scheduled()'s automatic
// world-growth job should prefer the organic mosaic generator over the
// legacy ring generator whenever mosaic is still available (the world is
// still fresh enough that nothing has claimed its origin-centered disc
// yet), falling back to ring generation only once mosaic is unavailable.
//
// A dedicated, freshly-migrated D1 instance (rather than reusing
// worker-api.test.js's own shared instance, heavily mutated by dozens of
// other tests by the time any world-growth test runs) is what actually
// lets "the world is still fresh" be exercised deterministically: a fresh
// world's greenbelt disc around the origin has nothing else in it yet.
import {
  applyD1Migrations, env, createExecutionContext, createScheduledController, waitOnExecutionContext,
} from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from './index.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe('scheduled() automatic world growth prefers mosaic over ring (#1085)', () => {
  it('generates an organic mosaic instead of a ring on a fresh world', async () => {
    // A ratio of 1 can never actually be satisfied (it would require every
    // landlet in the table to be greenbelt) -- same trick worker-api.test.js's
    // own autoGrowWorldIfNeeded tests use to guarantee Phase 2 fires.
    // A fresh world has only starter-landlet, already greenbelt -- ratio is
    // trivially 1/1 = 1, which already satisfies even an unmet-looking
    // threshold of exactly 1. Diluting with one extra non-greenbelt,
    // not-yet-generated landlet (excluded from Phase 1's own enclosure
    // loop, which requires generated_at NOT NULL) is what actually makes
    // the ratio unsatisfiable and forces Phase 2 to run, without engaging
    // Phase 1's expansion logic first.
    await env.DB.prepare(`
      INSERT INTO landlets (landlet_id, name, status) VALUES ('dilution-landlet', 'Dilution landlet', 'generating')
    `).run();
    await env.DB.prepare(
      `UPDATE world_settings SET greenbelt_min_ratio = 1 WHERE world_id = 'default-world'`,
    ).run();

    const controller = createScheduledController();
    const ctx = createExecutionContext();
    await worker.scheduled(controller, env, ctx);
    await waitOnExecutionContext(ctx);

    // 16 cells minus the one folded into starter-landlet directly.
    const mosaicCandidates = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM landlet_candidates WHERE landlet_id LIKE 'auto-mosaic-%'`,
    ).first();
    expect(mosaicCandidates.count).toBe(15);

    const starter = await env.DB.prepare(
      `SELECT metadata_json FROM landlets WHERE landlet_id = 'starter-landlet'`,
    ).first();
    expect(JSON.parse(starter.metadata_json).generator).toBe('organic-mosaic-v1');

    // Ring generation must not have run at all this tick -- mosaic being
    // available took priority over it entirely, not just a fallback that
    // happened to also succeed.
    const rings = await env.DB.prepare('SELECT COUNT(*) AS count FROM landlet_candidate_rings').first();
    expect(rings.count).toBe(0);

    // Never logged as an admin action -- scheduled() runs unauthenticated,
    // same invariant the manual generate-mosaic endpoint's own admin-log
    // write depends on an actual admin session for.
    const mosaicLog = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM admin_action_log WHERE action_type = 'generate_mosaic'`,
    ).first();
    expect(mosaicLog.count).toBe(0);
  }, 15000);

  it('falls back to ring generation on a later tick, once mosaic is already used up', async () => {
    // generate-mosaic's own disc is always the same origin-centered area,
    // so the previous test's successful run makes every later attempt hit
    // its duplicate-prefix guard immediately -- this is the self-limiting
    // behavior generateAutoMosaicIfFreshWorld's own comment describes, not
    // something this test needs to engineer separately.
    const controller = createScheduledController();
    const ctx = createExecutionContext();
    await worker.scheduled(controller, env, ctx);
    await waitOnExecutionContext(ctx);

    const rings = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM landlet_candidate_rings WHERE ring_id LIKE 'auto-ring-%'`,
    ).first();
    expect(rings.count).toBeGreaterThan(0);

    // No second mosaic attempt ever landed anything new.
    const mosaicCandidates = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM landlet_candidates WHERE landlet_id LIKE 'auto-mosaic-%'`,
    ).first();
    expect(mosaicCandidates.count).toBe(15);

    await env.DB.prepare(
      `UPDATE world_settings SET greenbelt_min_ratio = 0.1 WHERE world_id = 'default-world'`,
    ).run();
  }, 15000);
});
