// #4198: Build's limiter against the shared outline definition.
import { describe, expect, it } from 'vitest';
import { limitItemMove, limitItemPlacement, limitGroupOffset, pullGroupTowardCentre, itemLegalAt, setBuildOutline, getBuildOutline } from './outlineLimit.js';

const SQUARE = [{ x: -10, y: -10 }, { x: 10, y: -10 }, { x: 10, y: 10 }, { x: -10, y: 10 }];
// A slanted right edge: from (10, -10) up to (4, 10).
const SLANT = [{ x: -10, y: -10 }, { x: 10, y: -10 }, { x: 4, y: 10 }, { x: -10, y: 10 }];
const BRICK = { width: 2, depth: 2, rotationZ: 0 };

describe('limitItemMove', () => {
  it('takes a legal place as asked', () => {
    expect(limitItemMove(SQUARE, BRICK, { x: 0, y: 0 }, { x: 5, y: 5 }, 0)).toEqual({ x: 5, y: 5, limited: false });
  });

  it('stops at the edge when dragged straight into it, and says it was limited', () => {
    const result = limitItemMove(SQUARE, BRICK, { x: 0, y: 0 }, { x: 15, y: 0 }, 0);
    expect(result.limited).toBe(true);
    expect(result.x).toBeCloseTo(9, 3); // the brick's edge rests on the outline at x = 10
    expect(result.y).toBeCloseTo(0, 3);
  });

  it('slides along an edge instead of sticking to it', () => {
    // At the right wall of the square, dragging up and to the right keeps the upward part.
    const result = limitItemMove(SQUARE, BRICK, { x: 9, y: 0 }, { x: 14, y: 6 }, 0);
    expect(result.limited).toBe(true);
    expect(result.x).toBeCloseTo(9, 3);
    expect(result.y).toBeCloseTo(6, 3);
  });

  it('runs along a slanted edge (the owner\'s case: a lándlet is not a square)', () => {
    // Against the slant, asking for further right and up finds the legal point on the line back.
    const result = limitItemMove(SLANT, BRICK, { x: 5, y: 0 }, { x: 9, y: 4 }, 0);
    expect(result.limited).toBe(true);
    expect(itemLegalAt(SLANT, BRICK, result.x, result.y, 0)).toBe(true);
    // And it got somewhere: past where it started, not stuck at it.
    expect(Math.hypot(result.x - 5, result.y - 0)).toBeGreaterThan(0.01);
  });

  it('lets an item whose footprint is turned stop at its turned corners', () => {
    const turned = { width: 6, depth: 1, rotationZ: Math.PI / 4 };
    const result = limitItemMove(SQUARE, turned, { x: 0, y: 0 }, { x: 15, y: 0 }, 0);
    expect(result.x).toBeLessThan(9);
    expect(itemLegalAt(SQUARE, turned, result.x, result.y, 0)).toBe(true);
  });

  it('keeps an item that was already outside where it is until the finger reaches legal ground', () => {
    const stored = limitItemMove(SQUARE, BRICK, { x: 12, y: 0 }, { x: 14, y: 0 }, 0);
    expect(stored).toEqual({ x: 12, y: 0, limited: true });
    const back = limitItemMove(SQUARE, BRICK, { x: 12, y: 0 }, { x: 5, y: 0 }, 0);
    expect(back).toEqual({ x: 5, y: 0, limited: false });
  });
});

describe('limitItemPlacement', () => {
  it('pulls a new item asked for outside back toward the centre to the edge', () => {
    const result = limitItemPlacement(SQUARE, BRICK, { x: 30, y: 0 }, 0);
    expect(result.x).toBeCloseTo(9, 3);
    expect(result.limited).toBe(true);
  });
});

describe('limitGroupOffset', () => {
  const members = [
    { item: BRICK, start: { x: -2, y: 0 }, z: 0 },
    { item: BRICK, start: { x: 2, y: 0 }, z: 0 },
  ];

  it('moves the whole bundle as far as its first member allows, together', () => {
    const result = limitGroupOffset(SQUARE, members, { x: 20, y: 0 });
    expect(result.limited).toBe(true);
    expect(result.x).toBeCloseTo(7, 3); // the right-hand brick (centre 2) can go 7 to rest on x = 10
  });

  it('slides along a wall like a single item', () => {
    const atWall = members.map((m) => ({ ...m, start: { x: m.start.x + 7, y: 0 } }));
    const result = limitGroupOffset(SQUARE, atWall, { x: 5, y: 4 });
    expect(result.x).toBeCloseTo(0, 3);
    expect(result.y).toBeCloseTo(4, 3);
  });

  it('leaves a bundle that starts off the lándlet where it is', () => {
    const off = [{ item: BRICK, start: { x: 12, y: 0 }, z: 0 }];
    expect(limitGroupOffset(SQUARE, off, { x: 1, y: 0 })).toEqual({ x: 0, y: 0, limited: true });
  });
});

describe('setBuildOutline', () => {
  it('keeps a usable polygon and drops an unusable one, so the caller falls back to its square', () => {
    setBuildOutline(SQUARE);
    expect(getBuildOutline()).toHaveLength(4);
    setBuildOutline('[]');
    expect(getBuildOutline()).toBeNull();
  });
});

describe('pullGroupTowardCentre', () => {
  const at = (x, y) => ({ item: BRICK, x, y, z: 0 });

  it('leaves a bundle that already fits alone', () => {
    expect(pullGroupTowardCentre(SQUARE, [at(-2, 0), at(2, 0)])).toEqual({ x: 0, y: 0, limited: false });
  });

  it('slides a bundle placed over the edge back by the least amount, as one body', () => {
    const members = [at(6, 0), at(11, 0)]; // the right brick sticks out: its edge is at 12
    const offset = pullGroupTowardCentre(SQUARE, members);
    expect(offset.limited).toBe(true);
    // The pull is along the line to the centre of the group (8.5), so the group moves left by a little over 2.
    expect(offset.x).toBeLessThan(-1.9);
    expect(offset.x).toBeGreaterThan(-2.5);
    expect(members.every((m) => itemLegalAt(SQUARE, m.item, m.x + offset.x, m.y + offset.y, 0))).toBe(true);
  });

  it('leaves the position (the server will say why) when even the centre does not fit', () => {
    const wide = [at(-20, 0), at(20, 0)];
    expect(pullGroupTowardCentre(SQUARE, wide)).toEqual({ x: 0, y: 0, limited: false });
  });
});

describe('the square rule that goes with the outline (#4403)', () => {
  // An outline that reaches past the 31.6 m square (as the real organic ones do): the Worker still holds an item
  // inside the square by its turned footprint, so Build's limit must too.
  const BIG = [{ x: -20, y: -20 }, { x: 20, y: -20 }, { x: 20, y: 20 }, { x: -20, y: 20 }];
  const PLANK = { width: 2, depth: 0.5, rotationZ: 0 };

  it('does not rest an item where the square would refuse it, though the outline allows it', () => {
    expect(itemLegalAt(BIG, PLANK, 15.4, 0, 0)).toBe(false); // 15.4 + 1 is past 15.81
    expect(itemLegalAt(BIG, { ...PLANK, rotationZ: Math.PI / 2 }, 15.4, 0, 0)).toBe(true); // turned, it is 0.5 wide along x
    expect(itemLegalAt(BIG, { ...PLANK, rotationZ: Math.PI / 2 }, 0, 15.4, 0)).toBe(false); // and 2 long along y
  });

  it('stops a push into the square at the square, not at the bigger outline', () => {
    const stopped = limitItemMove(BIG, PLANK, { x: 0, y: 0 }, { x: 19, y: 0 }, 0);
    expect(stopped.limited).toBe(true);
    expect(stopped.x).toBeCloseTo(15.81 - 1, 2);
  });

  it('applies the square when the lándlet has no polygon at all', () => {
    expect(itemLegalAt(null, PLANK, 15.4, 0, 0)).toBe(false);
    expect(itemLegalAt(null, PLANK, 14.5, 0, 0)).toBe(true);
  });
});
