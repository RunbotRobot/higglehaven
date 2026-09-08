import { describe, expect, it } from 'vitest';
import { hasPendingMigrations } from './check-migration-drift.mjs';

// #560: hasPendingMigrations was exported "for direct testing against
// captured wrangler output" per its own comment, but had no test anywhere —
// these are the two real `wrangler d1 migrations list --remote` outputs
// referenced from #492's own issue body (captured by hand against a scratch
// D1, once with nothing pending and once with a deliberately partial
// migrations directory).
describe('hasPendingMigrations (#560)', () => {
  it('returns false for a real "nothing pending" wrangler output', () => {
    const output = `
┌────────────────────────────────┬────────┐
│ Name                           │ Status │
├────────────────────────────────┼────────┤
│ 0001_initial.sql                │ ✅     │
└────────────────────────────────┴────────┘
No migrations to apply!
`;
    expect(hasPendingMigrations(output)).toBe(false);
  });

  it('returns true for a real "migrations pending" wrangler output', () => {
    const output = `
Migrations to be applied:
┌──────────────────────────────┐
│ Name                         │
├──────────────────────────────┤
│ 0002_add_brick_template.sql   │
└──────────────────────────────┘
`;
    expect(hasPendingMigrations(output)).toBe(true);
  });

  it('returns true for empty output (a genuine "could not tell" case, not silently treated as clean)', () => {
    expect(hasPendingMigrations('')).toBe(true);
  });
});
