import { describe, it, expect } from 'vitest';
import {
  climbFactor, verticalRateM_S, bodyTiltOffsetRad, pathAngleRad, horizontalForwardScale, FLIGHT_MAX_PATH_ANGLE_RAD,
  FLIGHT_PITCH_DEADZONE_RAD, FLIGHT_PITCH_FULL_RAD, FLIGHT_BODY_TILT_RANGE_RAD,
} from './flightPitch.js';

describe('flight by view pitch (#3769)', () => {
  it('a level or nearly level view flies level', () => {
    expect(climbFactor(0)).toBe(0);
    expect(climbFactor(FLIGHT_PITCH_DEADZONE_RAD)).toBe(0);
    expect(climbFactor(-FLIGHT_PITCH_DEADZONE_RAD * 0.9)).toBe(0);
  });
  it('looking up climbs and looking down descends, at full speed by 30 degrees', () => {
    expect(climbFactor(FLIGHT_PITCH_FULL_RAD)).toBeCloseTo(1);
    expect(climbFactor(-FLIGHT_PITCH_FULL_RAD)).toBeCloseTo(-1);
    expect(climbFactor(Math.PI / 2)).toBe(1);
    expect(climbFactor(0.3)).toBeGreaterThan(0);
    expect(climbFactor(-0.3)).toBeLessThan(0);
  });
  it('rises smoothly with the view', () => {
    let last = 0;
    for (let deg = 5; deg <= 30; deg += 5) {
      const f = climbFactor((deg * Math.PI) / 180);
      expect(f).toBeGreaterThan(last);
      last = f;
    }
  });
  it('moving back reverses it and hovering holds height', () => {
    const up = 25 * (Math.PI / 180);
    expect(verticalRateM_S(up, 1, 10)).toBeGreaterThan(0);
    expect(verticalRateM_S(up, -1, 10)).toBeLessThan(0);
    expect(verticalRateM_S(up, 0, 10)).toBe(0);
    expect(verticalRateM_S(-up, 1, 10)).toBeLessThan(0);
    expect(verticalRateM_S(up, 5, 10)).toBeCloseTo(verticalRateM_S(up, 1, 10));
  });
  it('the body tips with the view inside a small range', () => {
    expect(bodyTiltOffsetRad(0)).toBe(0);
    expect(bodyTiltOffsetRad(0.2)).toBeGreaterThan(0);
    expect(bodyTiltOffsetRad(-0.2)).toBeLessThan(0);
    expect(bodyTiltOffsetRad(1.5)).toBe(FLIGHT_BODY_TILT_RANGE_RAD);
    expect(bodyTiltOffsetRad(-1.5)).toBe(-FLIGHT_BODY_TILT_RANGE_RAD);
  });

  it('keeps speed along the path: the steeper the climb, the less goes forward', () => {
    expect(horizontalForwardScale(0)).toBe(1);
    expect(pathAngleRad(FLIGHT_PITCH_FULL_RAD)).toBeCloseTo(FLIGHT_MAX_PATH_ANGLE_RAD);
    const view = 25 * (Math.PI / 180);
    const up = verticalRateM_S(view, 1, 10);
    const along = 10 * horizontalForwardScale(view);
    expect(Math.hypot(up, along)).toBeCloseTo(10);
    expect(horizontalForwardScale(Math.PI / 2)).toBeCloseTo(Math.cos(FLIGHT_MAX_PATH_ANGLE_RAD));
  });
});
