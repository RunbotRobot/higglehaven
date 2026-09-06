import { describe, expect, it } from 'vitest';
import { areLandletsAdjacent, bordersWater, landletReachM } from './landletAdjacency.js';

describe('landletReachM', () => {
  it('falls back to half the diagonal of a square with the given area when there is no polygon', () => {
    expect(landletReachM(null, 200)).toBeCloseTo(Math.sqrt(200 / 2), 10);
    expect(landletReachM([], 200)).toBeCloseTo(Math.sqrt(200 / 2), 10);
  });

  // {x, y} objects, matching every real polygon this app ever produces
  // (src/main.js's worldPoints/landlet-generation code) — not [x, y]
  // tuples, which #250 found this function crashed on in production
  // (destructuring a plain object as an array throws "object is not
  // iterable").
  it('uses the farthest polygon vertex from center when a polygon is given', () => {
    const polygon = [
      { x: 1, y: 0 },
      { x: 0, y: 3 },
      { x: -1, y: -1 },
    ];
    expect(landletReachM(polygon, 999)).toBeCloseTo(3, 10);
  });
});

describe('areLandletsAdjacent', () => {
  it('is true for two lándlets whose bounding circles overlap', () => {
    const a = { center: { x: 0, y: 0 }, areaM2: 1000, polygon: null };
    const b = { center: { x: 10, y: 0 }, areaM2: 1000, polygon: null };
    expect(areLandletsAdjacent(a, b)).toBe(true);
  });

  it('is false for two lándlets far enough apart that their circles never touch', () => {
    const a = { center: { x: 0, y: 0 }, areaM2: 100, polygon: null };
    const b = { center: { x: 1000, y: 0 }, areaM2: 100, polygon: null };
    expect(areLandletsAdjacent(a, b)).toBe(false);
  });

  it('respects the tolerance at the boundary', () => {
    const a = { center: { x: 0, y: 0 }, areaM2: 2, polygon: null }; // reach = 1
    const b = { center: { x: 2, y: 0 }, areaM2: 2, polygon: null }; // reach = 1, gap of exactly 0
    expect(areLandletsAdjacent(a, b, 0)).toBe(true);
    expect(areLandletsAdjacent(a, b, -0.1)).toBe(false);
  });
});

describe('bordersWater', () => {
  const water = { landletId: 'w1', landType: 'water', center: { x: 5, y: 0 }, areaM2: 50, polygon: null };
  const buildable = { landletId: 'b1', landType: 'buildable', center: { x: 0, y: 0 }, areaM2: 1000, polygon: null };
  const farAway = { landletId: 'b2', landType: 'buildable', center: { x: 5000, y: 0 }, areaM2: 50, polygon: null };

  it('is true when a water lándlet is adjacent', () => {
    expect(bordersWater(buildable, [water, farAway])).toBe(true);
  });

  it('is false when no water lándlet is adjacent', () => {
    expect(bordersWater(farAway, [water, buildable])).toBe(false);
  });

  it('is false for a water lándlet itself, regardless of neighbors', () => {
    expect(bordersWater(water, [water, buildable])).toBe(false);
  });

  it('ignores itself even if somehow present in the candidate list', () => {
    const self = { ...buildable };
    expect(bordersWater(self, [self])).toBe(false);
  });

  it('does not crash on real, generated {x, y}-shaped polygons (regression: landletReachM used to destructure [x, y] tuples)', () => {
    const squarePolygon = (half) => [
      { x: -half, y: -half },
      { x: half, y: -half },
      { x: half, y: half },
      { x: -half, y: half },
    ];
    const waterWithPolygon = {
      landletId: 'w2', landType: 'water', center: { x: 5, y: 0 }, areaM2: 50, polygon: squarePolygon(3),
    };
    const buildableWithPolygon = {
      landletId: 'b3', landType: 'buildable', center: { x: 0, y: 0 }, areaM2: 1000, polygon: squarePolygon(15),
    };
    expect(() => bordersWater(buildableWithPolygon, [waterWithPolygon])).not.toThrow();
    expect(bordersWater(buildableWithPolygon, [waterWithPolygon])).toBe(true);
  });
});
