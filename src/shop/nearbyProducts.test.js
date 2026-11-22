import { describe, expect, it } from 'vitest';
import { nearestProducts, stepNearby, nearbyAnnouncement, distanceWords, directionWords, yawFacing, groupNearby, nameWithCount, NEARBY_LIMIT } from './nearbyProducts.js';

const items = [{ id: 'far', d: 30 }, { id: 'near', d: 2 }, { id: 'mid', d: 9 }, { id: 'tie', d: 9 }, { id: 'gone', d: NaN }];
const dist = (i) => i.d;

describe('nearestProducts', () => {
  it('orders nearest first, keeps loaded order on a tie, drops what has no distance', () => {
    expect(nearestProducts(items, dist).map((i) => i.id)).toEqual(['near', 'mid', 'tie', 'far']);
  });
  it('keeps only the nearest few', () => {
    const many = Array.from({ length: 20 }, (_, n) => ({ id: n, d: 20 - n }));
    const list = nearestProducts(many, dist);
    expect(list).toHaveLength(NEARBY_LIMIT);
    expect(list[0].id).toBe(19);
  });
});

describe('stepNearby', () => {
  const list = nearestProducts(items, dist);
  it('lands on the nearest with nothing open, and on the furthest going backwards', () => {
    expect(stepNearby(list, null)).toMatchObject({ position: 1, total: 4, item: list[0] });
    expect(stepNearby(list, null, -1)).toMatchObject({ position: 4, item: list[3] });
  });
  it('steps on from the open product and wraps in both directions', () => {
    expect(stepNearby(list, list[0]).item).toBe(list[1]);
    expect(stepNearby(list, list[3]).item).toBe(list[0]);
    expect(stepNearby(list, list[0], -1).item).toBe(list[3]);
  });
  it('starts again from the nearest when the open product is no longer near', () => {
    expect(stepNearby(list, { id: 'elsewhere' }).item).toBe(list[0]);
  });
  it('says nothing is near with an empty list', () => {
    expect(stepNearby([], null)).toBeNull();
  });
});

describe('nearbyAnnouncement', () => {
  it('names the product and its place in the list', () => {
    expect(nearbyAnnouncement('Mossy chair', 2, 5)).toBe('Mossy chair, 2 of 5 nearby');
    expect(nearbyAnnouncement('Mossy chair', 1, 1)).toBe('Mossy chair');
    expect(nearbyAnnouncement('', 1, 1)).toBe('Product');
  });
});

describe('distanceWords', () => {
  it('says whole metres, and Here under one', () => {
    expect(distanceWords(0.4)).toBe('Here');
    expect(distanceWords(2.6)).toBe('3 m');
    expect(distanceWords(40)).toBe('40 m');
    expect(distanceWords(NaN)).toBe('');
  });
});

describe('directionWords (#4044)', () => {
  const ahead = { x: 0, y: 1 }; // yaw 0 faces +Y
  it('says ahead, to a side and behind in plain words', () => {
    expect(directionWords(ahead, { x: 0, y: 5 })).toBe('ahead');
    expect(directionWords(ahead, { x: -5, y: 5 })).toBe('ahead and to the left');
    expect(directionWords(ahead, { x: 5, y: 5 })).toBe('ahead and to the right');
    expect(directionWords(ahead, { x: -5, y: 0 })).toBe('to the left');
    expect(directionWords(ahead, { x: 5, y: 0 })).toBe('to the right');
    expect(directionWords(ahead, { x: -5, y: -5 })).toBe('behind and to the left');
    expect(directionWords(ahead, { x: 0, y: -5 })).toBe('behind');
  });
  it('reads from where the view faces, not from north', () => {
    const west = { x: -1, y: 0 }; // yaw a quarter turn counter-clockwise
    expect(directionWords(west, { x: -5, y: 0 })).toBe('ahead');
    expect(directionWords(west, { x: 0, y: -5 })).toBe('to the left');
  });
  it('says nothing for a direction that is not a number', () => {
    expect(directionWords(ahead, { x: NaN, y: 1 })).toBe('');
  });
});

describe('yawFacing (#4044)', () => {
  it('turns the view to face the point, with forward (-sin yaw, cos yaw)', () => {
    for (const [dx, dy] of [[0, 5], [-5, 0], [3, -4], [7, 7]]) {
      const yaw = yawFacing(dx, dy);
      const fx = -Math.sin(yaw);
      const fy = Math.cos(yaw);
      const len = Math.hypot(dx, dy);
      expect(fx).toBeCloseTo(dx / len, 6);
      expect(fy).toBeCloseTo(dy / len, 6);
    }
  });
});

describe('groupNearby (#4049)', () => {
  const wall = Array.from({ length: 10 }, (_, n) => ({ id: `brick${n}`, kind: 'brick', d: 3 + n * 0.1 }));
  const others = [{ id: 'lamp', kind: 'lamp', d: 12 }, { id: 'rug', kind: 'rug', d: 20 }];
  const key = (i) => i.kind;
  it('stands one entry in for a whole wall, with its nearest member and a count', () => {
    const groups = groupNearby([...others, ...wall], dist, key);
    expect(groups.map((g) => [g.item.id, g.count])).toEqual([['brick0', 10], ['lamp', 1], ['rug', 1]]);
  });
  it('lets the other products reach the list instead of eight identical rows', () => {
    const many = Array.from({ length: 12 }, (_, n) => ({ id: `p${n}`, kind: `k${n}`, d: 20 + n }));
    const groups = groupNearby([...wall, ...many], dist, key);
    expect(groups).toHaveLength(NEARBY_LIMIT);
    expect(groups[0].count).toBe(10);
    expect(groups[1].item.id).toBe('p0');
  });
  it('leaves out what has no distance and keeps the limit', () => {
    expect(groupNearby([{ id: 'x', kind: 'x', d: NaN }, ...others], dist, key).map((g) => g.item.id)).toEqual(['lamp', 'rug']);
    expect(groupNearby(wall, dist, key, 1)).toHaveLength(1);
  });
});

describe('nameWithCount (#4049)', () => {
  it('says how many of one product are near, and nothing for one', () => {
    expect(nameWithCount('Brick - Orange', 8)).toBe('Brick - Orange, 8 of them');
    expect(nameWithCount('Lamp', 1)).toBe('Lamp');
  });
});
