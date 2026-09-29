#!/usr/bin/env node
// #1021 (recurrence of #107): with N `higglehavenN` sessions racing on the
// same sequential migration-number convention, two branches independently
// picking the same next number is common, not rare — and nothing catches it
// until GitHub reports `mergeable_state: "dirty"` after the fact (as
// happened twice on PR #1017 alone). Run as `pretest` (see package.json),
// alongside check-migrations-manifest-fresh.mjs, so merging `main` into a
// branch that already has a same-numbered migration fails loudly and
// immediately via `npm test`, right at the point AGENTS.md already expects
// a "merge main in and resolve" step to happen.
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(repoRoot, 'migrations');

// Exported for direct testing — see this file's own header for context.
export function findMigrationNumberCollisions(filenames) {
  const byNumber = new Map();
  for (const name of filenames) {
    const match = name.match(/^(\d+)_/);
    if (!match) continue;
    const number = match[1];
    if (!byNumber.has(number)) byNumber.set(number, []);
    byNumber.get(number).push(name);
  }

  return [...byNumber.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([number, names]) => ({ number, names: names.sort() }));
}

function main() {
  const filenames = readdirSync(migrationsDir).filter((name) => name.endsWith('.sql'));
  const collisions = findMigrationNumberCollisions(filenames);

  if (collisions.length > 0) {
    console.error('Migration number collision(s) found in migrations/:');
    for (const { number, names } of collisions) {
      console.error(`  ${number}: ${names.join(', ')}`);
    }
    console.error(
      'Renumber all but one file in each group to the next free number, then run ' +
      '`npm run generate:migrations-manifest` and commit the result.',
    );
    process.exit(1);
  }

  console.log('No migration number collisions found.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
