#!/usr/bin/env node
// #3203: writes worker/schema-snapshot.json -- the normalized schema a fresh
// apply of migrations/ produces -- which the Worker's daily checkSchemaDrift
// (worker/lib/schema-drift.js) compares production against. Run via
// `npm run generate:schema-snapshot`; wired into `deploy`/`deploy:ci` next to
// the migrations manifest, and kept honest by scripts/check-schema-snapshot-
// fresh.mjs (a `pretest` check), so adding a migration without regenerating
// this fails CI instead of silently making the daily check cry wolf.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildExpectedSnapshot } from './schema-snapshot-build.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SNAPSHOT_PATH = join(repoRoot, 'worker', 'schema-snapshot.json');
export const MIGRATIONS_DIR = join(repoRoot, 'migrations');

function main() {
  const snapshot = buildExpectedSnapshot(MIGRATIONS_DIR);
  writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(`Wrote ${Object.keys(snapshot.tables).length} table(s) and ${Object.keys(snapshot.objects).length} index/trigger/view(s) to ${SNAPSHOT_PATH}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
