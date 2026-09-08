import { applyD1Migrations, env } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { checkMigrationDrift, computeMissingMigrations } from './index.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe('computeMissingMigrations (#499)', () => {
  it('returns nothing when every manifest entry is applied', () => {
    const applied = ['0001_initial.sql', '0002_add_brick_template.sql'];
    const manifest = ['0001_initial.sql', '0002_add_brick_template.sql'];
    expect(computeMissingMigrations(applied, manifest)).toEqual([]);
  });

  it('reports manifest entries missing from d1_migrations, in manifest order', () => {
    const applied = ['0001_initial.sql'];
    const manifest = ['0001_initial.sql', '0002_add_brick_template.sql', '0003_catalog_real_models.sql'];
    expect(computeMissingMigrations(applied, manifest)).toEqual([
      '0002_add_brick_template.sql',
      '0003_catalog_real_models.sql',
    ]);
  });

  it('does not flag drift for migrations applied but no longer in the manifest', () => {
    // Not the failure mode #488/#499 care about (production falling behind
    // main) — extra applied rows are harmless here, e.g. a squash/rename
    // that intentionally dropped an old filename from migrations/.
    const applied = ['0001_initial.sql', '0002_add_brick_template.sql'];
    const manifest = ['0001_initial.sql'];
    expect(computeMissingMigrations(applied, manifest)).toEqual([]);
  });

  it('treats an empty manifest and an empty applied set as no drift', () => {
    expect(computeMissingMigrations([], [])).toEqual([]);
  });
});

// #561: computeMissingMigrations above is the pure diffing helper, but
// checkMigrationDrift is the function actually wired into scheduled() and
// invoked every 10 minutes in production — the D1 query, the bundled
// migrations-manifest.json import, and the alert-email branch all lived
// with zero test coverage of their own until now, meaning a regression in
// any of them (e.g. a renamed column, a broken JSON import path) could
// silently stop the drift check from ever firing again in production with
// nothing here to catch it.
describe('checkMigrationDrift (#561)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports no drift when d1_migrations matches the real bundled manifest', async () => {
    // The test-pool D1 has every migrations/*.sql file applied via
    // applyD1Migrations above, and worker/migrations-manifest.json (what
    // checkMigrationDrift actually imports) is kept in sync with that same
    // directory by the pretest freshness check (scripts/check-migrations-
    // manifest-fresh.mjs) — so this is the real, currently-true happy path,
    // not a hand-built fixture.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await checkMigrationDrift(env);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('detects and loudly reports real drift when a migration is missing from d1_migrations', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const row = await env.DB.prepare('SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1').first();
    await env.DB.prepare('DELETE FROM d1_migrations WHERE name = ?').bind(row.name).run();
    try {
      await checkMigrationDrift(env);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('MIGRATION DRIFT DETECTED'));
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(row.name));
    } finally {
      // Restore the row rather than leaving this test-pool D1 instance
      // (shared across every test in this file) permanently missing it.
      await env.DB.prepare(
        'INSERT INTO d1_migrations (name, applied_at) VALUES (?, ?)',
      ).bind(row.name, new Date().toISOString()).run();
    }
  });

  it('does nothing when env.DB is absent, rather than throwing', async () => {
    await expect(checkMigrationDrift({})).resolves.toBeUndefined();
  });

  it('attempts (and safely no-ops) the alert-email path when drift is real and OPS_ALERT_EMAIL is set', async () => {
    // Test env never configures RESEND_API_KEY (see sendEmail's own
    // comment in worker/index.js), so sendEmail short-circuits to a no-op
    // rather than making a real network call — this just proves the branch
    // is reachable and doesn't throw, not that an email is actually sent.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const row = await env.DB.prepare('SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1').first();
    await env.DB.prepare('DELETE FROM d1_migrations WHERE name = ?').bind(row.name).run();
    try {
      await expect(checkMigrationDrift({ ...env, OPS_ALERT_EMAIL: 'ops@example.com' })).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('MIGRATION DRIFT DETECTED'));
    } finally {
      await env.DB.prepare(
        'INSERT INTO d1_migrations (name, applied_at) VALUES (?, ?)',
      ).bind(row.name, new Date().toISOString()).run();
    }
  });
});
