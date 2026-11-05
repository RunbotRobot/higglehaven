import { applyD1Migrations, env } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  buildSchemaSnapshot, checkSchemaDrift, diffSchemaSnapshots, normalizeSql, readLiveSchemaSnapshot, SCHEMA_DRIFT_CARD_ID,
} from './lib/schema-drift.js';
import bundledSnapshot from './schema-snapshot.json';

// #3203 (Phase 2 of #805). Own file (own D1 isolate): it alters the schema.
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const snapshot = (columns, objects = []) => buildSchemaSnapshot(columns, objects);
const column = (tbl, col, type = 'TEXT', extra = {}) => ({ tbl, col, type, not_null: 0, dflt: null, pk: 0, ...extra });

describe('diffSchemaSnapshots (#3203)', () => {
  const expected = snapshot(
    [column('a', 'id', 'TEXT', { pk: 1 }), column('a', 'name'), column('b', 'id')],
    [{ type: 'index', name: 'idx_a_name', tbl: 'a', sql: 'CREATE INDEX idx_a_name ON a(name)' }],
  );

  it('reports nothing for an identical schema, ignoring column order and SQL whitespace', () => {
    const reordered = snapshot(
      [column('b', 'id'), column('a', 'name'), column('a', 'id', 'text', { pk: 1 })],
      [{ type: 'index', name: 'idx_a_name', tbl: 'a', sql: 'CREATE   INDEX idx_a_name\n  ON a(name)' }],
    );
    expect(diffSchemaSnapshots(expected, reordered)).toEqual([]);
  });

  it('reports a table, column, or index present only on one side', () => {
    const live = snapshot(
      [column('a', 'id', 'TEXT', { pk: 1 }), column('a', 'hotfix'), column('c', 'id')],
      [{ type: 'index', name: 'idx_hotfix', tbl: 'a', sql: 'CREATE INDEX idx_hotfix ON a(hotfix)' }],
    );
    expect(diffSchemaSnapshots(expected, live)).toEqual([
      'column a.hotfix exists in production but not in migrations/',
      'column a.name is missing in production',
      'table b is in migrations/ but missing in production',
      'table c exists in production but not in migrations/',
      'index idx_a_name is in migrations/ but missing in production',
      'index idx_hotfix exists in production but not in migrations/',
    ]);
  });

  it('reports a column whose type, nullability, default or key changed, and an index whose SQL changed', () => {
    const live = snapshot(
      [column('a', 'id', 'TEXT', { pk: 1 }), column('a', 'name', 'INTEGER', { not_null: 1, dflt: '0' }), column('b', 'id')],
      [{ type: 'index', name: 'idx_a_name', tbl: 'a', sql: 'CREATE UNIQUE INDEX idx_a_name ON a(name)' }],
    );
    const differences = diffSchemaSnapshots(expected, live);
    expect(differences).toHaveLength(2);
    expect(differences[0]).toMatch(/^column a\.name differs/);
    expect(differences[1]).toBe('index idx_a_name differs from migrations/');
  });

  it('normalizes SQL whitespace', () => {
    expect(normalizeSql('  CREATE\n\tTABLE   t  ')).toBe('CREATE TABLE t');
  });
});

describe('checkSchemaDrift against the real D1 (#3203)', () => {
  const card = () => env.DB.prepare('SELECT * FROM control_room_tasks WHERE task_id = ?').bind(SCHEMA_DRIFT_CARD_ID).first();

  it('finds no drift between the bundled snapshot and a fresh apply of migrations/ in D1', async () => {
    // The strongest false-positive guard: the snapshot is built with node:sqlite
    // in scripts/, and read here with D1's own SQLite.
    const live = await readLiveSchemaSnapshot(env.DB);
    expect(diffSchemaSnapshots(bundledSnapshot, live)).toEqual([]);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await checkSchemaDrift(env, { expected: bundledSnapshot })).toEqual([]);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(await card()).toBeNull();
  });

  it('raises one owner-waiting card (and one email) for an out-of-band change, then resolves it', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sendEmail = vi.fn(async () => true);
    const withEmail = { DB: env.DB, OPS_ALERT_EMAIL: 'ops@example.com' };

    await env.DB.prepare('ALTER TABLE users ADD COLUMN hotfix_column TEXT').run();
    const differences = await checkSchemaDrift(withEmail, { expected: bundledSnapshot, sendEmail });
    expect(differences).toEqual(['column users.hotfix_column exists in production but not in migrations/']);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('SCHEMA DRIFT DETECTED'));
    const raised = await card();
    expect(raised.status).toBe('queued');
    expect(raised.waiting_on).toBe('owner');
    expect(raised.note).toContain('users.hotfix_column');
    expect(sendEmail).toHaveBeenCalledTimes(1);

    // Still drifting on the next daily run: logged again, but no second card or email.
    await checkSchemaDrift(withEmail, { expected: bundledSnapshot, sendEmail });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM control_room_tasks WHERE task_id = ?').bind(SCHEMA_DRIFT_CARD_ID).first()).n).toBe(1);

    // Production catches up (here: the snapshot now includes the column) and the card resolves itself.
    const live = await readLiveSchemaSnapshot(env.DB);
    expect(await checkSchemaDrift(withEmail, { expected: live, sendEmail })).toEqual([]);
    expect((await card()).status).toBe('done');

    // A later, separate episode re-opens the card and emails again.
    await checkSchemaDrift(withEmail, { expected: bundledSnapshot, sendEmail });
    expect((await card()).status).toBe('queued');
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });
});
