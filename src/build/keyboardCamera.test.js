// #4159: Build's camera from a keyboard, as pure maths.
import { describe, expect, it } from 'vitest';
import { stepBuildCamera, ORBIT_RAD_S, TILT_RAD_S } from './keyboardCamera.js';

const none = { moveX: 0, moveY: 0, lookX: 0, lookY: 0 };
const limits = { maxPolarRad: Math.PI * 0.49, minDistance: 2, maxDistance: 500, maxTargetRadius: 500 };
// The camera 10 m south and 10 m up from the target at the origin, looking north and down.
const start = () => ({ camera: { x: 0, y: -10, z: 10 }, target: { x: 0, y: 0, z: 0 } });
const dist = (v) => Math.hypot(v.camera.x - v.target.x, v.camera.y - v.target.y, v.camera.z - v.target.z);

describe('stepBuildCamera', () => {
  it('changes nothing when no key is held', () => {
    const view = start();
    expect(stepBuildCamera(view, none, 0, 0.1, limits)).toBe(view);
  });

  it('forward moves the view over the ground the way it faces (north here), camera and target together', () => {
    const next = stepBuildCamera(start(), { ...none, moveY: -1 }, 0, 0.5, limits);
    expect(next.target.y).toBeGreaterThan(0);
    expect(next.target.x).toBeCloseTo(0, 6);
    expect(next.camera.y - next.target.y).toBeCloseTo(-10, 6); // the offset between them is unchanged
    expect(next.camera.z).toBeCloseTo(10, 6);
  });

  it('right moves the view to the right of where it faces (east here)', () => {
    const next = stepBuildCamera(start(), { ...none, moveX: 1 }, 0, 0.5, limits);
    expect(next.target.x).toBeGreaterThan(0);
    expect(next.target.y).toBeCloseTo(0, 6);
  });

  it('turning right moves the camera to its own right and keeps its distance and height', () => {
    const view = start();
    const next = stepBuildCamera(view, { ...none, lookX: 1 }, 0, 0.5, limits);
    expect(next.camera.x).toBeGreaterThan(0); // from the south, its right is east
    expect(dist(next)).toBeCloseTo(dist(view), 6);
    expect(next.camera.z).toBeCloseTo(10, 6);
    expect(next.target).toEqual(view.target);
    const angle = Math.atan2(next.camera.y, next.camera.x) - Math.atan2(view.camera.y, view.camera.x);
    expect(angle).toBeCloseTo(0.5 * ORBIT_RAD_S, 6);
  });

  it('looking down brings the camera over the target and never past the top-down or the horizon limit', () => {
    const down = stepBuildCamera(start(), { ...none, lookY: 1 }, 0, 0.2, limits);
    expect(down.camera.z).toBeGreaterThan(10);
    expect(dist(down)).toBeCloseTo(dist(start()), 6);
    const top = stepBuildCamera(start(), { ...none, lookY: 1 }, 0, 100, limits);
    expect(Math.hypot(top.camera.x, top.camera.y)).toBeLessThan(2); // almost overhead, not flipped over
    const up = stepBuildCamera(start(), { ...none, lookY: -1 }, 0, 100, limits);
    const phi = Math.acos((up.camera.z - up.target.z) / dist(up));
    expect(phi).toBeLessThanOrEqual(limits.maxPolarRad + 1e-9);
    expect(TILT_RAD_S).toBeGreaterThan(0);
  });

  it('page up zooms in and page down zooms out, inside the distance limits', () => {
    const view = start();
    expect(dist(stepBuildCamera(view, none, 1, 0.2, limits))).toBeLessThan(dist(view));
    expect(dist(stepBuildCamera(view, none, -1, 0.2, limits))).toBeGreaterThan(dist(view));
    expect(dist(stepBuildCamera(view, none, 1, 100, limits))).toBeCloseTo(limits.minDistance, 6);
    expect(dist(stepBuildCamera(view, none, -1, 100, limits))).toBeCloseTo(limits.maxDistance, 6);
  });

  it('the view stays inside the radius it may wander to', () => {
    const next = stepBuildCamera(start(), { ...none, moveY: -1 }, 0, 1000, limits);
    expect(Math.hypot(next.target.x, next.target.y)).toBeLessThanOrEqual(limits.maxTargetRadius + 1e-6);
  });
});
