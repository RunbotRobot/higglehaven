// #1135: production D1 has no backup anywhere outside Cloudflare's own
// copy. Covers buildDatabaseBackup (the pure dump-shape half),
// backupDatabaseToR2 (the R2 put + retention side), and
// pruneOldDatabaseBackups directly.
import {
  applyD1Migrations, env, createExecutionContext, createScheduledController, waitOnExecutionContext,
} from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import worker, { backupDatabaseToR2, buildDatabaseBackup, pruneOldDatabaseBackups } from './index.js';
import { signupBuilder } from './test-helpers.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe('buildDatabaseBackup (#1135)', () => {
  it('includes real rows from a real table, and excludes sqlite/d1 bookkeeping tables', async () => {
    const builder = await signupBuilder('db-backup-contents');

    const dump = await buildDatabaseBackup(env.DB);

    expect(typeof dump.generatedAt).toBe('string');
    expect(Array.isArray(dump.tables.builders)).toBe(true);
    expect(dump.tables.builders.some((row) => row.builder_id === builder.builderId)).toBe(true);
    expect(dump.tables.d1_migrations).toBeUndefined();
    expect(Object.keys(dump.tables).some((name) => name.startsWith('sqlite_'))).toBe(false);
  });
});

describe('backupDatabaseToR2 (#1135)', () => {
  it('is a no-op when the R2 binding is missing', async () => {
    await expect(backupDatabaseToR2({ DB: env.DB })).resolves.toBeUndefined();
  });

  it('writes a dump object to R2 under the backups/ prefix', async () => {
    await backupDatabaseToR2({ DB: env.DB, DB_BACKUPS: env.DB_BACKUPS });

    const listing = await env.DB_BACKUPS.list({ prefix: 'backups/' });
    expect(listing.objects.length).toBeGreaterThan(0);
    const object = await env.DB_BACKUPS.get(listing.objects[0].key);
    const parsed = JSON.parse(await object.text());
    expect(Array.isArray(parsed.tables.builders)).toBe(true);
  });
});

describe('pruneOldDatabaseBackups (#1135)', () => {
  it('keeps only the most recent 14 backups, deleting older ones', async () => {
    // Start from a clean slate -- an earlier test in this file may have
    // already written a real (today-dated) backup to this same bucket,
    // which would otherwise sort after every fake 2026-01-* key below and
    // throw off the exact set this test expects to survive.
    const existing = await env.DB_BACKUPS.list({ prefix: 'backups/' });
    if (existing.objects.length > 0) {
      await env.DB_BACKUPS.delete(existing.objects.map((object) => object.key));
    }

    for (let i = 0; i < 20; i++) {
      const stamp = `2026-01-${String(i + 1).padStart(2, '0')}T00-00-00-000Z`;
      await env.DB_BACKUPS.put(`backups/${stamp}.json`, '{}');
    }

    await pruneOldDatabaseBackups(env.DB_BACKUPS);

    const listing = await env.DB_BACKUPS.list({ prefix: 'backups/' });
    const keys = listing.objects.map((object) => object.key).sort();
    expect(keys.length).toBe(14);
    // The 14 most recent of the 20 seeded (day 07 through day 20) survive.
    expect(keys[0]).toBe('backups/2026-01-07T00-00-00-000Z.json');
    expect(keys[13]).toBe('backups/2026-01-20T00-00-00-000Z.json');
  });
});

// #1230: every other job in worker.scheduled() runs on every tick, but the
// backup above only runs when event.cron matches wrangler.jsonc's own daily
// '0 3 * * *' entry (worker/index.js's own comment on this `if`) -- the
// three sibling test files already calling worker.scheduled() all use
// createScheduledController()'s default (cron: ''), so nothing anywhere
// actually exercises this gate through the real entry point, in either
// direction.
describe('scheduled()\'s daily-backup cron gate (#1230)', () => {
  it('runs the backup through the real scheduled() entry point when event.cron matches the daily backup schedule', async () => {
    const before = await env.DB_BACKUPS.list({ prefix: 'backups/' });
    const beforeKeys = new Set(before.objects.map((object) => object.key));

    const controller = createScheduledController({ cron: '0 3 * * *' });
    const ctx = createExecutionContext();
    await worker.scheduled(controller, env, ctx);
    await waitOnExecutionContext(ctx);

    const after = await env.DB_BACKUPS.list({ prefix: 'backups/' });
    const newKeys = after.objects.map((object) => object.key).filter((key) => !beforeKeys.has(key));
    expect(newKeys.length).toBeGreaterThan(0);
  });

  it('does not run the backup on an ordinary, non-daily-backup cron tick', async () => {
    const before = await env.DB_BACKUPS.list({ prefix: 'backups/' });
    const beforeCount = before.objects.length;

    // The shared '*/10 * * * *' tick every other scheduled() job already
    // runs on -- wrangler.jsonc's own first cron entry.
    const controller = createScheduledController({ cron: '*/10 * * * *' });
    const ctx = createExecutionContext();
    await worker.scheduled(controller, env, ctx);
    await waitOnExecutionContext(ctx);

    const after = await env.DB_BACKUPS.list({ prefix: 'backups/' });
    expect(after.objects.length).toBe(beforeCount);
  });
});
