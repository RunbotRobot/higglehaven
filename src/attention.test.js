import { describe, expect, it } from 'vitest';
import {
  hasSustainedAttention,
  isWithinAttentionRange,
  nextAttentionElapsedS,
  pickNearestInRange,
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
