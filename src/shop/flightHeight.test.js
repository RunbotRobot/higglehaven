// #4105: the edge slide that changes height while flying (src/shop/flightHeight.js), as a pure recogniser.
import { describe, it, expect } from 'vitest';
import {
  createHeightControl, slideRate, ramp, EDGE_STRIP_PX, HEIGHT_DEADZONE_PX, HEIGHT_FULL_PX,
  FLIGHT_CLIMB_FRACTION,
} from './flightHeight.js';

const W = 390;
const control = () => createHeightControl({ viewportWidth: () => W });

describe('ramps', () => {
  it('is zero inside the dead zone and full at the full distance, signed', () => {
    expect(ramp(HEIGHT_DEADZONE_PX, HEIGHT_DEADZONE_PX, HEIGHT_FULL_PX)).toBe(0);
    expect(ramp(HEIGHT_FULL_PX, HEIGHT_DEADZONE_PX, HEIGHT_FULL_PX)).toBe(1);
    expect(ramp(-500, HEIGHT_DEADZONE_PX, HEIGHT_FULL_PX)).toBe(-1);
  });
  it('a finger sliding up (negative dy) rises, down sinks', () => {
    expect(slideRate(-HEIGHT_FULL_PX)).toBe(1);
    expect(slideRate(HEIGHT_FULL_PX)).toBe(-1);
    expect(slideRate(3)).toBe(0);
  });
  it('full rise is the steepest the old pitch-climb path gave', () => {
    expect(FLIGHT_CLIMB_FRACTION).toBeCloseTo(0.766, 3);
  });
});

describe('edge slide', () => {
  it('claims a finger inside the right-edge strip while flying and rises when it slides up', () => {
    const c = control();
    expect(c.down(1, W - 10, 400, 0, true)).toBe(true);
    expect(c.move(1, W - 10, 400 - HEIGHT_FULL_PX)).toBe(true);
    expect(c.rate()).toBe(1);
    c.move(1, W - 10, 400 + HEIGHT_FULL_PX);
    expect(c.rate()).toBe(-1);
    expect(c.up(1)).toBe(true);
    expect(c.rate()).toBe(0);
  });
  it('leaves a finger just outside the strip, and any finger on the ground, to the look half', () => {
    const c = control();
    expect(c.down(1, W - EDGE_STRIP_PX - 1, 400, 0, true)).toBe(false);
    expect(c.move(1, W - EDGE_STRIP_PX - 1, 300)).toBe(false);
    expect(c.rate()).toBe(0);
    expect(c.down(2, W - 5, 400, 0, false)).toBe(false);
  });
  it('works while another thumb walks on the left', () => {
    const c = control();
    expect(c.down(1, 60, 500, 0, true)).toBe(false); // the walking thumb is not ours
    expect(c.down(2, W - 8, 500, 5, true)).toBe(true);
    c.move(2, W - 8, 500 - HEIGHT_FULL_PX);
    expect(c.rate()).toBe(1);
    expect(c.move(1, 80, 480)).toBe(false);
    expect(c.up(1)).toBe(false);
  });
  it('lets go of everything on cancel', () => {
    const c = control();
    c.down(1, W - 5, 400, 0, true);
    c.move(1, W - 5, 300);
    c.cancel();
    expect(c.rate()).toBe(0);
    expect(c.claims(1)).toBe(false);
  });
});
