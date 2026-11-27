import { describe, expect, it } from 'vitest';
import { createD1Timing } from './d1-timing.js';

// A stand-in for the D1 binding: statements answer after a tick, batch only accepts what prepare gave.
function fakeDb() {
  const issued = new WeakSet();
  const db = {
    prepare(sql) {
      const statement = {
        sql,
        values: [],
        bind(...values) { const next = { ...statement, values, bind: statement.bind }; issued.add(next); return next; },
        async first() { await new Promise((r) => setTimeout(r, 5)); return { sql, values: this.values }; },
        async run() { await new Promise((r) => setTimeout(r, 5)); return { success: true, meta: { rows_read: 3 } }; },
        async all() { await new Promise((r) => setTimeout(r, 5)); return { results: [{ sql, values: this.values, n: 7 }], meta: { rows_read: 4 } }; },
        async raw() { return []; },
      };
      issued.add(statement);
      return statement;
    },
    async batch(statements) {
      for (const s of statements) if (!issued.has(s)) throw new Error('batch got a statement D1 did not make');
      return statements.map(() => ({ success: true, meta: { rows_read: 2 } }));
    },
    async exec() { return { count: 1 }; },
    name: 'fake',
  };
  return db;
}

describe('createD1Timing (#3464)', () => {
  it('counts each trip and still returns what D1 returned', async () => {
    const timing = createD1Timing();
    const db = timing.wrap(fakeDb());
    const row = await db.prepare('SELECT 1').bind('a').first();
    expect(row).toMatchObject({ sql: 'SELECT 1', values: ['a'] });
    await db.prepare('UPDATE t SET x = 1').run();
    expect(timing.stats.trips).toBe(2);
    expect(timing.stats.ms).toBeGreaterThanOrEqual(0);
    expect(timing.header()).toMatch(/^d1;dur=\d+;desc="2 trips", d1rows;dur=0;desc="7 rows read"$/);
  });

  it('sums the rows D1 says it read: first, all, run and a whole batch (#4542)', async () => {
    const timing = createD1Timing();
    const db = timing.wrap(fakeDb());
    await db.prepare('SELECT 1').first(); // 4 (answered through all, so it can be counted)
    await db.prepare('SELECT 2').all(); // 4
    await db.prepare('UPDATE t').run(); // 3
    await db.batch([db.prepare('a'), db.prepare('b')]); // 2 + 2
    expect(timing.stats.rowsRead).toBe(15);
    expect(timing.header()).toContain('"15 rows read"');
  });

  it('first(column) still returns that column, and a missing one still throws', async () => {
    const db = createD1Timing().wrap(fakeDb());
    expect(await db.prepare('SELECT n').first('n')).toBe(7);
    await expect(db.prepare('SELECT n').first('nope')).rejects.toThrow(/No such column/);
  });

  it('counts a batch once and hands D1 its own statements', async () => {
    const timing = createD1Timing();
    const db = timing.wrap(fakeDb());
    const results = await db.batch([db.prepare('INSERT a').bind(1), db.prepare('INSERT b').bind(2)]);
    expect(results).toHaveLength(2);
    expect(timing.stats.trips).toBe(1);
    expect(timing.header()).toContain('1 trip"');
  });

  it('passes other properties through and counts exec as a trip', async () => {
    const timing = createD1Timing();
    const db = timing.wrap(fakeDb());
    expect(db.name).toBe('fake');
    await db.exec('SELECT 1');
    expect(timing.stats.trips).toBe(1);
  });

  it('says zero trips when nothing was asked of D1', () => {
    expect(createD1Timing().header()).toBe('d1;dur=0;desc="0 trips", d1rows;dur=0;desc="0 rows read"');
  });
});
