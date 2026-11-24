// #4115: which placed items are one set, shared by Shop and Build.
import { describe, expect, it } from 'vitest';
import { buildLodSets } from './lodSets.js';
import { findImplicitSets } from './implicitLodSets.js';

const reading = {
  hasTiers: () => true,
  groupIdOf: (object) => object.userData.groupId,
  templateKeyOf: (object) => object.userData.template?.templateId,
  positionOf: (object) => object.position,
  radiusOf: (object) => object.radius ?? 0.5,
};

function item(templateId, x, y, z, { groupId, radius } = {}) {
  return { userData: { template: { templateId }, groupId }, position: { x, y, z }, radius };
}

describe('buildLodSets', () => {
  it('makes a set of a bundle and writes its id on every member', () => {
    const members = [item('a', 0, 0, 0, { groupId: 'g1' }), item('b', 50, 0, 0, { groupId: 'g1' }), item('a', 0, 5, 0, { groupId: 'g2' })];
    const sets = buildLodSets(members, reading);
    expect([...sets.keys()]).toEqual(['g1']); // a bundle of one is decided as a single item
    expect(sets.get('g1').members).toHaveLength(2);
    expect(members[0].userData.lodSetId).toBe('g1');
    expect(members[1].userData.lodSetId).toBe('g1');
    expect(members[2].userData.lodSetId).toBeUndefined();
  });

  it('groups loose items of one product that touch, and nothing else', () => {
    const wall = Array.from({ length: 5 }, (_, i) => item('brick', i * 1, 0, 0));
    const other = item('stone', 2, 0, 0); // in the middle of the wall, another product
    const far = item('brick', 40, 0, 0);
    const sets = buildLodSets([...wall, other, far], reading);
    expect(sets.size).toBe(1);
    const [set] = [...sets.values()];
    expect(set.members).toHaveLength(5);
    expect(other.userData.lodSetId).toBeUndefined();
    expect(far.userData.lodSetId).toBeUndefined();
  });

  it('can leave loose items alone (implicit off) and still makes sets of bundles', () => {
    const wall = Array.from({ length: 5 }, (_, i) => item('brick', i * 1, 0, 0));
    const bundled = [item('a', 0, 10, 0, { groupId: 'g' }), item('a', 1, 10, 0, { groupId: 'g' })];
    const sets = buildLodSets([...wall, ...bundled], { ...reading, implicit: false });
    expect([...sets.keys()]).toEqual(['g']);
  });

  it('skips items without versions and keeps whatever set id they had', () => {
    const kept = item('brick', 0, 0, 0);
    kept.userData.lodSetId = 'old';
    const sets = buildLodSets([kept, item('brick', 1, 0, 0)], { ...reading, hasTiers: (object) => object !== kept });
    expect(kept.userData.lodSetId).toBe('old');
    expect(sets.size).toBe(0);
  });

  it('gives a set its bounding sphere and biggest member', () => {
    const sets = buildLodSets([item('brick', 0, 0, 0, { radius: 0.5 }), item('brick', 1, 0, 0, { radius: 1 })], reading);
    const [set] = [...sets.values()];
    expect(set.maxMemberRadiusM).toBe(1);
    expect(set.sphere.radiusM).toBeGreaterThan(1);
  });
});

describe('findImplicitSets sizes its grid per product', () => {
  it('finds the same sets as before when a big item of one product sits among small items of another', () => {
    const items = [];
    for (let i = 0; i < 12; i++) items.push({ key: 'small', x: i * 0.3, y: 0, z: 0, radiusM: 0.15 });
    items.push({ key: 'huge', x: 0, y: 0, z: 0, radiusM: 8 });
    items.push({ key: 'huge', x: 10, y: 0, z: 0, radiusM: 8 });
    const sets = findImplicitSets(items);
    const sizes = sets.map((set) => set.length).sort((a, b) => a - b);
    expect(sizes).toEqual([2, 12]); // the small wall, and the two huge items, never mixed
  });
});
