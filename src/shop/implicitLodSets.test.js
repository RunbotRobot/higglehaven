import { describe, expect, it } from 'vitest';
import { findImplicitSets, MAX_SET_RADIUS_M } from './implicitLodSets.js';

const brick = (x, y, z, key = 'brick') => ({ key, x, y, z, radiusM: 0.25 });
const wall = (columns, rows, key = 'brick', originX = 0) => {
  const items = [];
  for (let row = 0; row < rows; row++) for (let col = 0; col < columns; col++) items.push(brick(originX + col * 0.5, 0, row * 0.5 + 0.25, key));
  return items;
};
const sorted = (sets) => sets.map((s) => [...s].sort((a, b) => a - b)).sort((a, b) => a[0] - b[0]);

describe('findImplicitSets (#4063)', () => {
  it('a wall of touching bricks is one set', () => {
    const sets = findImplicitSets(wall(20, 5));
    expect(sets).toHaveLength(1);
    expect(sets[0]).toHaveLength(100);
  });

  it('a lone item is not a set, and two items far apart are two lone items', () => {
    expect(findImplicitSets([brick(0, 0, 0)])).toEqual([]);
    expect(findImplicitSets([brick(0, 0, 0), brick(40, 0, 0)])).toEqual([]);
  });

  it('items of different products do not join, even touching', () => {
    const sets = findImplicitSets([brick(0, 0, 0, 'a'), brick(0.5, 0, 0, 'b'), brick(1, 0, 0, 'a'), brick(1.5, 0, 0, 'b')]);
    expect(sets).toEqual([]);
  });

  it('a small gap still joins, a large one splits two walls apart', () => {
    const joined = findImplicitSets([...wall(4, 2), ...wall(4, 2, 'brick', 2.2)]); // 0.2 m gap between the walls
    expect(joined).toHaveLength(1);
    const apart = findImplicitSets([...wall(4, 2), ...wall(4, 2, 'brick', 10)]);
    expect(apart).toHaveLength(2);
  });

  it('a chain of neighbours is one set even when the ends are far apart', () => {
    const fence = [];
    for (let i = 0; i < 40; i++) fence.push(brick(i * 0.55, 0, 0.25));
    expect(findImplicitSets(fence)).toHaveLength(1);
  });

  it('the same wall bundled or loose gives the same members (this finds only the loose ones)', () => {
    const items = wall(30, 10);
    const sets = sorted(findImplicitSets(items));
    expect(sets).toHaveLength(1);
    expect(sets[0]).toEqual(items.map((_, i) => i));
  });

  it('a set wider than the limit is cut into cells, so a very long fence is not one decision', () => {
    const fence = [];
    for (let i = 0; i < 200; i++) fence.push(brick(i * 0.55, 0, 0.25)); // 110 m
    const sets = findImplicitSets(fence);
    expect(sets.length).toBeGreaterThan(1);
    for (const set of sets) {
      const xs = set.map((i) => fence[i].x);
      expect(Math.max(...xs) - Math.min(...xs)).toBeLessThanOrEqual(MAX_SET_RADIUS_M * 2);
    }
    expect(sets.flat().length).toBeGreaterThan(190);
  });

  it('works on a large loose wall fast (1,600 bricks)', () => {
    const items = wall(80, 20);
    const start = performance.now();
    const sets = findImplicitSets(items);
    expect(performance.now() - start).toBeLessThan(200);
    expect(sets).toHaveLength(1);
    expect(sets[0]).toHaveLength(1600);
  });
});
