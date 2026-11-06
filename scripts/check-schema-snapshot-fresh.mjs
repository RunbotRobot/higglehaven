#!/usr/bin/env node
// #3203: worker/schema-snapshot.json is generated (generate-schema-snapshot.mjs)
// but checked in; this fails `npm test` the moment it no longer matches what
// migrations/ produces -- the same guard check-migrations-manifest-fresh.mjs
// gives worker/migrations-manifest.json. Without it a new migration would make
// the Worker's daily checkSchemaDrift report every column the migration added
// as an out-of-band change.
import { readFileSync } from 'node:fs';
import { buildExpectedSnapshot } from './schema-snapshot-build.mjs';
import { MIGRATIONS_DIR, SNAPSHOT_PATH } from './generate-schema-snapshot.mjs';

function main() {
  let actual;
  try {
    actual = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'));
  } catch (error) {
    console.error(`Failed to read/parse ${SNAPSHOT_PATH}: ${error.message}`);
    console.error('Run `npm run generate:schema-snapshot` and commit the result.');
    process.exit(1);
  }
  const expected = buildExpectedSnapshot(MIGRATIONS_DIR);
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    console.error(
      'worker/schema-snapshot.json is stale -- it no longer matches the schema migrations/ produces. '
      + 'Run `npm run generate:schema-snapshot` and commit the result.',
    );
    process.exit(1);
  }
  console.log('worker/schema-snapshot.json is up to date.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
