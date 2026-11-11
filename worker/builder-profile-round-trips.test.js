// #3464: getOrCreateBuilderForUser is on every builder-scoped route, so its
// D1 round trips are paid by all of them. Common case: one read.
import { describe, expect, it } from 'vitest';
import { getOrCreateBuilderForUser } from './lib/builder-profile.js';

function fakeDb(initialRow) {
  const calls = [];
  let row = initialRow;
  return {
    calls,
    prepare(sql) {
      return {
        bind() {
          return {
            async first() { calls.push(sql); return row; },
            async run() {
              calls.push(sql);
              if (/^INSERT OR IGNORE INTO builders/.test(sql)) row = { builder_id: 'builder-new', last_active_at: null };
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
}

const user = { user_id: 'u1', username: 'Someone' };
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

describe('getOrCreateBuilderForUser round trips (#3464)', () => {
  it('an active builder costs one read and no write', async () => {
    const db = fakeDb({ builder_id: 'b1', last_active_at: iso(5_000), inactivity_warning_sent_at: null });
    const row = await getOrCreateBuilderForUser(db, user);
    expect(row.builder_id).toBe('b1');
    expect(db.calls).toHaveLength(1);
  });

  it('a builder idle over a minute gets one read and one activity write', async () => {
    const db = fakeDb({ builder_id: 'b1', last_active_at: iso(120_000), inactivity_warning_sent_at: null });
    await getOrCreateBuilderForUser(db, user);
    expect(db.calls).toHaveLength(2);
    expect(db.calls[1]).toMatch(/UPDATE builders SET last_active_at/);
  });

  it('a pending inactivity warning is re-armed immediately', async () => {
    const db = fakeDb({ builder_id: 'b1', last_active_at: iso(1_000), inactivity_warning_sent_at: iso(10_000) });
    await getOrCreateBuilderForUser(db, user);
    expect(db.calls.some((c) => /inactivity_warning_sent_at = NULL/.test(c))).toBe(true);
  });

  it('a missing profile is created and returned', async () => {
    const db = fakeDb(null);
    const row = await getOrCreateBuilderForUser(db, user);
    expect(row.builder_id).toBe('builder-new');
    expect(db.calls.some((c) => /^INSERT OR IGNORE INTO builders/.test(c))).toBe(true);
  });
});
