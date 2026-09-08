#!/usr/bin/env node
// #499: worker/migrations-manifest.json is generated (see
// generate-migrations-manifest.mjs) rather than hand-maintained, but it's
// still a checked-in file — nothing stops a migration file from being
// added/renamed/removed without regenerating it, which would make
// checkMigrationDrift() in worker/index.js compare production against a
// stale list instead of what's actually on `main`. Run as `pretest` (see
// package.json) so CI fails loudly the moment the two go out of sync,
// rather than only discovering it in production the way #488 did.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listMigrationFiles } from './generate-migrations-manifest.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(repoRoot, 'migrations');
const manifestPath = join(repoRoot, 'worker', 'migrations-manifest.json');

function main() {
  const expected = listMigrationFiles(migrationsDir);
  let actual;
  try {
    actual = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    console.error(`Failed to read/parse ${manifestPath}: ${error.message}`);
    console.error('Run `npm run generate:migrations-manifest` and commit the result.');
    process.exit(1);
  }

  const expectedJson = JSON.stringify(expected);
  const actualJson = JSON.stringify(actual);
  if (expectedJson !== actualJson) {
    console.error(
      'worker/migrations-manifest.json is stale — it no longer matches migrations/. ' +
      'Run `npm run generate:migrations-manifest` and commit the result.',
    );
    console.error(`Expected: ${expectedJson}`);
    console.error(`Actual:   ${actualJson}`);
    process.exit(1);
  }

  console.log('worker/migrations-manifest.json is up to date.');
}

main();
