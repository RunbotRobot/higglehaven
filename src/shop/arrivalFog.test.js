import { describe, expect, it } from 'vitest';
import {
  ARRIVAL_CLUSTER_MAX_SPAN_M, ARRIVAL_FOG_RISE_S, ARRIVAL_MAX_ALIVE_FOGS,
  ARRIVAL_REDUCED_MOTION_FADE_S, ARRIVAL_RESOLVE_S,
  arrivalLevels, clusterArrivals, pickFogClusters,
} from './arrivalFog.js';

describe('clusterArrivals (#3405)', () => {
  it('makes one cluster of a whole placed bundle, however many members', () => {
    const wall = [];
    for (let i = 0; i < 829; i++) {
      wall.push({ id: `b${i}`, x: (i % 60) * 0.5, y: Math.floor(i / 60) * 0.5, groupId: 'wall' });
    }
    const clusters = clusterArrivals(wall);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].count).toBe(829);
    expect(clusters[0].ids).toHaveLength(829);
  });

  it('keeps two copies of one saved bundle apart: each placement has its own groupId', () => {
    const items = [
      { id: 'a1', x: 0, y: 0, groupId: 'g1', bundleId: 'B' },
      { id: 'a2', x: 1, y: 0, groupId: 'g1', bundleId: 'B' },
      { id: 'b1', x: 30, y: 0, groupId: 'g2', bundleId: 'B' },
      { id: 'b2', x: 31, y: 0, groupId: 'g2', bundleId: 'B' },
    ];
    const clusters = clusterArrivals(items);
    expect(clusters).toHaveLength(2);
    expect(clusters.map((c) => c.count)).toEqual([2, 2]);
  });

  it('groups scattered items by nearness and splits distant ones', () => {
    const items = [
      { id: 'p', x: 0, y: 0 }, { id: 'q', x: 2, y: 1 }, { id: 'r', x: 1, y: 3 },
      { id: 's', x: 40, y: 40 }, { id: 't', x: 41, y: 40 },
    ];
    const clusters = clusterArrivals(items);
    expect(clusters).toHaveLength(2);
    expect(clusters.map((c) => c.count).sort()).toEqual([2, 3]);
  });

  it('never lets a nearness cluster grow wider than the span limit', () => {
    // A long line of items 1 m apart: each is within the radius of the
    // running centre only for a while, so the line must break into pieces.
    const line = Array.from({ length: 60 }, (_, i) => ({ id: `l${i}`, x: i, y: 0 }));
    const clusters = clusterArrivals(line);
    expect(clusters.length).toBeGreaterThan(1);
    for (const c of clusters) {
      expect(c.box.maxX - c.box.minX).toBeLessThanOrEqual(ARRIVAL_CLUSTER_MAX_SPAN_M);
    }
    expect(clusters.reduce((n, c) => n + c.count, 0)).toBe(60);
  });

  it('does not merge nearby items of different bundles without a group', () => {
    const items = [
      { id: 'a', x: 0, y: 0, bundleId: 'X' }, { id: 'b', x: 1, y: 0, bundleId: 'Y' },
      { id: 'c', x: 2, y: 0 },
    ];
    expect(clusterArrivals(items)).toHaveLength(3);
  });

  it('is deterministic whatever order the instance list arrives in', () => {
    const items = [
      { id: 'a', x: 0, y: 0 }, { id: 'b', x: 2, y: 2 }, { id: 'c', x: 50, y: 50 },
      { id: 'd', x: 3, y: 1, groupId: 'g' }, { id: 'e', x: 4, y: 1, groupId: 'g' },
    ];
    const forward = clusterArrivals(items);
    const reversed = clusterArrivals([...items].reverse());
    expect(reversed).toEqual(forward);
  });

  it('centres the fog on the extent and pads it, counting item footprints', () => {
    const [c] = clusterArrivals([
      { id: 'a', x: 0, y: 0, halfWidth: 1, halfDepth: 0.5, groupId: 'g' },
      { id: 'b', x: 10, y: 0, halfWidth: 1, halfDepth: 0.5, groupId: 'g' },
    ]);
    expect(c.x).toBeCloseTo(5);
    expect(c.y).toBeCloseTo(0);
    expect(c.halfX).toBeGreaterThan(6); // half of the 12 m extent, plus a margin
    expect(c.halfY).toBeGreaterThan(0.5);
  });

  it('tolerates empty, missing and malformed input', () => {
    expect(clusterArrivals([])).toEqual([]);
    expect(clusterArrivals(undefined)).toEqual([]);
    const clusters = clusterArrivals([null, { id: 'ok', x: NaN, y: undefined }, { x: 1, y: 1 }]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].ids).toEqual(['ok']);
  });
});

describe('pickFogClusters (#3405)', () => {
  const clusters = Array.from({ length: 20 }, (_, i) => ({ key: `c${i}`, x: i * 10, y: 0 }));

  it('holds the cap and keeps the nearest clusters', () => {
    const { fogged, plain } = pickFogClusters(clusters, 0, { x: 0, y: 0 });
    expect(fogged).toHaveLength(ARRIVAL_MAX_ALIVE_FOGS);
    expect(plain).toHaveLength(20 - ARRIVAL_MAX_ALIVE_FOGS);
    expect(fogged[0].key).toBe('c0');
    expect(Math.max(...fogged.map((c) => c.x))).toBeLessThan(Math.min(...plain.map((c) => c.x)));
  });

  it('counts fogs already alive against the cap', () => {
    const { fogged } = pickFogClusters(clusters, ARRIVAL_MAX_ALIVE_FOGS - 2, { x: 0, y: 0 });
    expect(fogged).toHaveLength(2);
    expect(pickFogClusters(clusters, 99, { x: 0, y: 0 }).fogged).toHaveLength(0);
  });

  it('ranks by distance from the anchor, not by list order', () => {
    const { fogged } = pickFogClusters(clusters, ARRIVAL_MAX_ALIVE_FOGS - 1, { x: 190, y: 0 });
    expect(fogged.map((c) => c.key)).toEqual(['c19']);
  });
});

describe('arrivalLevels (#3405)', () => {
  it('fog rises first and the item stays invisible while it builds', () => {
    expect(arrivalLevels(0, null)).toEqual({ fog: 0, item: 0, done: false });
    const mid = arrivalLevels(ARRIVAL_FOG_RISE_S / 2, null);
    expect(mid.fog).toBeGreaterThan(0);
    expect(mid.fog).toBeLessThan(1);
    expect(mid.item).toBe(0);
    expect(arrivalLevels(ARRIVAL_FOG_RISE_S, null)).toEqual({ fog: 1, item: 0, done: false });
    // However long a cluster takes to build, the fog just holds.
    expect(arrivalLevels(30, null)).toEqual({ fog: 1, item: 0, done: false });
  });

  it('an item ready early still waits for the fog to have risen', () => {
    expect(arrivalLevels(ARRIVAL_FOG_RISE_S, 0).item).toBe(0);
    expect(arrivalLevels(ARRIVAL_FOG_RISE_S + ARRIVAL_RESOLVE_S / 2, 0).item).toBeGreaterThan(0);
  });

  it('resolves: item in, fog out, done at the end, all within the stated duration', () => {
    const ready = 2;
    const start = arrivalLevels(ready, ready);
    expect(start).toEqual({ fog: 1, item: 0, done: false });
    const half = arrivalLevels(ready + ARRIVAL_RESOLVE_S / 2, ready);
    expect(half.item).toBeGreaterThan(0.3);
    expect(half.item).toBeLessThan(0.7);
    expect(half.fog).toBeGreaterThan(0.3);
    expect(half.fog).toBeLessThan(0.7);
    expect(arrivalLevels(ready + ARRIVAL_RESOLVE_S, ready)).toEqual({ fog: 0, item: 1, done: true });
    expect(arrivalLevels(ready + 100, ready)).toEqual({ fog: 0, item: 1, done: true });
  });

  it('item opacity never decreases and fog never rises again once resolving', () => {
    const ready = 0.2;
    let prevItem = 0;
    let prevFog = Infinity;
    for (let t = ARRIVAL_FOG_RISE_S; t <= ARRIVAL_FOG_RISE_S + ARRIVAL_RESOLVE_S + 0.1; t += 0.02) {
      const { fog, item } = arrivalLevels(t, ready);
      expect(item).toBeGreaterThanOrEqual(prevItem - 1e-9);
      expect(fog).toBeLessThanOrEqual(prevFog + 1e-9);
      prevItem = item;
      prevFog = fog;
    }
  });

  it('reduced motion skips the fog and does a short plain fade', () => {
    const opts = { reducedMotion: true };
    expect(arrivalLevels(0, null, opts)).toEqual({ fog: 0, item: 0, done: false });
    expect(arrivalLevels(5, null, opts).fog).toBe(0);
    const half = arrivalLevels(1 + ARRIVAL_REDUCED_MOTION_FADE_S / 2, 1, opts);
    expect(half.fog).toBe(0);
    expect(half.item).toBeCloseTo(0.5);
    expect(arrivalLevels(1 + ARRIVAL_REDUCED_MOTION_FADE_S, 1, opts)).toEqual({ fog: 0, item: 1, done: true });
  });

  it('a cluster over the fog cap uses the same dissolve with no fog and no wait for it', () => {
    const opts = { fog: false };
    expect(arrivalLevels(1, null, opts)).toEqual({ fog: 0, item: 0, done: false });
    const half = arrivalLevels(0.5 + ARRIVAL_RESOLVE_S / 2, 0.5, opts);
    expect(half.fog).toBe(0);
    expect(half.item).toBeGreaterThan(0.3);
    expect(arrivalLevels(0.5 + ARRIVAL_RESOLVE_S, 0.5, opts)).toEqual({ fog: 0, item: 1, done: true });
  });

  it('treats negative, missing and non-finite times as the start', () => {
    expect(arrivalLevels(-3, null)).toEqual({ fog: 0, item: 0, done: false });
    expect(arrivalLevels(NaN, undefined)).toEqual({ fog: 0, item: 0, done: false });
  });
});
