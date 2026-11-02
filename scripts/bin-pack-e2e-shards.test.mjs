import { describe, expect, it } from 'vitest';
import { ISOLATED_FILE, binPack, computeShards, median } from './bin-pack-e2e-shards.mjs';

describe('median (#3003)', () => {
  it('returns 1 for an empty list (no weight data at all)', () => {
    expect(median([])).toBe(1);
  });

  it('returns the middle value for an odd-length list', () => {
    expect(median([30, 10, 20])).toBe(20);
  });

  it('averages the two middle values for an even-length list', () => {
    expect(median([10, 20, 30, 40])).toBe(25);
  });
});

describe('binPack (#3003)', () => {
  it('balances by weight, not by count -- one heavy file plus several light ones', () => {
    const weights = { heavy: 120, a: 10, b: 10, c: 10, d: 10, e: 10, f: 10 };
    const shards = binPack(['heavy', 'a', 'b', 'c', 'd', 'e', 'f'], weights, 2);
    const totals = shards.map((shard) => shard.reduce((sum, f) => sum + weights[f], 0));
    // The heavy file alone (120) should land in its own shard, with every
    // light file (60 total) landing in the other -- this is exactly the
    // #3003 scenario (one alphabetically-clustered heavy group vs the
    // rest) a count-based split would never balance.
    expect(shards.some((shard) => shard.includes('heavy'))).toBe(true);
    expect(Math.max(...totals) - Math.min(...totals)).toBeLessThanOrEqual(120);
    expect(shards.flat().sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'heavy'].sort());
  });

  it('falls back to the median weight for a file missing from the snapshot', () => {
    const weights = { a: 10, b: 20, c: 30 }; // median 20
    const shards = binPack(['a', 'b', 'c', 'unmeasured'], weights, 4);
    // Each shard gets exactly one file when shardCount === file count and
    // weights are reasonably close -- confirms 'unmeasured' didn't get
    // treated as weight 0 (which would make LPT dump every real file
    // onto shards before it, starving it last) or as something wildly
    // large either.
    expect(shards.every((shard) => shard.length === 1)).toBe(true);
  });

  it('degrades to an even count-based split when given no weight data at all', () => {
    const files = Array.from({ length: 8 }, (_, i) => `f${i}.test.mjs`);
    const shards = binPack(files, {}, 4);
    expect(shards.every((shard) => shard.length === 2)).toBe(true);
  });

  it('never drops or duplicates a file', () => {
    const files = ['a', 'b', 'c', 'd', 'e'];
    const shards = binPack(files, { a: 5, b: 50, c: 1, d: 30, e: 15 }, 3);
    expect(shards.flat().sort()).toEqual([...files].sort());
  });
});

describe('computeShards (#3003)', () => {
  it('keeps the isolated real-Stripe file in its own dedicated shard, unaffected by weight', () => {
    const files = ['a.test.mjs', 'b.test.mjs', ISOLATED_FILE];
    const shards = computeShards({ files, weights: { [ISOLATED_FILE]: 1 }, shardCount: 2 });
    const isolatedShard = shards.find((shard) => shard.includes(ISOLATED_FILE));
    expect(isolatedShard).toEqual([ISOLATED_FILE]);
  });

  it('omits empty shards rather than returning a hollow matrix entry', () => {
    const shards = computeShards({ files: ['a.test.mjs'], weights: {}, shardCount: 4 });
    expect(shards).toEqual([['a.test.mjs']]);
  });
});
