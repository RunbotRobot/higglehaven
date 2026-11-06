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
// #3210: the manifest is NOT committed (it is gitignored). Every PR that
// added a migration appended a line to the same end of one committed file, so
// any two such PRs conflicted and each conflict cost a full CI cycle. It is
// regenerated wherever it is consumed instead: `wrangler dev`/`deploy` (the
// `build.command` in wrangler.jsonc), vitest (vitest.config.js, at config
// load), and `pretest` (the Node-side import check). Run by hand with
// `npm run generate:migrations-manifest`.
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

// Exported so vitest.config.js can regenerate it at load without a subprocess.
export function writeMigrationsManifest() {
  const manifest = listMigrationFiles(migrationsDir);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, manifestPath };
}

function main() {
  const { manifest, manifestPath: written } = writeMigrationsManifest();
  console.log(`Wrote ${manifest.length} migration name(s) to ${written}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
