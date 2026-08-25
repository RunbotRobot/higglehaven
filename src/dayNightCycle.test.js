// Pure math, no THREE.js/DOM dependency — see dayNightCycle.js's own
// header comment for why that matters (unit-testable at all, unlike
// everything else visual/time-driven in this app's frontend, which this
// project has consistently verified manually instead — see docs/API.md's
// "Community signs"/"Frontend-only alignment assist" sections).
import { describe, expect, it } from 'vitest';
import { getDayNightState, phaseNameAt } from './dayNightCycle.js';

const HOUR_MS = 60 * 60 * 1000;

describe('phaseNameAt', () => {
  it('divides the cycle into four equal named phases', () => {
    expect(phaseNameAt(0)).toBe('daylight');
    expect(phaseNameAt(0.1)).toBe('daylight');
    expect(phaseNameAt(0.25)).toBe('dusk');
    expect(phaseNameAt(0.4)).toBe('dusk');
    expect(phaseNameAt(0.5)).toBe('night');
    expect(phaseNameAt(0.6)).toBe('night');
    expect(phaseNameAt(0.75)).toBe('dawn');
    expect(phaseNameAt(0.99)).toBe('dawn');
  });
});

describe('getDayNightState', () => {
  it('starts at full daylight at t=0', () => {
    const state = getDayNightState(0, 4);
    expect(state.phase).toBe('daylight');
    expect(state.skyColorHex).toBe(0x87ceeb);
    expect(state.sunIntensity).toBe(1.2);
    expect(state.ambientIntensity).toBe(0.6);
  });

  it('reaches full night at the halfway point of a 4-hour cycle', () => {
    const state = getDayNightState(2 * HOUR_MS, 4);
    expect(state.phase).toBe('night');
    expect(state.sunIntensity).toBeCloseTo(0.12);
    expect(state.skyColorHex).toBe(0x0a1030);
  });

  it('interpolates smoothly between two keyframes, not jumping', () => {
    // Halfway through the daylight->dusk transition (1 hour into a
    // 4-hour cycle is the dusk keyframe itself; half an hour in is
    // exactly midway between the two).
    const state = getDayNightState(0.5 * HOUR_MS, 4);
    expect(state.sunIntensity).toBeCloseTo((1.2 + 0.7) / 2, 5);
    expect(state.ambientIntensity).toBeCloseTo((0.6 + 0.45) / 2, 5);
  });

  it('wraps back to daylight after a full cycle, repeatedly', () => {
    const oneCycle = getDayNightState(4 * HOUR_MS, 4);
    const threeCycles = getDayNightState(12 * HOUR_MS, 4);
    expect(oneCycle.phase).toBe('daylight');
    expect(oneCycle.skyColorHex).toBe(0x87ceeb);
    expect(threeCycles).toEqual(oneCycle);
  });

  it('scales to a differently-configured cycle length', () => {
    // An 8-hour cycle's night keyframe lands at the 4-hour mark instead
    // of 2 hours — same fractional progress (t=0.5), just stretched.
    const state = getDayNightState(4 * HOUR_MS, 8);
    expect(state.phase).toBe('night');
    expect(state.skyColorHex).toBe(0x0a1030);
  });

  it('handles a negative or pre-epoch timestamp without producing NaN', () => {
    const state = getDayNightState(-HOUR_MS, 4);
    expect(Number.isNaN(state.t)).toBe(false);
    expect(state.t).toBeGreaterThanOrEqual(0);
    expect(state.t).toBeLessThan(1);
    expect(['daylight', 'dusk', 'night', 'dawn']).toContain(state.phase);
  });
});
