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
import { execFileSync } from 'node:child_process';

const NO_PENDING_MARKER = 'No migrations to apply!';

// Exported for direct testing against captured wrangler output — see this
// file's own header comment for where those captures came from.
export function hasPendingMigrations(wranglerOutput) {
  return !wranglerOutput.includes(NO_PENDING_MARKER);
}

function main() {
  let output;
  try {
    output = execFileSync(
      'npx',
      ['wrangler', 'd1', 'migrations', 'list', 'higglehaven-db', '--remote'],
      { encoding: 'utf8' },
    );
  } catch (error) {
    // wrangler itself failing to run (auth, network, a genuine CLI error) is
    // just as much a reason to stop as drift is — surface its own output
    // rather than swallowing it.
    console.error('Failed to run `wrangler d1 migrations list --remote`:');
    console.error(error.stdout || error.message);
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
