#!/usr/bin/env node
// #492 (follow-up to #488): #488 documents a real 4-day production outage —
// `wrangler d1 migrations apply --remote` silently failed partway through a
// batch (a migration renamed after already being applied made wrangler try
// to re-run it, error, and abort everything alphabetically after it), and
// nothing caught the drift between production's schema and `main`'s
// `migrations/` directory until an owner bug report.
//
// The gap this closes: `wrangler d1 migrations list <db> --remote` already
// reports exactly this kind of drift (any migration file not yet applied to
// the target), but its exit code is always 0 regardless of whether anything
// is pending — confirmed by hand against a scratch local D1 with a
// deliberately partial migrations directory (see #492's issue body for the
// two captured outputs this parses). So a `&&`-chained script, or a session
// glancing at the exit code, sees success either way; only the *text* of the
// output distinguishes "nothing pending" from "N migrations never applied."
// This script is that missing check.
//
// Usage: node scripts/check-migration-drift.mjs
// Exits 0 with nothing pending, 1 (and a loud message) otherwise.
const NO_PENDING_MARKER = 'No migrations to apply!';

// Exported for direct testing against captured wrangler output — see this
// file's own header comment for where those captures came from.
export function hasPendingMigrations(wranglerOutput) {
  return !wranglerOutput.includes(NO_PENDING_MARKER);
}

async function main() {
  // Imported lazily, inside main(), rather than at module scope: this
  // module's own hasPendingMigrations is imported directly by scripts/
  // check-migration-drift.test.mjs (#560), which — like every other test
  // in this repo — runs under vitest-pool-workers' workerd runtime. A
  // top-level `node:child_process` import segfaults that runtime outright
  // (confirmed by hand) rather than raising a catchable error, even though
  // main() itself (the only thing that actually touches child_process) is
  // never called from a test.
  const { execFileSync } = await import('node:child_process');
  let output;
  try {
    output = execFileSync(
      'npx',
      ['wrangler', 'd1', 'migrations', 'list', 'higglehaven-db', '--remote'],
      // #562: this is a live network call (authenticates against
      // Cloudflare's API) with no default upper bound — an OAuth token
      // needing interactive re-consent, or a stalled API, otherwise hangs
      // this indefinitely with no output and no error, which is a more
      // confusing failure for whoever's running a real deploy by hand than
      // the drift this script exists to catch.
      { encoding: 'utf8', timeout: 60_000 },
    );
  } catch (error) {
    console.error('Failed to run `wrangler d1 migrations list --remote`:');
    if (error.signal === 'SIGTERM' && error.killed) {
      console.error('It timed out after 60s — check your network connection and Cloudflare API auth.');
    } else {
      console.error(error.stdout || error.message);
    }
    process.exit(1);
  }

  console.log(output);

  if (hasPendingMigrations(output)) {
    console.error(
      '\n🚨 CRITICAL: production D1 has migrations pending that `wrangler d1 ' +
      'migrations apply --remote` did not apply (see above). Do NOT deploy ' +
      'the Worker on top of this — deployed code and deployed schema are ' +
      'already out of sync. Investigate before doing anything else; see ' +
      'issue #488 for the last time this exact drift silently 500\'d every ' +
      'Shop-mode visitor for 4 days.',
    );
    process.exit(1);
  }

  console.log('✅ Production D1 has no pending migrations — safe to deploy.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
