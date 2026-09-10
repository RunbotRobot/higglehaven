import { describe, expect, it } from 'vitest';
import {
  computeSavedLayoutGround, pointInDragRect,
  SAVED_LAYOUT_PREVIEW_MARGIN_M, SAVED_LAYOUT_PREVIEW_MIN_GROUND_M,
} from './savedLayoutPreview.js';

function instance(x, y, z = 0) {
  return { x, y, z };
}

describe('computeSavedLayoutGround', () => {
  it('floors a tightly-clustered (or single) instance at the minimum ground size, centered on it', () => {
    const ground = computeSavedLayoutGround([instance(5, 5)]);
    expect(ground.width).toBe(SAVED_LAYOUT_PREVIEW_MIN_GROUND_M);
    expect(ground.depth).toBe(SAVED_LAYOUT_PREVIEW_MIN_GROUND_M);
    expect(ground.centerX).toBe(5);
    expect(ground.centerY).toBe(5);
  });

  it('centers on the instances\' real elevation, not world-origin height, so a swept-out level lands on the preview ground', () => {
    const ground = computeSavedLayoutGround([instance(0, 0, 15), instance(2, 0, 15)]);
    expect(ground.centerZ).toBe(15);
  });

  it('sizes the ground to the real spread plus margin once instances are spread out enough to exceed the minimum', () => {
    const ground = computeSavedLayoutGround([instance(-10, 0), instance(10, 0)]);
    expect(ground.width).toBe(20 + SAVED_LAYOUT_PREVIEW_MARGIN_M * 2);
    expect(ground.depth).toBe(SAVED_LAYOUT_PREVIEW_MIN_GROUND_M);
    expect(ground.centerX).toBe(0);
    expect(ground.centerY).toBe(0);
  });

  it('centers on the actual bounding box, not the world origin, for an off-center cluster', () => {
    const ground = computeSavedLayoutGround([instance(100, 200), instance(108, 204)]);
    expect(ground.centerX).toBe(104);
    expect(ground.centerY).toBe(202);
  });
});

describe('pointInDragRect', () => {
  it('reports a point inside a normally-oriented rect (dragged down-right)', () => {
    const rect = { x1: 10, y1: 10, x2: 50, y2: 50 };
    expect(pointInDragRect({ x: 30, y: 30 }, rect)).toBe(true);
    expect(pointInDragRect({ x: 5, y: 30 }, rect)).toBe(false);
  });

  it('normalizes a rect dragged in any direction (up-left, up-right, down-left)', () => {
    const upLeft = { x1: 50, y1: 50, x2: 10, y2: 10 };
    expect(pointInDragRect({ x: 30, y: 30 }, upLeft)).toBe(true);
    const upRight = { x1: 10, y1: 50, x2: 50, y2: 10 };
    expect(pointInDragRect({ x: 30, y: 30 }, upRight)).toBe(true);
    const downLeft = { x1: 50, y1: 10, x2: 10, y2: 50 };
    expect(pointInDragRect({ x: 30, y: 30 }, downLeft)).toBe(true);
  });

  it('treats the rect edges as inclusive', () => {
    const rect = { x1: 10, y1: 10, x2: 50, y2: 50 };
    expect(pointInDragRect({ x: 10, y: 10 }, rect)).toBe(true);
    expect(pointInDragRect({ x: 50, y: 50 }, rect)).toBe(true);
  });
});
