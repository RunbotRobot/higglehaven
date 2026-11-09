import { describe, expect, it } from 'vitest';
import { groupIdOf, planSelectionBoxes } from './selectionBoxes.js';

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
