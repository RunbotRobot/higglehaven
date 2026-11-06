// #3203: builds the expected schema snapshot by applying migrations/ (in
// filename order, the order D1 applies them) to a throwaway in-memory SQLite
// database and reading it with the very same queries the Worker runs against
// production (worker/lib/schema-drift.js). Shared by the generator and the
// pretest freshness check. Uses node:sqlite, so it is Node-only -- never import
// this from the Worker or from a vitest test (the workerd pool has no
// node:sqlite).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildSchemaSnapshot, SCHEMA_COLUMNS_SQL, SCHEMA_OBJECTS_SQL } from '../worker/lib/schema-drift.js';

export function buildExpectedSnapshot(migrationsDir) {
  const database = new DatabaseSync(':memory:');
  try {
    const files = readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort();
    for (const file of files) {
      try {
        database.exec(readFileSync(join(migrationsDir, file), 'utf8'));
      } catch (error) {
        throw new Error(`migration ${file} failed to apply to a scratch SQLite database: ${error.message}`);
      }
    }
    return buildSchemaSnapshot(
      database.prepare(SCHEMA_COLUMNS_SQL).all(),
      database.prepare(SCHEMA_OBJECTS_SQL).all(),
    );
  } finally {
    database.close();
  }
}
