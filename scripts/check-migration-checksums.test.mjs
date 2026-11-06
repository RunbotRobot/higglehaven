import { describe, expect, it } from 'vitest';
import { compareChecksums } from './migration-checksums-lib.mjs';

// #805 phase 1: an already-applied migration edited after the fact must be
// flagged, not silently accepted.
describe('compareChecksums (#805)', () => {
  it('reports nothing when every file matches its pin', () => {
    expect(compareChecksums({ '0001_a.sql': 'h1', '0002_b.sql': 'h2' }, { '0001_a.sql': 'h1', '0002_b.sql': 'h2' }))
      .toEqual({ changed: [], missing: [], removed: [] });
  });

  it('flags a pinned migration whose content changed', () => {
    expect(compareChecksums({ '0001_a.sql': 'edited', '0002_b.sql': 'h2' }, { '0001_a.sql': 'h1', '0002_b.sql': 'h2' }))
      .toEqual({ changed: ['0001_a.sql'], missing: [], removed: [] });
  });

  it('flags a new migration with no pin, and a pin with no file', () => {
    expect(compareChecksums({ '0001_a.sql': 'h1', '0003_c.sql': 'h3' }, { '0001_a.sql': 'h1', '0002_b.sql': 'h2' }))
      .toEqual({ changed: [], missing: ['0003_c.sql'], removed: ['0002_b.sql'] });
  });
});
