import { describe, expect, it } from 'vitest';
import {
  attentionDistanceAndDot,
  hasSustainedAttention,
  isWithinAttentionRange,
  nextAttentionElapsedS,
  pickNearestInRange,
  yawRotatedForward,
} from './attention.js';

const RANGE = { radiusM: 4, fovCos: Math.cos((20 * Math.PI) / 180) };

describe('isWithinAttentionRange', () => {
  it('accepts a close, centered candidate', () => {
    expect(isWithinAttentionRange(2, 1, RANGE)).toBe(true);
  });

  it('rejects a candidate beyond the radius, even dead-center', () => {
    expect(isWithinAttentionRange(5, 1, RANGE)).toBe(false);
  });

  it('rejects a close candidate outside the field of view', () => {
    expect(isWithinAttentionRange(2, 0, RANGE)).toBe(false);
  });

  it('treats the radius and FOV edges as inclusive', () => {
    expect(isWithinAttentionRange(RANGE.radiusM, RANGE.fovCos, RANGE)).toBe(true);
  });
});

describe('pickNearestInRange', () => {
  it('returns null when nothing qualifies', () => {
    const candidates = [
      { id: 'far', distanceM: 10, dot: 1 },
      { id: 'off-center', distanceM: 1, dot: 0 },
    ];
    expect(pickNearestInRange(candidates, RANGE)).toBeNull();
  });

  it('picks the nearest of several qualifying candidates', () => {
    const candidates = [
      { id: 'far', distanceM: 3, dot: 1 },
      { id: 'near', distanceM: 1, dot: 1 },
      { id: 'mid', distanceM: 2, dot: 1 },
    ];
    expect(pickNearestInRange(candidates, RANGE)).toBe('near');
  });

  it('ignores out-of-range/out-of-view candidates even if they would otherwise be nearest', () => {
    const candidates = [
      { id: 'closer-but-behind', distanceM: 0.5, dot: -1 },
      { id: 'qualifies', distanceM: 3, dot: 1 },
    ];
    expect(pickNearestInRange(candidates, RANGE)).toBe('qualifies');
  });

  it('keeps the first-seen candidate on an exact distance tie', () => {
    const candidates = [
      { id: 'first', distanceM: 2, dot: 1 },
      { id: 'second', distanceM: 2, dot: 1 },
    ];
    expect(pickNearestInRange(candidates, RANGE)).toBe('first');
  });
});

describe('nextAttentionElapsedS', () => {
  it('accumulates dt while the same target stays current', () => {
    expect(nextAttentionElapsedS('a', 'a', 1.2, 0.5)).toBeCloseTo(1.7, 10);
  });

  it('resets to 0 when the target changes', () => {
    expect(nextAttentionElapsedS('b', 'a', 1.2, 0.5)).toBe(0);
  });

  it('resets to 0 when there is no candidate at all', () => {
    expect(nextAttentionElapsedS(null, 'a', 1.2, 0.5)).toBe(0);
  });

  it('starts accumulating from 0 on a brand-new target', () => {
    expect(nextAttentionElapsedS('a', null, 0, 0.5)).toBe(0);
  });
});

describe('attentionDistanceAndDot', () => {
  it('measures distance and dot from the given anchor, not the world origin', () => {
    const anchor = { x: 10, y: 0, z: 0 };
    const forward = { x: 0, y: 1, z: 0 };
    const item = { x: 10, y: 3, z: 0 }; // 3m ahead of the anchor along forward
    const { distanceM, dot } = attentionDistanceAndDot(anchor, forward, item);
    expect(distanceM).toBeCloseTo(3, 10);
    expect(dot).toBeCloseTo(1, 10);
  });

  it('reports a negative dot for an item behind the anchor', () => {
    const anchor = { x: 0, y: 0, z: 0 };
    const forward = { x: 0, y: 1, z: 0 };
    const item = { x: 0, y: -2, z: 0 };
    const { dot } = attentionDistanceAndDot(anchor, forward, item);
    expect(dot).toBeCloseTo(-1, 10);
  });

  it('does not divide by zero for an item exactly at the anchor', () => {
    const anchor = { x: 1, y: 2, z: 3 };
    const forward = { x: 0, y: 1, z: 0 };
    const { distanceM, dot } = attentionDistanceAndDot(anchor, forward, { x: 1, y: 2, z: 3 });
    expect(distanceM).toBe(0);
    expect(Number.isFinite(dot)).toBe(true);
  });

  it('regression (#1592): an item behind the shopper must not register as in view, even though it would from a trailing chase camera\'s own position', () => {
    const shopperAnchor = { x: 0, y: 0, z: 0 };
    const forward = { x: 0, y: 1, z: 0 }; // shopper (and camera) facing +y
    const itemBehindShopper = { x: 0, y: -2, z: 0 }; // 2m behind the shopper

    // Correct: anchored on the shopper's own position.
    const correct = attentionDistanceAndDot(shopperAnchor, forward, itemBehindShopper);
    expect(correct.dot).toBeLessThan(0);

    // The bug this replaced: anchoring on a chase camera trailing 4.2m
    // behind the shopper along `forward` puts the camera at y=-4.2 — from
    // there, the item at y=-2 is actually *ahead* of the camera (dot > 0),
    // which is exactly how #1592's "reaches behind himself" symptom
    // happened.
    const trailingCameraAnchor = { x: 0, y: -4.2, z: 0 };
    const fromTrailingCamera = attentionDistanceAndDot(trailingCameraAnchor, forward, itemBehindShopper);
    expect(fromTrailingCamera.dot).toBeGreaterThan(0);
  });
});

describe('yawRotatedForward', () => {
  it('returns the same vector unchanged when the two yaws match', () => {
    const forward = { x: 0.6, y: 0.8, z: 0.1 };
    expect(yawRotatedForward(forward, 1.2, 1.2)).toEqual(forward);
  });

  it('rotates a horizontal forward vector by the angular difference between the yaws', () => {
    const forward = { x: 0, y: 1, z: 0 };
    const rotated = yawRotatedForward(forward, 0, Math.PI / 2);
    expect(rotated.x).toBeCloseTo(-1, 10);
    expect(rotated.y).toBeCloseTo(0, 10);
    expect(rotated.z).toBeCloseTo(0, 10);
  });

  it('carries the input z component through unchanged', () => {
    const forward = { x: 1, y: 0, z: 0.5 };
    const rotated = yawRotatedForward(forward, 0, Math.PI);
    expect(rotated.z).toBe(0.5);
  });

  it('regression (#1814): a body facing away from an item the camera is still looking at must not register as in view', () => {
    const anchor = { x: 0, y: 0, z: 0 };
    const itemAheadOfCamera = { x: 0, y: 5, z: 0 }; // 5m along the camera's own look direction
    const cameraForward = { x: 0, y: 1, z: 0 };
    const cameraYaw = 0;

    // The old bug: gating directly on the camera's forward registers the
    // item as in view regardless of which way the avatar's body faces.
    const fromCamera = attentionDistanceAndDot(anchor, cameraForward, itemAheadOfCamera);
    expect(fromCamera.dot).toBeGreaterThan(0);

    // The fix: with the avatar's body turned 180 degrees away from the
    // camera's own look direction (backed up facing away from the item),
    // the body-facing-derived forward must report the item as behind it.
    const avatarFacing = Math.PI;
    const bodyForward = yawRotatedForward(cameraForward, cameraYaw, avatarFacing);
    const fromBody = attentionDistanceAndDot(anchor, bodyForward, itemAheadOfCamera);
    expect(fromBody.dot).toBeLessThan(0);
  });
});

describe('hasSustainedAttention', () => {
  it('is false with no target regardless of elapsed time', () => {
    expect(hasSustainedAttention(null, 100, 1.5)).toBe(false);
  });

  it('is false before the dwell threshold is reached', () => {
    expect(hasSustainedAttention('a', 1.49, 1.5)).toBe(false);
  });

  it('is true once the dwell threshold is reached or passed', () => {
    expect(hasSustainedAttention('a', 1.5, 1.5)).toBe(true);
    expect(hasSustainedAttention('a', 5, 1.5)).toBe(true);
  });
});
