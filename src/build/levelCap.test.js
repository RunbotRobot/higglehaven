import { describe, it, expect } from 'vitest';
import { landCapRoomM2, levelFitsCap, LAND_CAP_DISPLAY_ROUNDING_BUFFER_M2 } from '../../shared/level-cap.js';

describe('level cap (#4331)', () => {
  it('has the rounding slack the Worker has always used', () => {
    expect(LAND_CAP_DISPLAY_ROUNDING_BUFFER_M2).toBe(1);
  });
  it('a level that fits exactly, or within the slack, is allowed; one beyond it is not', () => {
    expect(levelFitsCap(500, 500, 1000)).toBe(true);
    expect(levelFitsCap(500, 501, 1000)).toBe(true);
    expect(levelFitsCap(500, 502, 1000)).toBe(false);
    expect(levelFitsCap(1000, 1000, 1000)).toBe(false);
  });
  it('the room left is what a level may take, never below zero', () => {
    expect(landCapRoomM2(400, 1000)).toBe(601);
    expect(landCapRoomM2(1000, 1000)).toBe(1);
    expect(landCapRoomM2(1200, 1000)).toBe(0);
  });
  it('the room and the fit agree', () => {
    for (const [owned, cost, cap] of [[0, 1000, 1000], [250, 750, 1000], [999, 3, 1000], [300, 800, 1000]]) {
      expect(levelFitsCap(owned, cost, cap)).toBe(cost <= landCapRoomM2(owned, cap));
    }
  });
});
