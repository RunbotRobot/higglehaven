import { describe, expect, it } from 'vitest';
import { easedPitch, shouldLevelOnLanding, LANDING_LEVEL_PITCH, LANDING_LEVEL_EASE_S } from './landingLevel.js';

describe('easedPitch (#4044)', () => {
  it('starts where the view is and ends level, with no jolt at either end', () => {
    expect(easedPitch(-1, 0, 0, 0.5)).toBe(-1);
    expect(easedPitch(-1, 0, 0.5, 0.5)).toBe(0);
    expect(easedPitch(-1, 0, 0.25, 0.5)).toBeCloseTo(-0.5, 6);
    const early = easedPitch(-1, 0, 0.02, 0.5);
    expect(early).toBeGreaterThan(-1);
    expect(early).toBeLessThan(-0.99);
  });
  it('rises monotonically and never passes level', () => {
    let last = -1.2;
    for (let t = 0; t <= 0.7; t += 0.05) {
      const p = easedPitch(-1.2, 0, t, LANDING_LEVEL_EASE_S);
      expect(p).toBeGreaterThanOrEqual(last);
      expect(p).toBeLessThanOrEqual(0);
      last = p;
    }
  });
  it('leaves a view that is already level or looking up alone', () => {
    expect(easedPitch(0.3, 0, 0.2, 0.5)).toBe(0.3);
    expect(easedPitch(0, 0, 0.2, 0.5)).toBe(0);
  });
});

describe('shouldLevelOnLanding (#4044)', () => {
  it('levels a view that looks down, not one that is level or up', () => {
    expect(shouldLevelOnLanding(-0.6, true)).toBe(true);
    expect(shouldLevelOnLanding(LANDING_LEVEL_PITCH, true)).toBe(false);
    expect(shouldLevelOnLanding(0.4, true)).toBe(false);
  });
  it('does nothing when switched off', () => {
    expect(shouldLevelOnLanding(-0.6, false)).toBe(false);
  });
});
