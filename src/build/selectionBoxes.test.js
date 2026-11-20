import { describe, expect, it } from 'vitest';
import { groupIdOf, planSelectionBoxes, splitSelectionPlan, writeBoxEdges, BOX_EDGE_VERTICES, LOOSE_BATCH_MIN } from './selectionBoxes.js';

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

describe('splitSelectionPlan (#3996)', () => {
  it('leaves a small selection to draw its own boxes', () => {
    const plan = planSelectionBoxes(Array.from({ length: LOOSE_BATCH_MIN }, () => mesh(null)));
    const { batched, single } = splitSelectionPlan(plan);
    expect(batched).toEqual([]);
    expect(single).toHaveLength(LOOSE_BATCH_MIN);
  });

  it('draws many loose items together', () => {
    const plan = planSelectionBoxes(Array.from({ length: 1690 }, () => mesh(null)));
    const { batched, single } = splitSelectionPlan(plan);
    expect(batched).toHaveLength(1690);
    expect(single).toEqual([]);
  });

  it('keeps a bundle as its own box beside a batch of loose items', () => {
    const meshes = [...Array.from({ length: 20 }, () => mesh(null)), ...Array.from({ length: 50 }, () => mesh('wall'))];
    const { batched, single } = splitSelectionPlan(planSelectionBoxes(meshes));
    expect(batched).toHaveLength(20);
    expect(single).toHaveLength(1);
    expect(single[0].key).toBe('wall');
    expect(single[0].members).toHaveLength(50);
  });

  it('counts a bundle of one as a bundle, not a loose item', () => {
    const meshes = [...Array.from({ length: 20 }, () => mesh(null)), mesh('solo')];
    const { batched, single } = splitSelectionPlan(planSelectionBoxes(meshes));
    expect(batched).toHaveLength(20);
    expect(single.map((entry) => entry.key)).toEqual(['solo']);
  });
});

describe('writeBoxEdges (#3996)', () => {
  it('writes the twelve edges of a box, every vertex on a corner', () => {
    const out = new Float32Array(BOX_EDGE_VERTICES * 3);
    const end = writeBoxEdges(out, 0, { x: -1, y: -2, z: -3 }, { x: 1, y: 2, z: 3 });
    expect(end).toBe(BOX_EDGE_VERTICES * 3);
    for (let i = 0; i < out.length; i += 3) {
      expect(Math.abs(out[i])).toBe(1);
      expect(Math.abs(out[i + 1])).toBe(2);
      expect(Math.abs(out[i + 2])).toBe(3);
    }
  });

  it('draws each of the box edges once: 12 segments, each axis-aligned', () => {
    const out = new Float32Array(BOX_EDGE_VERTICES * 3);
    writeBoxEdges(out, 0, { x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 });
    const seen = new Set();
    for (let i = 0; i < out.length; i += 6) {
      const a = [out[i], out[i + 1], out[i + 2]];
      const b = [out[i + 3], out[i + 4], out[i + 5]];
      const differing = a.filter((value, axis) => value !== b[axis]).length;
      expect(differing).toBe(1); // an edge changes along exactly one axis
      seen.add([a, b].map((c) => c.join()).sort().join('|'));
    }
    expect(seen.size).toBe(12);
  });

  it('writes at an offset and returns where it stopped', () => {
    const out = new Float32Array(BOX_EDGE_VERTICES * 3 * 2);
    const first = writeBoxEdges(out, 0, { x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 });
    const second = writeBoxEdges(out, first, { x: 5, y: 5, z: 5 }, { x: 6, y: 6, z: 6 });
    expect(second).toBe(out.length);
    expect(out[first]).toBeGreaterThanOrEqual(5);
  });
});
