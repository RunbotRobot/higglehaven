import { describe, expect, it } from 'vitest';
import { snapshotSize, snapshotRecord, snapshotUsable, SNAPSHOT_WIDTH_PX, SNAPSHOT_FRESH_MS } from './switchSnapshot.js';

describe('snapshotSize (#3873)', () => {
  it('keeps the canvas aspect at the snapshot width', () => {
    expect(snapshotSize(1170, 2532)).toEqual({ width: SNAPSHOT_WIDTH_PX, height: Math.round((SNAPSHOT_WIDTH_PX * 2532) / 1170) });
    expect(snapshotSize(1000, 500, 100)).toEqual({ width: 100, height: 50 });
  });
  it('is null for a canvas with no size, and never zero tall', () => {
    expect(snapshotSize(0, 800)).toBeNull();
    expect(snapshotSize(800, 0)).toBeNull();
    expect(snapshotSize(NaN, 800)).toBeNull();
    expect(snapshotSize(10000, 1, 10).height).toBe(1);
  });
});

describe('snapshotUsable (#3873)', () => {
  const url = 'data:image/jpeg;base64,AAAA';
  it('uses a fresh image record and nothing else', () => {
    expect(snapshotUsable(snapshotRecord(url, 1000), 1000 + SNAPSHOT_FRESH_MS)).toBe(true);
    expect(snapshotUsable(snapshotRecord(url, 1000), 1000 + SNAPSHOT_FRESH_MS + 1)).toBe(false);
    expect(snapshotUsable(null, 1000)).toBe(false);
    expect(snapshotUsable({ url: 'https://evil.example/x.png', at: 1000 }, 1000)).toBe(false);
    expect(snapshotUsable({ url: 'javascript:alert(1)', at: 1000 }, 1000)).toBe(false);
    expect(snapshotUsable({ at: 1000 }, 1000)).toBe(false);
  });
});
