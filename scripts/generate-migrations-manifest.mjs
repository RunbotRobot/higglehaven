#!/usr/bin/env node
// #499 (follow-up to #488/#492): the Worker's scheduled() cron can't shell
// out to `wrangler` or read the filesystem at request time, so it has no
// way to know what migrations/ *should* contain in order to compare against
// what's actually applied to production. This script bakes that expected
// list into the Worker bundle at build time as worker/migrations-manifest.json,
// which worker/index.js imports directly (esbuild/wrangler bundle JSON
// imports natively) and checkMigrationDrift() compares against a live
// `SELECT name FROM d1_migrations` on every cron tick.
//
// Usage: node scripts/generate-migrations-manifest.mjs
// Run via `npm run generate:migrations-manifest`, wired into `deploy` and
// `deploy:ci` so the bundled manifest can never go stale at deploy time.
// A `pretest` check (scripts/check-migrations-manifest-fresh.mjs) catches
// the case of a migration file added without regenerating it.
import { readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(repoRoot, 'migrations');
const manifestPath = join(repoRoot, 'worker', 'migrations-manifest.json');

// Exported for direct testing — see this file's own header for context.
export function listMigrationFiles(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

function main() {
  const manifest = listMigrationFiles(migrationsDir);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${manifest.length} migration name(s) to ${manifestPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
