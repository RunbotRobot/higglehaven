import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');

  return {
    plugins: [
      cloudflareTest({
        main: './worker/index.js',
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          // A fixed, known secret so the test suite can exercise admin-
          // gated endpoints (see migrations/0055_admin_role.sql,
          // handleAdminBootstrap) without ever configuring a real one —
          // same "test env gets its own deterministic value" reasoning
          // this config already uses for TEST_MIGRATIONS.
          bindings: { TEST_MIGRATIONS: migrations, ADMIN_BOOTSTRAP_SECRET: 'test-admin-bootstrap-secret' },
        },
      }),
    ],
    test: {
      // src/**/*.test.js is for genuinely dependency-free frontend
      // modules only — nothing importing three.js or touching the DOM
      // belongs here, since this pool runs the workerd runtime, not a
      // browser; that kind of frontend code stays covered by e2e/
      // (Playwright) or manual verification instead, per this project's
      // established convention (see docs/API.md).
      include: ['worker/**/*.test.js', 'src/**/*.test.js'],
      // worker/index.test.js shares one D1 instance across its entire,
      // ever-growing set of tests (one instance per test *file*, not per
      // test) — by the time a test near the file's tail runs, hundreds of
      // prior tests' setup have accumulated enough real data that even
      // ordinary, lightweight queries intermittently miss vitest's default
      // 5000ms per-test timeout (nearby passing tests already clock
      // 4000-4700ms). This is whole-suite degradation as the file grows,
      // not a cost problem with any specific test, so it's fixed here
      // globally rather than as scattered per-test overrides (one test
      // already carries its own explicit 20000ms override for a genuinely
      // separate reason — a 40-request concurrent burst — this matches
      // that same value for consistency).
      testTimeout: 20000,
    },
  };
});
