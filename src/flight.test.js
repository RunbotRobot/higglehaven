import { describe, expect, it } from 'vitest';
import { smoothstep, takeoffAltitudeM, landingAltitudeM, flightSpeedMultiplier } from './flight.js';

describe('smoothstep', () => {
  it('returns 0 at x=0 and 1 at x=1', () => {
    expect(smoothstep(0)).toBe(0);
    expect(smoothstep(1)).toBe(1);
  });

  it('is exactly 0.5 at the midpoint', () => {
    expect(smoothstep(0.5)).toBe(0.5);
  });

  it('clamps below 0 and above 1, matching THREE.MathUtils.smoothstep(x, 0, 1)', () => {
    expect(smoothstep(-1)).toBe(0);
    expect(smoothstep(2)).toBe(1);
  });

  it('eases — the derivative is 0 at both ends, so values start/end slower than a linear ramp', () => {
    expect(smoothstep(0.1)).toBeLessThan(0.1);
    expect(smoothstep(0.9)).toBeGreaterThan(0.9);
  });
});

describe('takeoffAltitudeM', () => {
  it('starts on the ground and reaches the hover altitude exactly at durationS', () => {
    expect(takeoffAltitudeM(0, 1, 3)).toBe(0);
    expect(takeoffAltitudeM(1, 1, 3)).toBe(3);
  });

  it('holds at the hover altitude past durationS rather than overshooting', () => {
    expect(takeoffAltitudeM(5, 1, 3)).toBe(3);
  });

  it('is partway up at the midpoint, matching smoothstep', () => {
    expect(takeoffAltitudeM(0.5, 1, 3)).toBeCloseTo(smoothstep(0.5) * 3, 10);
  });
});

describe('landingAltitudeM', () => {
  it('starts at the captured altitude and reaches the ground exactly at durationS', () => {
    expect(landingAltitudeM(0, 2, 12)).toBe(12);
    expect(landingAltitudeM(2, 2, 12)).toBe(0);
  });

  it('stays at the ground past durationS rather than going negative', () => {
    expect(landingAltitudeM(10, 2, 12)).toBe(0);
  });

  it('descends from whatever altitude landing actually started at, not a fixed height', () => {
    expect(landingAltitudeM(1, 2, 100)).toBeCloseTo((1 - smoothstep(0.5)) * 100, 10);
  });
});

describe('flightSpeedMultiplier', () => {
  it('is exactly the reference multiplier at the reference altitude', () => {
    expect(flightSpeedMultiplier(10, { refAltitudeM: 10, refMultiplier: 10 })).toBeCloseTo(10, 10);
  });

  it('gives ~1.5x speed for each doubling of altitude, per the spec\'s governing rule', () => {
    const base = flightSpeedMultiplier(20, { refAltitudeM: 10, refMultiplier: 10, minMultiplier: 0, maxMultiplier: 1000 });
    const doubled = flightSpeedMultiplier(40, { refAltitudeM: 10, refMultiplier: 10, minMultiplier: 0, maxMultiplier: 1000 });
    expect(doubled / base).toBeCloseTo(1.5, 10);
  });

  it('clamps to the minimum multiplier near the ground rather than diverging to 0', () => {
    expect(flightSpeedMultiplier(0, { minMultiplier: 1 })).toBe(1);
    expect(flightSpeedMultiplier(-5, { minMultiplier: 1 })).toBe(1);
  });

  it('clamps to the maximum multiplier at extreme altitude', () => {
    expect(flightSpeedMultiplier(1000000, { maxMultiplier: 100 })).toBe(100);
  });

  it('reaches ~100x by ~500m with the app\'s actual production constants — the spec\'s own anchor points', () => {
    const options = { refAltitudeM: 10, refMultiplier: 10, exponent: Math.log2(1.5), minMultiplier: 1, maxMultiplier: 100 };
    expect(flightSpeedMultiplier(10, options)).toBeCloseTo(10, 5); // "~10x near building-height"
    // Landing exactly on 100 would need the clamp to kick in; the spec's own
    // "~500m" is itself approximate, and the unclamped curve at 500m comes
    // in just under the 100x ceiling (~98.6x) — close enough to "~100x at
    // max altitude" to confirm this is the curve the spec's numbers
    // describe, not close enough to assert as an exact value.
    expect(flightSpeedMultiplier(500, options)).toBeGreaterThan(95);
    expect(flightSpeedMultiplier(500, options)).toBeLessThan(100);
  });

  it('defaults to the same production constants when no options are passed', () => {
    expect(flightSpeedMultiplier(10)).toBeCloseTo(10, 5);
  });
});
