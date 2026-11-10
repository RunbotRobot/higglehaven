// #3373: the pure level-of-detail rule: apparent size, hysteresis, and the cap.
import { describe, expect, it } from 'vitest';
import {
  apparentSizePx, nextIsMiddle, fullDetailFloorPx, LOD_ENTER_PX, LOD_EXIT_PX, MAX_FULL_DETAIL_ITEMS,
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
