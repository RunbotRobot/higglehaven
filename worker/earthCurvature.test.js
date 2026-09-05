import { describe, expect, it } from 'vitest';
import { curvedPosition, DEFAULT_EARTH_RADIUS_M, flatPosition, footprintScaleAtHeight } from './earthCurvature.js';

// A small, easy-to-verify radius rather than DEFAULT_EARTH_RADIUS_M's real
// scale — the math is identical either way (every function takes the
// radius as a parameter for exactly this reason), and round numbers make
// the expected values checkable by hand.
const R = 1000;

describe('earth curvature', () => {
  it('maps the world origin to itself, at any height', () => {
    expect(curvedPosition({ x: 0, y: 0, z: 0 }, R)).toEqual({ x: 0, y: 0, z: 0 });
    expect(curvedPosition({ x: 0, y: 0, z: 5 }, R)).toEqual({ x: 0, y: 0, z: 5 });
    expect(curvedPosition({ x: 0, y: 0, z: -5 }, R)).toEqual({ x: 0, y: 0, z: -5 });
  });

  it('drops ground level below the flat plane as distance from the origin grows', () => {
    const near = curvedPosition({ x: 10, y: 0, z: 0 }, R);
    const far = curvedPosition({ x: 100, y: 0, z: 0 }, R);
    expect(near.z).toBeLessThan(0);
    expect(far.z).toBeLessThan(near.z);
  });

  it('stays close to the flat-map identity for small distances relative to the radius', () => {
    // At d << R, curvature is a second-order effect: x/y barely move, z's
    // drop is small and follows the standard small-angle approximation
    // -d^2 / (2R).
    const d = 1; // 1 in 1000 — well inside "small" for this check
    const point = curvedPosition({ x: d, y: 0, z: 0 }, R);
    expect(point.x).toBeCloseTo(d, 3);
    expect(point.y).toBeCloseTo(0, 6);
    expect(point.z).toBeCloseTo(-(d * d) / (2 * R), 6);
  });

  it('quarter-way around the sphere, the origin\'s "up" direction has become sideways', () => {
    // At d = (pi/2) * R, phi = pi/2 — the point sits at the sphere's own
    // "equator" relative to the origin's pole: as far outward (x) as
    // possible, and a full radius below the origin along z (the origin's
    // local +z axis now points radially outward through this point, not
    // "up" in any sense this point would recognize).
    const quarterway = curvedPosition({ x: (Math.PI / 2) * R, y: 0, z: 0 }, R);
    expect(quarterway.x).toBeCloseTo(R, 6);
    expect(quarterway.y).toBeCloseTo(0, 6);
    expect(quarterway.z).toBeCloseTo(-R, 6);
  });

  it('respects bearing — curvature drops z the same way in every direction', () => {
    const east = curvedPosition({ x: 50, y: 0, z: 0 }, R);
    const north = curvedPosition({ x: 0, y: 50, z: 0 }, R);
    const southwest = curvedPosition({ x: -50 / Math.SQRT2, y: -50 / Math.SQRT2, z: 0 }, R);
    expect(east.z).toBeCloseTo(north.z, 9);
    expect(east.z).toBeCloseTo(southwest.z, 9);
    expect(Math.hypot(east.x, east.y)).toBeCloseTo(Math.hypot(north.x, north.y), 9);
  });

  it('round-trips an arbitrary flat point through curvedPosition and back', () => {
    for (const flat of [
      { x: 15.811, y: -15.811, z: 2 },
      { x: -200, y: 300, z: -1.5 },
      { x: 0, y: 400, z: 0 },
      { x: (Math.PI / 3) * R, y: 0, z: 10 },
    ]) {
      const curved = curvedPosition(flat, R);
      const roundTripped = flatPosition(curved, R);
      expect(roundTripped.x).toBeCloseTo(flat.x, 6);
      expect(roundTripped.y).toBeCloseTo(flat.y, 6);
      expect(roundTripped.z).toBeCloseTo(flat.z, 6);
    }
  });

  it('flatPosition inverts the origin (and straight up/down from it) without dividing by zero', () => {
    expect(flatPosition({ x: 0, y: 0, z: 0 }, R)).toEqual({ x: 0, y: 0, z: 0 });
    expect(flatPosition({ x: 0, y: 0, z: 7 }, R)).toEqual({ x: 0, y: 0, z: 7 });
    // Exactly at Earth's center: radiusFromCenter is 0, the one point this
    // module has no flat-map answer for — must return a defined value, not
    // NaN from a 0/0 division.
    const atCenter = flatPosition({ x: 0, y: 0, z: -R }, R);
    expect(Number.isNaN(atCenter.x)).toBe(false);
    expect(Number.isNaN(atCenter.y)).toBe(false);
    expect(atCenter.z).toBeCloseTo(-R, 9);
  });

  it('uses the real Earth radius by default', () => {
    expect(DEFAULT_EARTH_RADIUS_M).toBe(6371000);
    const point = curvedPosition({ x: 31.6, y: 0, z: 0 });
    // At an actual landlet's own scale (~31.6m across), curvature is
    // genuinely imperceptible — a fraction of a millimeter of drop (d^2 /
    // 2R ≈ 0.08mm here) — but it must still be a real, non-exactly-zero,
    // correctly-signed value, not a silently-flat placeholder.
    expect(point.z).toBeLessThan(0);
    expect(point.z).toBeGreaterThan(-1e-3);
  });
});

describe('footprintScaleAtHeight', () => {
  it('is exactly 1 at ground level, regardless of radius', () => {
    expect(footprintScaleAtHeight(0, R)).toBe(1);
    expect(footprintScaleAtHeight(0, DEFAULT_EARTH_RADIUS_M)).toBe(1);
  });

  it('is greater than 1 above ground and less than 1 below ground', () => {
    expect(footprintScaleAtHeight(10, R)).toBeGreaterThan(1);
    expect(footprintScaleAtHeight(-10, R)).toBeLessThan(1);
  });

  it('scales linearly with height, matching curvedPosition\'s own radiusFromCenter', () => {
    expect(footprintScaleAtHeight(100, R)).toBeCloseTo(1.1, 9);
    expect(footprintScaleAtHeight(-100, R)).toBeCloseTo(0.9, 9);
    expect(footprintScaleAtHeight(R, R)).toBeCloseTo(2, 9); // a full radius up: double distance from center
  });

  it('is genuinely close to 1 (imperceptible) at an actual lándlet\'s real-world scale', () => {
    // LANDLET_HEIGHT_M (src/main.js) is 10 — the same "architecturally
    // correct, practically invisible" scale as curvedPosition's own ground-
    // drop at landlet width, per this module's header comment.
    const scale = footprintScaleAtHeight(10, DEFAULT_EARTH_RADIUS_M);
    expect(scale).toBeGreaterThan(1);
    expect(scale).toBeCloseTo(1, 5);
  });
});
