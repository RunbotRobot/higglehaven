// #3373 / #3416: the pure level-of-detail rule: apparent size, three tiers with
// hysteresis, and the budget.
import { describe, expect, it } from 'vitest';
import {
  apparentSizePx, nextTier, budgetedTiers, fullDetailFloorPx, isNearFullDetail, NEAR_FULL_DETAIL_M,
  LOD_MID_ENTER_PX, LOD_MID_EXIT_PX, LOD_FAR_ENTER_PX, LOD_FAR_EXIT_PX, MAX_FULL_DETAIL_ITEMS, MAX_MID_DETAIL_ITEMS,
  TIER_FULL, TIER_MID, TIER_FAR, setBoundingSphere, largestFirst,
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
  const tierAt = (radiusM, distanceM) => nextTier(null, apparentSizePx(radiusM, distanceM, FOV, VIEWPORT_H));

  it('an enormous item (the toilet, ~6 m across) is never reduced to the far version at 75 m or 100 m', () => {
    expect(tierAt(3, 75)).not.toBe(TIER_FAR);
    expect(tierAt(3, 100)).not.toBe(TIER_FAR);
  });

  it('a small item (a teacup, ~0.3 m across) is already a reduced version at 75 m', () => {
    expect(tierAt(0.15, 75)).not.toBe(TIER_FULL);
  });

  it('every item steps down eventually, farther the bigger it is, and never to a box', () => {
    const farDistance = (radiusM) => {
      let d = 1;
      while (tierAt(radiusM, d) !== TIER_FAR && d < 100000) d += 1;
      return d;
    };
    expect(farDistance(0.15)).toBeLessThan(farDistance(1));
    expect(farDistance(1)).toBeLessThan(farDistance(3));
    expect([TIER_FULL, TIER_MID, TIER_FAR]).toContain(tierAt(0.01, 5000));
  });
});

describe('nextTier', () => {
  it('goes full -> mid -> far as the item shrinks on screen', () => {
    expect(nextTier(null, LOD_MID_ENTER_PX + 1)).toBe(TIER_FULL);
    expect(nextTier(null, LOD_MID_ENTER_PX - 1)).toBe(TIER_MID);
    expect(nextTier(null, LOD_FAR_ENTER_PX - 1)).toBe(TIER_FAR);
  });

  it('has a hysteresis band at each boundary', () => {
    expect(LOD_MID_EXIT_PX).toBeGreaterThan(LOD_MID_ENTER_PX);
    expect(LOD_FAR_EXIT_PX).toBeGreaterThan(LOD_FAR_ENTER_PX);
    const midBand = (LOD_MID_ENTER_PX + LOD_MID_EXIT_PX) / 2;
    expect(nextTier(TIER_MID, midBand)).toBe(TIER_MID);
    expect(nextTier(TIER_FULL, midBand)).toBe(TIER_FULL);
    expect(nextTier(TIER_MID, LOD_MID_EXIT_PX + 1)).toBe(TIER_FULL);
    const farBand = (LOD_FAR_ENTER_PX + LOD_FAR_EXIT_PX) / 2;
    expect(nextTier(TIER_FAR, farBand)).toBe(TIER_FAR);
    expect(nextTier(TIER_MID, farBand)).toBe(TIER_MID);
    expect(nextTier(TIER_FAR, LOD_FAR_EXIT_PX + 1)).toBe(TIER_MID);
  });

  it('a far item that suddenly looks huge jumps straight to full', () => {
    expect(nextTier(TIER_FAR, LOD_MID_EXIT_PX + 50)).toBe(TIER_FULL);
  });
});

describe('budgetedTiers', () => {
  const item = (px, wanted, isProtected = false) => ({ px, wanted, protected: isProtected });

  it('changes nothing when everything fits', () => {
    const items = [item(200, TIER_FULL), item(50, TIER_MID), item(10, TIER_FAR)];
    expect(budgetedTiers(items)).toEqual([TIER_FULL, TIER_MID, TIER_FAR]);
  });

  it('full overflow drops the smallest on screen to mid', () => {
    const items = [item(300, TIER_FULL), item(200, TIER_FULL), item(150, TIER_FULL), item(100, TIER_FULL)];
    expect(budgetedTiers(items, 2, 10)).toEqual([TIER_FULL, TIER_FULL, TIER_MID, TIER_MID]);
  });

  it('mid overflow (including those just dropped) drops the smallest to far, never skipping mid', () => {
    const items = [item(300, TIER_FULL), item(200, TIER_FULL), item(60, TIER_MID), item(40, TIER_MID)];
    expect(budgetedTiers(items, 1, 2)).toEqual([TIER_FULL, TIER_MID, TIER_MID, TIER_FAR]);
  });

  it('protected items stay full and use no budget', () => {
    const items = [item(5, TIER_FULL, true), item(5, TIER_FULL, true), item(300, TIER_FULL), item(200, TIER_FULL)];
    expect(budgetedTiers(items, 3, 10)).toEqual([TIER_FULL, TIER_FULL, TIER_FULL, TIER_MID]);
  });

  it('has sensible default budgets', () => {
    expect(MAX_MID_DETAIL_ITEMS).toBeGreaterThan(MAX_FULL_DETAIL_ITEMS);
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
    expect(px).toBeLessThan(LOD_MID_EXIT_PX);
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

// #3494: which items change version first when many are due at once.
describe('largestFirst', () => {
  it('orders the items due to change by size on screen, biggest first', () => {
    const items = [{ px: 40 }, { px: 120 }, { px: 15 }, { px: 80 }];
    expect(largestFirst([0, 1, 2, 3], items)).toEqual([1, 3, 0, 2]);
  });

  it('keeps equal sizes in their original order and handles none or one', () => {
    const items = [{ px: 50 }, { px: 50 }, { px: 50 }];
    expect(largestFirst([2, 0, 1], items)).toEqual([2, 0, 1]);
    expect(largestFirst([], items)).toEqual([]);
    expect(largestFirst([1], items)).toEqual([1]);
  });
});
