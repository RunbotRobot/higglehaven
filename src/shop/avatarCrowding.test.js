import { describe, it, expect } from 'vitest';
import { crowdAdjustedStep, AVATAR_HARD_RADIUS_M, AVATAR_SOFT_ZONE_M } from './avatarCrowding.js';

describe('crowdAdjustedStep (#4389)', () => {
  const other = { x: 0, y: 0 };
  it('leaves a step alone when nobody is near', () => {
    expect(crowdAdjustedStep(5, 0, -0.1, 0, [other])).toEqual({ dx: -0.1, dy: 0 });
  });
  it('slows a step toward someone inside the soft zone, more the closer', () => {
    const far = crowdAdjustedStep(AVATAR_HARD_RADIUS_M + AVATAR_SOFT_ZONE_M * 0.8, 0, -0.1, 0, [other]);
    const near = crowdAdjustedStep(AVATAR_HARD_RADIUS_M + AVATAR_SOFT_ZONE_M * 0.2, 0, -0.1, 0, [other]);
    expect(far.dx).toBeLessThan(0);
    expect(Math.abs(near.dx)).toBeLessThan(Math.abs(far.dx));
    expect(Math.abs(far.dx)).toBeLessThan(0.1);
  });
  it('stops a step toward someone at the hard barrier but slides sideways', () => {
    const r = crowdAdjustedStep(AVATAR_HARD_RADIUS_M, 0, -0.1, 0.05, [other]);
    expect(r.dx).toBeCloseTo(0, 9);
    expect(r.dy).toBeCloseTo(0.05, 9);
  });
  it('never resists a step away, even from inside the barrier', () => {
    expect(crowdAdjustedStep(0.3, 0, 0.1, 0, [other])).toEqual({ dx: 0.1, dy: 0 });
  });
});
