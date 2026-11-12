import { describe, expect, it } from 'vitest';
import {
  idleState, waypoint, headingToward, hashString,
  IDLE_WANDER_RADIUS_M, IDLE_SEGMENT_MS, IDLE_WALK_MS, IDLE_FACE_RANGE_M,
} from './assistantIdle.js';

const T0 = 1_700_000_000_000;

describe('assistantIdle (#3449)', () => {
  it('is the same for the same name and time, and differs between names', () => {
    const a = idleState({ seed: 'Juniper', nowMs: T0 + 1234 });
    expect(idleState({ seed: 'Juniper', nowMs: T0 + 1234 })).toEqual(a);
    const samples = (name) => Array.from({ length: 40 }, (_, i) => idleState({ seed: name, nowMs: T0 + i * 2500 }).x);
    expect(samples('Juniper')).not.toEqual(samples('Clover'));
  });

  it('never strays further than the wander radius from its placed spot', () => {
    for (const name of ['Juniper', 'Clover', 'Fig', 'Sorrel']) {
      for (let ms = 0; ms < 20 * IDLE_SEGMENT_MS; ms += 250) {
        const s = idleState({ seed: name, nowMs: T0 + ms });
        expect(Math.hypot(s.x, s.y)).toBeLessThanOrEqual(IDLE_WANDER_RADIUS_M + 1e-9);
      }
    }
  });

  it('moves smoothly: no jump larger than a slow walk between frames', () => {
    let prev = idleState({ seed: 'Fern', nowMs: T0 });
    for (let ms = 16; ms < 10 * IDLE_SEGMENT_MS; ms += 16) {
      const s = idleState({ seed: 'Fern', nowMs: T0 + ms });
      const speed = Math.hypot(s.x - prev.x, s.y - prev.y) / 0.016;
      expect(speed).toBeLessThan(1.6); // an unhurried walk, well under the 1.8 m/s walking speed
      prev = s;
    }
  });

  it('steps for a few seconds of each cycle and stands the rest', () => {
    let moving = 0;
    let total = 0;
    for (let ms = 0; ms < 30 * IDLE_SEGMENT_MS; ms += 100) {
      total += 1;
      if (idleState({ seed: 'Maple', nowMs: T0 + ms }).moving) moving += 1;
    }
    const share = moving / total;
    expect(share).toBeGreaterThan(0.05);
    expect(share).toBeLessThan(IDLE_WALK_MS / IDLE_SEGMENT_MS + 0.02);
  });

  it('two assistants do not wander in step', () => {
    let together = 0;
    let total = 0;
    for (let ms = 0; ms < 30 * IDLE_SEGMENT_MS; ms += 100) {
      total += 1;
      const a = idleState({ seed: 'Juniper', nowMs: T0 + ms }).moving;
      const b = idleState({ seed: 'Clover', nowMs: T0 + ms }).moving;
      if (a && b) together += 1;
    }
    expect(together / total).toBeLessThan(0.15);
  });

  it('turns to face the direction of its steps while walking', () => {
    for (let ms = 0; ms < 40 * IDLE_SEGMENT_MS; ms += 100) {
      const a = idleState({ seed: 'Tansy', nowMs: T0 + ms });
      if (!a.moving) continue;
      const b = idleState({ seed: 'Tansy', nowMs: T0 + ms + 50 });
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      if (Math.hypot(dx, dy) < 1e-4) continue;
      const diff = Math.abs(((a.heading - headingToward(dx, dy) + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      expect(diff).toBeLessThan(0.05); // equal modulo a full turn
    }
  });

  it('a free assistant standing still faces a nearby shopper, and ignores a distant one', () => {
    let faced = false;
    for (let ms = 0; ms < 20 * IDLE_SEGMENT_MS && !faced; ms += 100) {
      const s = idleState({ seed: 'Basil', nowMs: T0 + ms, toShopper: { dx: 3, dy: 0 } });
      if (s.moving) continue;
      expect(s.heading).toBeCloseTo(headingToward(3, 0));
      faced = true;
    }
    expect(faced).toBe(true);
    const far = idleState({ seed: 'Basil', nowMs: T0, toShopper: { dx: IDLE_FACE_RANGE_M + 1, dy: 0 }, baseHeading: 0.7 });
    if (!far.moving) expect(far.heading).not.toBeCloseTo(headingToward(IDLE_FACE_RANGE_M + 1, 0));
  });

  it('a busy assistant stays exactly where it is, and faces the person it is with', () => {
    for (let ms = 0; ms < 5 * IDLE_SEGMENT_MS; ms += 500) {
      const s = idleState({ seed: 'Moss', nowMs: T0 + ms, busy: true, toShopper: { dx: 0, dy: 2 } });
      expect(s).toMatchObject({ x: 0, y: 0, moving: false });
      expect(s.heading).toBeCloseTo(headingToward(0, 2));
    }
    expect(idleState({ seed: 'Moss', nowMs: T0, busy: true, baseHeading: 1.2 }).heading).toBe(1.2);
  });

  it('heading convention matches the rest of the app (front is +Y)', () => {
    expect(headingToward(0, 1)).toBeCloseTo(0);
    expect(headingToward(-1, 0)).toBeCloseTo(Math.PI / 2);
  });

  it('waypoints are inside the disc and the hash is stable', () => {
    for (let k = 0; k < 200; k += 1) {
      const p = waypoint('Sage', k);
      expect(Math.hypot(p.x, p.y)).toBeLessThanOrEqual(IDLE_WANDER_RADIUS_M + 1e-9);
    }
    expect(hashString('Juniper')).toBe(hashString('Juniper'));
    expect(hashString('Juniper')).not.toBe(hashString('Clover'));
  });
});
