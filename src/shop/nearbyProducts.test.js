import { describe, expect, it } from 'vitest';
import { nearestProducts, stepNearby, nearbyAnnouncement, distanceWords, NEARBY_LIMIT } from './nearbyProducts.js';

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
