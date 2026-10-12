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

  // #1452: without migration_drift_alert_state (migrations/0115), this
  // cron-driven alert email would re-fire on every */10 tick for as long
  // as the drift goes unfixed — asserted here against the dedup table's
  // own state, not a sendEmail spy, since sendEmail itself isn't exported
  // and already safely no-ops in this test env (no RESEND_API_KEY).
  it('#1452: alerts at most once per drift episode, then re-arms once drift resolves', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const row = await env.DB.prepare('SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1').first();
    await env.DB.prepare('DELETE FROM d1_migrations WHERE name = ?').bind(row.name).run();
    const envWithAlert = { ...env, OPS_ALERT_EMAIL: 'ops@example.com' };
    try {
      await checkMigrationDrift(envWithAlert);
      const first = await env.DB.prepare(
        'SELECT alerted_at FROM migration_drift_alert_state WHERE id = 1',
      ).first();
      expect(first.alerted_at).not.toBeNull();

      // Drift is still present on this second tick — must not re-stamp
      // (and, in production, must not re-send) the same alert.
      await checkMigrationDrift(envWithAlert);
      const second = await env.DB.prepare(
        'SELECT alerted_at FROM migration_drift_alert_state WHERE id = 1',
      ).first();
      expect(second.alerted_at).toBe(first.alerted_at);
    } finally {
      await env.DB.prepare(
        'INSERT INTO d1_migrations (name, applied_at) VALUES (?, ?)',
      ).bind(row.name, new Date().toISOString()).run();
    }

    // Drift is now resolved — the next tick should clear the flag so a
    // future, unrelated drift episode alerts fresh rather than staying
    // permanently silenced by this episode's stale row.
    await checkMigrationDrift(envWithAlert);
    const cleared = await env.DB.prepare(
      'SELECT alerted_at FROM migration_drift_alert_state WHERE id = 1',
    ).first();
    expect(cleared.alerted_at).toBeNull();
  });

  // #1688: the claim above (alerted_at set) used to commit independently of
  // whether the send itself actually succeeds — a transient Resend failure
  // left the guard permanently claimed for the rest of the drift episode,
  // with no further alert ever going out. RESEND_API_KEY must be
  // temporarily configured (same approach as worker/reviews-auth.test.js's
  // "still returns a session when the verification email's fetch rejects
  // outright") to make sendEmail actually attempt its fetch instead of
  // short-circuiting the way every other test in this file relies on.
  it('#1688: re-arms (rather than permanently silencing) when the alert email send itself fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const originalFetch = globalThis.fetch;
    env.RESEND_API_KEY = 'test-resend-api-key';
    globalThis.fetch = async (input, ...rest) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url === 'https://api.resend.com/emails') throw new TypeError('network error');
      return originalFetch(input, ...rest);
    };
    const row = await env.DB.prepare('SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1').first();
    await env.DB.prepare('DELETE FROM d1_migrations WHERE name = ?').bind(row.name).run();
    const envWithAlert = { ...env, OPS_ALERT_EMAIL: 'ops@example.com' };
    try {
      await checkMigrationDrift(envWithAlert);
      const afterFailedSend = await env.DB.prepare(
        'SELECT alerted_at FROM migration_drift_alert_state WHERE id = 1',
      ).first();
      expect(afterFailedSend.alerted_at).toBeNull();

      // Drift is still present and unresolved — a real fix would have
      // sendEmail succeed on the retry (the point of re-arming at all).
      // Mocked as a successful Resend response rather than restoring the
      // real fetch, since this test-pool-workers environment has no real
      // network access to actually reach api.resend.com.
      globalThis.fetch = async (input, ...rest) => {
        const url = typeof input === 'string' ? input : input.url;
        if (url === 'https://api.resend.com/emails') return new Response(JSON.stringify({ id: 'test-email-id' }), { status: 200 });
        return originalFetch(input, ...rest);
      };
      await checkMigrationDrift(envWithAlert);
      const afterRetry = await env.DB.prepare(
        'SELECT alerted_at FROM migration_drift_alert_state WHERE id = 1',
      ).first();
      expect(afterRetry.alerted_at).not.toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
      env.RESEND_API_KEY = undefined;
      await env.DB.prepare(
        'INSERT INTO d1_migrations (name, applied_at) VALUES (?, ?)',
      ).bind(row.name, new Date().toISOString()).run();
      await env.DB.prepare(
        `UPDATE migration_drift_alert_state SET alerted_at = NULL WHERE id = 1`,
      ).run();
    }
  });
});
