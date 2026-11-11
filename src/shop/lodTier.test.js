// #3373: the pure level-of-detail rule: apparent size, hysteresis, and the cap.
import { describe, expect, it } from 'vitest';
import {
  apparentSizePx, nextIsMiddle, fullDetailFloorPx, isNearFullDetail, NEAR_FULL_DETAIL_M, LOD_ENTER_PX, LOD_EXIT_PX, MAX_FULL_DETAIL_ITEMS,
  setBoundingSphere,
} from './lodTier.js';

const FOV = 60;
const VIEWPORT_H = 860; // a phone

describe('apparentSizePx', () => {
  it('is the diameter on screen: halves as the distance doubles', () => {
    const near = apparentSizePx(1, 20, FOV, VIEWPORT_H);
    const far = apparentSizePx(1, 40, FOV, VIEWPORT_H);
    expect(near / far).toBeCloseTo(2);
  });

  it('grows with the item size and the viewport height', () => {
    expect(apparentSizePx(2, 50, FOV, VIEWPORT_H)).toBeCloseTo(2 * apparentSizePx(1, 50, FOV, VIEWPORT_H));
    expect(apparentSizePx(1, 50, FOV, 2 * VIEWPORT_H)).toBeCloseTo(2 * apparentSizePx(1, 50, FOV, VIEWPORT_H));
  });

  it('gets bigger when the lens is zoomed in (narrower field of view)', () => {
    expect(apparentSizePx(1, 50, 30, VIEWPORT_H)).toBeGreaterThan(apparentSizePx(1, 50, 60, VIEWPORT_H));
  });

  it('does not blow up at zero distance', () => {
    expect(Number.isFinite(apparentSizePx(1, 0, FOV, VIEWPORT_H))).toBe(true);
  });
});

describe('the cases the owner reported', () => {
  const swapsAt = (radiusM, distanceM) => nextIsMiddle(false, apparentSizePx(radiusM, distanceM, FOV, VIEWPORT_H));

  it('an enormous item (the toilet, ~6 m across) is still the real model at 75 m and 100 m', () => {
    expect(swapsAt(3, 75)).toBe(false);
    expect(swapsAt(3, 100)).toBe(false);
  });

  it('a small item (a teacup, ~0.3 m across) is already the box at 75 m', () => {
    expect(swapsAt(0.15, 75)).toBe(true);
  });

  it('every item swaps eventually, farther the bigger it is', () => {
    const swapDistance = (radiusM) => {
      let d = 1;
      while (!swapsAt(radiusM, d) && d < 10000) d += 1;
      return d;
    };
    expect(swapDistance(0.15)).toBeLessThan(swapDistance(1));
    expect(swapDistance(1)).toBeLessThan(swapDistance(3));
  });
});

describe('nextIsMiddle hysteresis', () => {
  it('swaps down below the enter size and not before', () => {
    expect(nextIsMiddle(false, LOD_ENTER_PX + 0.1)).toBe(false);
    expect(nextIsMiddle(false, LOD_ENTER_PX - 0.1)).toBe(true);
  });

  it('only swaps back up once past the exit size, a band above the enter size', () => {
    expect(LOD_EXIT_PX).toBeGreaterThan(LOD_ENTER_PX);
    const between = (LOD_ENTER_PX + LOD_EXIT_PX) / 2;
    expect(nextIsMiddle(true, between)).toBe(true); // stays box inside the band
    expect(nextIsMiddle(false, between)).toBe(false); // stays model inside the band
    expect(nextIsMiddle(true, LOD_EXIT_PX + 0.1)).toBe(false);
  });

  it('an item with no tier yet starts on the plain threshold', () => {
    expect(nextIsMiddle(null, LOD_ENTER_PX - 1)).toBe(true);
    expect(nextIsMiddle(undefined, LOD_ENTER_PX + 1)).toBe(false);
  });
});

describe('fullDetailFloorPx (the cap)', () => {
  it('is 0 when everything fits', () => {
    expect(fullDetailFloorPx([10, 20, 30], 5)).toBe(0);
    expect(fullDetailFloorPx([], 5)).toBe(0);
  });

  it('drops the smallest on screen first: keeps exactly the cap largest', () => {
    const pxs = [5, 90, 40, 70, 10, 60, 80, 20];
    const floor = fullDetailFloorPx(pxs, 3);
    expect(pxs.filter((p) => p >= floor).sort((a, b) => b - a)).toEqual([90, 80, 70]);
  });

  it('keeps ties at the boundary', () => {
    const floor = fullDetailFloorPx([50, 50, 50, 10], 2);
    expect([50, 50, 50, 10].filter((p) => p >= floor)).toEqual([50, 50, 50]);
  });

  it('has a sensible default budget', () => {
    expect(MAX_FULL_DETAIL_ITEMS).toBeGreaterThan(100);
    expect(fullDetailFloorPx(new Array(MAX_FULL_DETAIL_ITEMS).fill(40))).toBe(0);
  });
});

describe('the protected radius around the avatar (#3443)', () => {
  it('covers everything within NEAR_FULL_DETAIL_M on the ground, and nothing beyond', () => {
    expect(isNearFullDetail(0)).toBe(true);
    expect(isNearFullDetail(NEAR_FULL_DETAIL_M)).toBe(true);
    expect(isNearFullDetail(NEAR_FULL_DETAIL_M + 0.01)).toBe(false);
  });

  it('a brick 10 m away would otherwise be inside the swap band, which is why it is protected', () => {
    const px = apparentSizePx(0.2, NEAR_FULL_DETAIL_M, FOV, VIEWPORT_H);
    expect(px).toBeLessThan(LOD_EXIT_PX);
  });

  it('protected items use up the cap: with none left, every unprotected item simplifies', () => {
    const floor = fullDetailFloorPx([10, 20, 30], Math.max(MAX_FULL_DETAIL_ITEMS - 829, 0));
    expect([10, 20, 30].filter((p) => p >= floor)).toEqual([]);
  });

  it('and with protected items fewer than the cap, the rest keep the remaining budget', () => {
    const floor = fullDetailFloorPx([10, 20, 30, 40], 2);
    expect([10, 20, 30, 40].filter((p) => p >= floor)).toEqual([30, 40]);
  });
});

describe('setBoundingSphere (#3443)', () => {
  it('is a zero sphere for no members', () => {
    expect(setBoundingSphere([])).toEqual({ x: 0, y: 0, z: 0, radiusM: 0 });
  });

  it('is the member\'s own half-diagonal for a single member', () => {
    const sphere = setBoundingSphere([{ x: 4, y: 5, z: 6, radiusM: 2 }]);
    expect(sphere.x).toBe(4);
    expect(sphere.y).toBe(5);
    expect(sphere.z).toBe(6);
    expect(sphere.radiusM).toBeCloseTo(0.5 * Math.hypot(4, 4, 4), 9);
  });

  it('covers a wall of members far wider than any one of them', () => {
    // 100 bricks 0.2 m wide in a row 20 m long.
    const members = Array.from({ length: 100 }, (_, i) => ({ x: i * 0.2, y: 0, z: 0.1, radiusM: 0.1 }));
    const sphere = setBoundingSphere(members);
    expect(sphere.x).toBeCloseTo(9.9, 6);
    expect(sphere.radiusM).toBeGreaterThan(9.9); // at least the half-length
    // A single brick would look tiny; the wall as a whole does not.
    expect(apparentSizePx(sphere.radiusM, 40, 60, 800)).toBeGreaterThan(apparentSizePx(0.1, 40, 60, 800) * 50);
  });

  it('is never smaller than any member\'s own extent', () => {
    const members = [{ x: 0, y: 0, z: 0, radiusM: 1 }, { x: 3, y: 0, z: 0, radiusM: 0.5 }];
    const sphere = setBoundingSphere(members);
    for (const member of members) {
      expect(Math.hypot(member.x - sphere.x, member.y - sphere.y, member.z - sphere.z) + member.radiusM)
        .toBeLessThanOrEqual(sphere.radiusM * Math.sqrt(3) + 1e-9);
    }
  });
});
