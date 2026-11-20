import { describe, expect, it } from 'vitest';
import { groupIdOf, planSelectionBoxes, writeBoxEdges, BOX_EDGE_FLOATS, batchCapacity } from './selectionBoxes.js';

const mesh = (groupId) => ({ userData: { groupId } });

describe('planSelectionBoxes (#3324)', () => {
  it('draws nothing for an empty selection', () => {
    expect(planSelectionBoxes([])).toEqual([]);
  });

  it('draws one box for a selection that shares one groupId, however many members', () => {
    const members = Array.from({ length: 863 }, () => mesh('g1'));
    const plan = planSelectionBoxes(members);
    expect(plan).toHaveLength(1);
    expect(plan[0].key).toBe('g1');
    expect(plan[0].members).toHaveLength(863);
  });

  it('draws one box per loose item', () => {
    const a = mesh(null);
    const b = mesh(undefined);
    const c = { userData: {} };
    const plan = planSelectionBoxes([a, b, c]);
    expect(plan).toHaveLength(3);
    expect(plan.map((entry) => entry.key)).toEqual([a, b, c]);
    expect(plan.every((entry) => entry.members.length === 1)).toBe(true);
  });

  it('draws one box per bundle plus one per loose item for a mixed selection', () => {
    const loose = mesh(null);
    const plan = planSelectionBoxes([mesh('g1'), loose, mesh('g2'), mesh('g1'), mesh('g2'), mesh('g2')]);
    expect(plan.map((entry) => [entry.key === loose ? 'loose' : entry.key, entry.members.length])).toEqual([
      ['g1', 2],
      ['loose', 1],
      ['g2', 3],
    ]);
  });

  it('accepts any iterable (a Set, as the scene passes)', () => {
    const plan = planSelectionBoxes(new Set([mesh('g1'), mesh('g1')]));
    expect(plan).toHaveLength(1);
  });

  it('treats a missing userData as loose', () => {
    expect(groupIdOf({})).toBeNull();
    expect(groupIdOf(null)).toBeNull();
  });
});

describe('batched loose-item boxes (#3996)', () => {
  it('writes the twelve edges of a box, each from one corner to the next along one axis', () => {
    const out = new Float32Array(BOX_EDGE_FLOATS);
    const end = writeBoxEdges(out, 0, 0, 0, 0, 1, 2, 3);
    expect(end).toBe(BOX_EDGE_FLOATS);
    const edges = [];
    for (let i = 0; i < 24; i += 2) edges.push([[...out.slice(i * 3, i * 3 + 3)], [...out.slice(i * 3 + 3, i * 3 + 6)]]);
    expect(edges).toHaveLength(12);
    for (const [a, b] of edges) {
      const differing = [0, 1, 2].filter((k) => a[k] !== b[k]);
      expect(differing).toHaveLength(1); // an edge runs along exactly one axis
      for (let k = 0; k < 3; k += 1) expect([0, [1, 2, 3][k]]).toContain(a[k]); // on the box's faces only
    }
    const unique = new Set(edges.map(([a, b]) => `${a}|${b}`));
    expect(unique.size).toBe(12);
    // every one of the 8 corners is used by exactly 3 edges
    const corners = new Map();
    for (const [a, b] of edges) for (const c of [a, b]) corners.set(String(c), (corners.get(String(c)) || 0) + 1);
    expect(corners.size).toBe(8);
    expect([...corners.values()].every((n) => n === 3)).toBe(true);
  });

  it('writes at an offset and returns where the next box starts', () => {
    const out = new Float32Array(BOX_EDGE_FLOATS * 2);
    const next = writeBoxEdges(out, BOX_EDGE_FLOATS, -1, -1, -1, 1, 1, 1);
    expect(next).toBe(BOX_EDGE_FLOATS * 2);
    expect(out[0]).toBe(0);
    expect(Math.abs(out[BOX_EDGE_FLOATS])).toBe(1);
  });

  it('grows the batch by doubling and never shrinks it', () => {
    expect(batchCapacity(1)).toBe(64);
    expect(batchCapacity(65, 64)).toBe(128);
    expect(batchCapacity(1000, 64)).toBe(1024);
    expect(batchCapacity(10, 1024)).toBe(1024);
  });
});
