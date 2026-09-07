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
      // A single worker/*.test.js file shares one D1 instance across its
      // own tests (one instance per test *file*, not per test), so a file
      // with enough tests accumulates real data that can make ordinary,
      // lightweight queries intermittently miss vitest's default 5000ms
      // per-test timeout. This used to be the whole (6683-line) worker/
      // index.test.js at once — see #385, where its ever-growing single
      // shared D1 instance eventually crashed CI outright with "Maximum
      // call stack size exceeded" rather than just timing out, once total
      // suite size crossed some threshold. It's now split into several
      // files by domain (worker-api/land/profiles/commerce/reviews-auth,
      // sharing worker/test-helpers.js) so each gets its own fresh
      // instance and the accumulation resets at every file boundary —
      // but the raised timeout stays as a global default rather than a
      // scattered per-test override, since a single busy file can still
      // reasonably approach it (one test already carries its own explicit
      // 20000ms override for a genuinely separate reason — a 40-request
      // concurrent burst — this matches that same value for consistency).
      testTimeout: 20000,
    },
  };
});
