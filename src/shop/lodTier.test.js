// #3373 / #3416: the pure level-of-detail rule: apparent size, three tiers with
// hysteresis, and the budget.
import { describe, expect, it } from 'vitest';
import {
  apparentSizePx, nextTier, nextSetTier, versionOverdue, LOD_SET_FAR_ENTER_PX, LOD_SET_FAR_EXIT_PX, budgetedTiers, fullDetailFloorPx, isNearFullDetail, NEAR_FULL_DETAIL_M,
  LOD_MID_ENTER_PX, LOD_MID_EXIT_PX, LOD_FAR_ENTER_PX, LOD_FAR_EXIT_PX, MAX_FULL_DETAIL_ITEMS, MAX_MID_DETAIL_ITEMS,
  TIER_FULL, TIER_MID, TIER_FAR, setBoundingSphere, largestFirst, holdBackUnready, MAX_FULL_DETAIL_TRIANGLES, isTierUpgrade, orderViolations,
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

describe('the full-detail triangle budget (#3920)', () => {
  const brick = (dist, extra = {}) => ({ px: 200, wanted: TIER_FULL, protected: false, tris: 5000, dist, current: TIER_FULL, ...extra });

  it('changes nothing while the triangles fit the budget', () => {
    const items = [brick(1), brick(2), brick(3)];
    expect(budgetedTiers(items, 600, 1500, 15_000)).toEqual([TIER_FULL, TIER_FULL, TIER_FULL]);
  });

  it('keeps the nearest items full and drops the farthest to mid when over budget', () => {
    const items = [brick(30), brick(1), brick(20), brick(5), brick(10)];
    // budget for three bricks: the three nearest (1, 5, 10 m) stay full, the 20 and 30 m ones go to mid
    expect(budgetedTiers(items, 600, 1500, 15_000)).toEqual([TIER_MID, TIER_FULL, TIER_MID, TIER_FULL, TIER_FULL]);
  });

  it('counts protected items too: a protected wall over the budget still steps down from its far end', () => {
    const wall = Array.from({ length: 10 }, (_, i) => brick(2 + i * 2, { protected: true }));
    const tiers = budgetedTiers(wall, 600, 1500, 20_000); // four bricks of budget
    expect(tiers.slice(0, 4)).toEqual([TIER_FULL, TIER_FULL, TIER_FULL, TIER_FULL]);
    expect(tiers.slice(4)).toEqual(Array(6).fill(TIER_MID));
  });

  it('gives an item that is already full a few metres of credit, so the boundary does not flicker', () => {
    const items = [brick(10, { current: TIER_MID }), brick(11, { current: TIER_FULL }), brick(30)];
    // budget for one brick: the 10 m one is mid now, the 11 m one is full now: the full one keeps its place
    expect(budgetedTiers(items, 600, 1500, 5_000)).toEqual([TIER_MID, TIER_FULL, TIER_MID]);
  });

  it('does not count or drop items with no triangle count, nor items already below full', () => {
    const items = [brick(1, { tris: 0 }), brick(2, { tris: undefined }), brick(3, { wanted: TIER_MID }), brick(4)];
    expect(budgetedTiers(items, 600, 1500, 1)).toEqual([TIER_FULL, TIER_FULL, TIER_MID, TIER_MID]);
  });

  it('is the cost bound: a thousand big bricks around an avatar cost at most the budget plus one brick', () => {
    const items = Array.from({ length: 1000 }, (_, i) => brick(i * 0.05, { protected: true, tris: 5320 }));
    const tiers = budgetedTiers(items, 600, 1500, 1_200_000);
    const full = tiers.filter((tier) => tier === TIER_FULL).length;
    expect(full * 5320).toBeLessThanOrEqual(1_200_000);
    expect(full).toBeGreaterThan(200);
    expect(tiers.slice(0, full).every((tier) => tier === TIER_FULL)).toBe(true); // the nearest ones
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

// #4113: among equal sizes (a set's members share its size) an upgrade goes before a downgrade, the nearer upgrade
// first and the farther downgrade first: a wall improves from the front and degrades from the back.
describe('largestFirst, ties by direction and distance', () => {
  it('serves the nearer upgrade first, and a bigger one before a nearer smaller one', () => {
    const items = [
      { px: 50, dist: 9, upgrade: true }, { px: 50, dist: 2, upgrade: true }, { px: 50, dist: 5, upgrade: true },
      { px: 80, dist: 30, upgrade: true },
    ];
    expect(largestFirst([0, 1, 2, 3], items)).toEqual([3, 1, 2, 0]);
  });

  it('serves the farther downgrade first, after the upgrades of the same size', () => {
    const items = [
      { px: 50, dist: 2, upgrade: false }, { px: 50, dist: 9, upgrade: false }, { px: 50, dist: 4, upgrade: true },
      { px: 50, dist: 6, upgrade: false },
    ];
    expect(largestFirst([0, 1, 2, 3], items)).toEqual([2, 1, 3, 0]);
  });

  it('puts an unknown distance last, in a consistent order (upgrades and downgrades alike)', () => {
    const ups = [{ px: 50, dist: 9, upgrade: true }, { px: 50, upgrade: true }, { px: 50, dist: 2, upgrade: true }];
    expect(largestFirst([0, 1, 2], ups)).toEqual([2, 0, 1]);
    const downs = [{ px: 50, dist: 2, upgrade: false }, { px: 50, upgrade: false }, { px: 50, dist: 9, upgrade: false }];
    expect(largestFirst([0, 1, 2], downs)).toEqual([2, 0, 1]);
    expect(largestFirst([1, 0, 2], ups)).toEqual([2, 0, 1]); // the same whatever order they arrive in
  });
});

// #4113: which changes are upgrades.
describe('isTierUpgrade', () => {
  it('an upgrade is a better version than the one drawn', () => {
    expect(isTierUpgrade(TIER_FAR, TIER_MID)).toBe(true);
    expect(isTierUpgrade(TIER_FAR, TIER_FULL)).toBe(true);
    expect(isTierUpgrade(TIER_MID, TIER_FULL)).toBe(true);
    expect(isTierUpgrade(TIER_FULL, TIER_MID)).toBe(false);
    expect(isTierUpgrade(TIER_MID, TIER_MID)).toBe(false);
  });
});

// #4113: the measure the walk e2e reads each frame.
describe('orderViolations', () => {
  it('is 0 for a wall that improves from the front, however many versions it shows', () => {
    const wall = [{ d: 2, rank: 2 }, { d: 4, rank: 2 }, { d: 6, rank: 1 }, { d: 8, rank: 1 }, { d: 10, rank: 0 }];
    expect(orderViolations(wall)).toBe(0);
    expect(orderViolations([])).toBe(0);
    expect(orderViolations([{ d: 3, rank: 0 }])).toBe(0);
  });

  it("counts the owner's band: near bricks on far while farther ones already have mid", () => {
    const wall = [
      ...Array.from({ length: 4 }, (_, i) => ({ d: 2 + i, rank: 0 })), // nearest four still far
      ...Array.from({ length: 6 }, (_, i) => ({ d: 8 + i, rank: 1 })), // the ones behind have mid
    ];
    expect(orderViolations(wall)).toBe(4);
  });

  it('does not count bricks at the same distance against each other', () => {
    expect(orderViolations([{ d: 5, rank: 0 }, { d: 5, rank: 2 }])).toBe(0);
    expect(orderViolations([{ d: 5, rank: 0 }, { d: 6, rank: 2 }])).toBe(1);
  });
});

// #4003: entering a heavy lándlet. The measured case: 1,650 bricks of 5,120 triangles (8,448,000) plus
// 40 mixed items, all drawn from their full model until their versions attach.
describe('holdBackUnready', () => {
  const BRICK = 5120;
  const wall = (count) => Array.from({ length: count }, (_, i) => ({ tris: BRICK, dist: i, sticky: false }));

  it('lets in the nearest items up to the triangle budget and holds the rest', () => {
    const items = wall(1650);
    const held = holdBackUnready(items);
    const drawn = items.filter((_, i) => !held[i]);
    const drawnTriangles = drawn.reduce((sum, item) => sum + item.tris, 0);
    expect(drawnTriangles).toBeLessThanOrEqual(MAX_FULL_DETAIL_TRIANGLES);
    expect(drawn.length).toBe(Math.floor(MAX_FULL_DETAIL_TRIANGLES / BRICK)); // 234
    // The nearest are the ones drawn, never a far one in front of a near one.
    held.forEach((isHeld, i) => { if (!isHeld) expect(i).toBeLessThan(drawn.length); });
    // From 8,448,000 triangles in the first frame to at most the budget.
    expect(items.reduce((sum, item) => sum + item.tris, 0)).toBe(8_448_000);
    expect(drawnTriangles).toBeLessThan(items.length * BRICK * 0.15);
  });

  it('draws everything when it fits, and never holds an item of unknown size', () => {
    expect(holdBackUnready(wall(100))).toEqual(Array(100).fill(false));
    expect(holdBackUnready([{ tris: 0, dist: 1 }, { tris: undefined, dist: 2 }])).toEqual([false, false]);
  });

  it('always lets in the nearest item, even one bigger than the budget', () => {
    expect(holdBackUnready([{ tris: 5_000_000, dist: 1 }, { tris: 10, dist: 2 }])).toEqual([false, true]);
  });

  it('keeps an item that is already drawn drawn, and counts it against the budget first', () => {
    const items = wall(300);
    items[299].sticky = true; // far away but already on screen
    const held = holdBackUnready(items);
    expect(held[299]).toBe(false);
    const drawn = items.filter((_, i) => !held[i]).reduce((sum, item) => sum + item.tris, 0);
    expect(drawn).toBeLessThanOrEqual(MAX_FULL_DETAIL_TRIANGLES);
  });

  it('is empty for no items', () => {
    expect(holdBackUnready([])).toEqual([]);
  });
});

describe('a set steps full, mid, far, and takes far only where its parts are tiny (#4113)', () => {
  it('keeps a part that is 14 to 20 px wide on mid, where a lone item would already be far', () => {
    for (const px of [14, 17, 20, 23]) {
      expect(nextSetTier(TIER_MID, px)).toBe(TIER_MID);
      expect(nextSetTier(TIER_FULL, px)).toBe(TIER_MID);
    }
    expect(nextTier(TIER_MID, 17)).toBe(TIER_FAR); // the old rule for a single item, unchanged
  });

  it('takes far only under the set far size, and has a gap before coming back', () => {
    expect(LOD_SET_FAR_ENTER_PX).toBeLessThan(LOD_FAR_ENTER_PX);
    expect(LOD_SET_FAR_EXIT_PX).toBeGreaterThan(LOD_SET_FAR_ENTER_PX);
    expect(nextSetTier(TIER_MID, LOD_SET_FAR_ENTER_PX - 1)).toBe(TIER_FAR);
    expect(nextSetTier(TIER_FAR, (LOD_SET_FAR_ENTER_PX + LOD_SET_FAR_EXIT_PX) / 2)).toBe(TIER_FAR);
    expect(nextSetTier(TIER_FAR, LOD_SET_FAR_EXIT_PX + 1)).toBe(TIER_MID);
  });

  it('walking in from far reads far, mid, mid..., full, never skipping mid', () => {
    let tier = TIER_FAR;
    const seen = [];
    for (let px = 6; px <= 130; px += 1) {
      tier = nextSetTier(tier, px);
      if (seen[seen.length - 1] !== tier) seen.push(tier);
    }
    expect(seen).toEqual([TIER_FAR, TIER_MID, TIER_FULL]);
  });
});

describe('the read-out says why each item ended where it did (#4113)', () => {
  it('names the rule that decided each one', () => {
    const items = [
      { px: 200, wanted: TIER_FULL, protected: true, tris: 5000, dist: 2 },
      { px: 200, wanted: TIER_FULL, protected: true, tris: 5000, dist: 9 },
      { px: 50, wanted: TIER_MID, protected: false, tris: 5000, dist: 30 },
    ];
    const reasons = [];
    const tiers = budgetedTiers(items, undefined, undefined, 6000, reasons);
    expect(tiers).toEqual([TIER_FULL, TIER_MID, TIER_MID]);
    expect(reasons).toEqual(['beside the avatar', 'triangle budget', 'size']);
  });

  it('leaves a call without a read-out untouched', () => {
    const items = [{ px: 50, wanted: TIER_MID, protected: false }];
    expect(budgetedTiers(items)).toEqual([TIER_MID]);
  });
});

describe('versionOverdue (#4113)', () => {
  it('a set member on far is overdue once it is 1.5x past the set far exit, not before', () => {
    expect(versionOverdue('far', 'mid', LOD_SET_FAR_EXIT_PX * 1.5 - 1, true)).toBe(false);
    expect(versionOverdue('far', 'mid', LOD_SET_FAR_EXIT_PX * 1.5, true)).toBe(true);
    // the owner's recording: a far brick 60 to 80 px tall
    expect(versionOverdue('far', 'full', 70, true)).toBe(true);
  });
  it('a lone item on far uses the plain far exit', () => {
    expect(versionOverdue('far', 'mid', LOD_FAR_EXIT_PX * 1.5 - 1, false)).toBe(false);
    expect(versionOverdue('far', 'mid', LOD_FAR_EXIT_PX * 1.5, false)).toBe(true);
  });
  it('a member on mid is overdue well past the mid exit', () => {
    expect(versionOverdue('mid', 'full', LOD_MID_EXIT_PX * 1.5 - 1, true)).toBe(false);
    expect(versionOverdue('mid', 'full', LOD_MID_EXIT_PX * 1.5, true)).toBe(true);
  });
  it('only an upgrade can be overdue: a better version than needed is never seen', () => {
    expect(versionOverdue('full', 'mid', 1, true)).toBe(false);
    expect(versionOverdue('mid', 'far', 1, true)).toBe(false);
    expect(versionOverdue('far', 'far', 500, true)).toBe(false);
  });
});
