import { describe, expect, it } from 'vitest';
import {
  EARTH_RADIUS_M,
  curvatureDropM,
  earthCenteredToLocal,
  localToEarthCentered,
  localUpDirection,
} from './earthCurvature.js';

describe('Earth-curvature coordinate math', () => {
  it('maps the local origin straight up to (0, 0, earthRadiusM)', () => {
    expect(localToEarthCentered(0, 0, 0)).toEqual({ x: 0, y: 0, z: EARTH_RADIUS_M });
  });

  it('extends height at the origin straight out along the same axis', () => {
    expect(localToEarthCentered(0, 0, 25)).toEqual({ x: 0, y: 0, z: EARTH_RADIUS_M + 25 });
  });

  it('keeps every Earth-centered point at radius earthRadiusM + z from Earth\'s center', () => {
    const point = localToEarthCentered(1200, -800, 40);
    const distanceFromCenter = Math.hypot(point.x, point.y, point.z);
    expect(distanceFromCenter).toBeCloseTo(EARTH_RADIUS_M + 40, 6);
  });

  it('round-trips local -> Earth-centered -> local back to the original point', () => {
    // Precision to 3 decimal places (millimeters) rather than machine
    // epsilon: acos's derivative blows up as its argument approaches 1,
    // which is exactly what happens here since z / radiusFromCenter sits
    // extremely close to 1 at any of these plausible in-game distances
    // (a few kilometers) against Earth's own ~6,371km radius — amplifying
    // ordinary floating-point rounding well past double precision's usual
    // ~1e-15 relative error. Millimeter precision is still far tighter
    // than this app needs anywhere.
    for (const [x, y, z] of [
      [0, 0, 0],
      [500, 0, 0],
      [0, -500, 12],
      [-3000, 4000, -8],
      [120_000, -85_000, 300],
    ]) {
      const earthPosition = localToEarthCentered(x, y, z);
      const back = earthCenteredToLocal(earthPosition);
      expect(back.x).toBeCloseTo(x, 3);
      expect(back.y).toBeCloseTo(y, 3);
      expect(back.z).toBeCloseTo(z, 3);
    }
  });

  it('matches the flat-plane approximation closely at short range', () => {
    // At a few hundred meters — well within any current landlet/world
    // radius — Earth's curvature should be imperceptible: the curved
    // transform's horizontal placement should barely differ from just
    // treating (x, y) as literally flat.
    const point = localToEarthCentered(300, 400, 0);
    const flatDistance = Math.hypot(300, 400);
    const curvedHorizontalDistance = Math.hypot(point.x, point.y);
    expect(curvedHorizontalDistance).toBeCloseTo(flatDistance, 3);
  });

  it('produces the up direction (0, 0, 1) at the origin', () => {
    expect(localUpDirection(0, 0)).toEqual({ x: 0, y: 0, z: 1 });
  });

  it('tilts the up direction away from (0, 0, 1) farther from the origin', () => {
    const up = localUpDirection(500_000, 0);
    expect(up.z).toBeLessThan(1);
    expect(up.x).toBeGreaterThan(0);
    expect(up.y).toBeCloseTo(0, 9);
    // Always a unit vector, regardless of distance from the origin.
    expect(Math.hypot(up.x, up.y, up.z)).toBeCloseTo(1, 9);
  });

  it('matches localToEarthCentered\'s own direction of travel for z', () => {
    const flatX = 200_000;
    const flatY = -150_000;
    const up = localUpDirection(flatX, flatY);
    const low = localToEarthCentered(flatX, flatY, 0);
    const high = localToEarthCentered(flatX, flatY, 10);
    const delta = { x: high.x - low.x, y: high.y - low.y, z: high.z - low.z };
    const deltaLength = Math.hypot(delta.x, delta.y, delta.z);
    expect(deltaLength).toBeCloseTo(10, 6);
    expect(delta.x / deltaLength).toBeCloseTo(up.x, 6);
    expect(delta.y / deltaLength).toBeCloseTo(up.y, 6);
    expect(delta.z / deltaLength).toBeCloseTo(up.z, 6);
  });

  it('has zero curvature drop at the origin and grows with distance', () => {
    expect(curvatureDropM(0)).toBe(0);
    const near = curvatureDropM(1000);
    const far = curvatureDropM(10_000);
    expect(near).toBeGreaterThan(0);
    expect(far).toBeGreaterThan(near);
    // Sagitta approximation (d^2 / 2R) should be very close at this range.
    expect(near).toBeCloseTo((1000 ** 2) / (2 * EARTH_RADIUS_M), 6);
  });

  it('supports a custom earth radius for every function, not just the default', () => {
    const smallRadius = 1000;
    const point = localToEarthCentered(200, 0, 5, smallRadius);
    expect(Math.hypot(point.x, point.y, point.z)).toBeCloseTo(smallRadius + 5, 6);
    const back = earthCenteredToLocal(point, smallRadius);
    expect(back.x).toBeCloseTo(200, 6);
    expect(back.y).toBeCloseTo(0, 6);
    expect(back.z).toBeCloseTo(5, 6);
    expect(curvatureDropM(200, smallRadius)).toBeGreaterThan(curvatureDropM(200, EARTH_RADIUS_M));
  });
});
