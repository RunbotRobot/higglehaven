#!/usr/bin/env node
// #805 (phase 1): the drift checks elsewhere compare migration *filenames*
// only, so editing an already-applied migration after the fact (a typo fix
// in the repo with no new migration) left every check green while the file
// and the production schema it built had diverged. This pins each
// migration's SHA-256 in a committed, append-only lock file
// (scripts/migration-checksums.json). Run as `pretest`, it fails when:
//   - an existing migration's content no longer matches its pinned hash
//     (the edited-after-the-fact case), or
//   - a migration has no pinned hash yet (run `npm run
//     generate:migration-checksums`, which only ever ADDS missing entries
//     and never rewrites an existing one), or
//   - the lock pins a file that no longer exists.
// Deliberately repo-side rather than a D1 table: deploys run from main, so a
// file whose content still matches its pin from the PR that added it is
// exactly what was applied. Changing a pin by hand is possible but shows up
// as an explicit lock-file edit in review. Phase 2 (diffing the live schema
// against a fresh apply) is tracked separately.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listMigrationFiles } from './generate-migrations-manifest.mjs';
import { compareChecksums } from './migration-checksums-lib.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(repoRoot, 'migrations');
const lockPath = join(repoRoot, 'scripts', 'migration-checksums.json');

export function hashMigration(dir, name) {
  return createHash('sha256').update(readFileSync(join(dir, name))).digest('hex');
}

export function computeChecksums(dir) {
  return Object.fromEntries(listMigrationFiles(dir).map((name) => [name, hashMigration(dir, name)]));
}

function readLock() {
  try {
    return JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

function main() {
  const current = computeChecksums(migrationsDir);
  const lock = readLock();
  if (process.argv.includes('--update')) {
    const { changed } = compareChecksums(current, lock);
    if (changed.length > 0) {
      console.error(`Refusing to update: already-pinned migration(s) were edited: ${changed.join(', ')}`);
      process.exit(1);
    }
    const next = { ...lock };
    for (const [name, hash] of Object.entries(current)) {
      if (!(name in next)) next[name] = hash;
    }
    const sorted = Object.fromEntries(Object.entries(next).sort(([a], [b]) => (a < b ? -1 : 1)));
    writeFileSync(lockPath, `${JSON.stringify(sorted, null, 2)}\n`);
    console.log(`Pinned ${Object.keys(sorted).length} migration checksum(s) in ${lockPath}`);
    return;
  }
  const { changed, missing, removed } = compareChecksums(current, lock);
  if (changed.length === 0 && missing.length === 0 && removed.length === 0) {
    console.log('Migration checksums match scripts/migration-checksums.json.');
    return;
  }
  if (changed.length > 0) {
    console.error(`An already-pinned migration was edited after the fact: ${changed.join(', ')}.`);
    console.error('Applied migrations are immutable: put the change in a new migration instead.');
  }
  if (missing.length > 0) {
    console.error(`Migration(s) with no pinned checksum: ${missing.join(', ')}.`);
    console.error('Run `npm run generate:migration-checksums` and commit the result.');
  }
  if (removed.length > 0) {
    console.error(`Pinned migration(s) no longer on disk: ${removed.join(', ')}.`);
  }
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
