import { describe, expect, it } from 'vitest';
import { assistantSpot } from './lib/assistant-shift.js';

// #3449: where an assistant stands is a pure function of its name and the public landlets.
const lands = [
  { landlet_id: 'b', center_x_m: 100, center_y_m: 0, elevation_m: 2 },
  { landlet_id: 'a', center_x_m: 0, center_y_m: 0, elevation_m: null },
];

describe('assistantSpot', () => {
  it('is null with no public land', () => {
    expect(assistantSpot('Juniper', [])).toBeNull();
  });
  it('is stable, on a public landlet, and near its centre', () => {
    const one = assistantSpot('Juniper', lands);
    expect(assistantSpot('juniper', [...lands].reverse())).toEqual(one);
    const land = lands.find((l) => l.landlet_id === one.landletId);
    expect(Math.hypot(one.x - land.center_x_m, one.y - land.center_y_m)).toBeLessThan(10);
    expect(one.z).toBe(land.elevation_m ?? 0);
  });
  it('gives two assistants on one landlet different points', () => {
    const one = assistantSpot('Juniper', [lands[1]]);
    const two = assistantSpot('Clover', [lands[1]]);
    expect(one.landletId).toBe(two.landletId);
    expect(one.x === two.x && one.y === two.y).toBe(false);
  });
});
