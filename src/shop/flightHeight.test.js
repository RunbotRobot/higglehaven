// #4102: the three flight-height options (src/shop/flightHeight.js), as pure recognisers.
import { describe, it, expect } from 'vitest';
import {
  createHeightControl, resolveHeightMode, slideRate, pinchRate, ramp,
  EDGE_STRIP_PX, HEIGHT_DEADZONE_PX, HEIGHT_FULL_PX, PINCH_DEADZONE_PX, PINCH_FULL_PX,
  HEIGHT_STORAGE_KEY, HEIGHT_HINT_WORDS,
} from './flightHeight.js';

const W = 390;
const control = (mode, onClaim = () => {}) => createHeightControl({ mode, viewportWidth: () => W, halfX: () => W / 2, onClaim });
const memory = (initial = {}) => {
  const data = { ...initial };
  return { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); }, removeItem: (k) => { delete data[k]; }, data };
};

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
  it('fingers coming together rise, spreading apart sinks', () => {
    expect(pinchRate(200, 200 - PINCH_FULL_PX)).toBe(1);
    expect(pinchRate(200, 200 + PINCH_FULL_PX)).toBe(-1);
    expect(pinchRate(200, 200 - PINCH_DEADZONE_PX)).toBe(0);
  });
});

describe('resolveHeightMode', () => {
  it('reads the address, remembers it, and forgets it on off', () => {
    const storage = memory();
    expect(resolveHeightMode('?height=a', storage)).toBe('a');
    expect(storage.data[HEIGHT_STORAGE_KEY]).toBe('a');
    expect(resolveHeightMode('', storage)).toBe('a');
    expect(resolveHeightMode('?height=C', storage)).toBe('c');
    expect(resolveHeightMode('?height=off', storage)).toBe(null);
    expect(storage.data[HEIGHT_STORAGE_KEY]).toBeUndefined();
    expect(resolveHeightMode('', storage)).toBe(null);
  });
  it('is no choice for nothing, junk, or a remembered junk value', () => {
    expect(resolveHeightMode('', memory())).toBe(null);
    expect(resolveHeightMode('?height=z', memory())).toBe(null);
    expect(resolveHeightMode('', memory({ [HEIGHT_STORAGE_KEY]: 'zzz' }))).toBe(null);
  });
  it('still works with no storage or storage that throws', () => {
    const broken = { getItem() { throw new Error('no'); }, setItem() { throw new Error('no'); }, removeItem() { throw new Error('no'); } };
    expect(resolveHeightMode('?height=b', null)).toBe('b');
    expect(resolveHeightMode('?height=b', broken)).toBe('b');
    expect(resolveHeightMode('', broken)).toBe(null);
  });
  it('says the chosen gesture for each option, in plain words', () => {
    expect(Object.keys(HEIGHT_HINT_WORDS)).toEqual(['a', 'b', 'c']);
    for (const words of Object.values(HEIGHT_HINT_WORDS)) expect(words).not.toMatch(/#\d|height=|option/i);
  });
});

describe('A: edge slide', () => {
  it('claims a finger inside the right-edge strip while flying and rises when it slides up', () => {
    const c = control('a');
    expect(c.down(1, W - 10, 400, 0, true)).toBe(true);
    expect(c.move(1, W - 10, 400 - HEIGHT_FULL_PX)).toBe(true);
    expect(c.rate()).toBe(1);
    c.move(1, W - 10, 400 + HEIGHT_FULL_PX);
    expect(c.rate()).toBe(-1);
    expect(c.up(1, 500)).toBe(true);
    expect(c.rate()).toBe(0);
  });
  it('leaves a finger just outside the strip, and any finger on the ground, to the look half', () => {
    const c = control('a');
    expect(c.down(1, W - EDGE_STRIP_PX - 1, 400, 0, true)).toBe(false);
    expect(c.move(1, W - EDGE_STRIP_PX - 1, 300)).toBe(false);
    expect(c.rate()).toBe(0);
    expect(c.down(2, W - 5, 400, 0, false)).toBe(false);
  });
  it('works while another thumb walks on the left', () => {
    const c = control('a');
    expect(c.down(1, 60, 500, 0, true)).toBe(false); // the walking thumb is not ours
    expect(c.down(2, W - 8, 500, 5, true)).toBe(true);
    c.move(2, W - 8, 500 - HEIGHT_FULL_PX);
    expect(c.rate()).toBe(1);
    expect(c.move(1, 80, 480)).toBe(false);
  });
  it('is not part of the other options', () => {
    expect(control('b').down(1, W - 5, 400, 0, true)).toBe(false);
    expect(control('c').down(1, W - 5, 400, 0, true)).toBe(false);
  });
});

describe('B: double-tap, hold and slide', () => {
  const tap = (c, id, x, y, at) => {
    c.down(id, x, y, at, true);
    c.up(id, at + 60, x, y);
  };
  it('claims the second finger of a double-tap once it slides, and rises when sliding up', () => {
    const claims = [];
    const c = control('b', (id) => claims.push(id));
    tap(c, 1, 200, 500, 0);
    expect(c.down(2, 204, 502, 150, true)).toBe(false); // not claimed until it moves
    expect(c.move(2, 204, 500)).toBe(false); // inside the tap slop
    expect(c.move(2, 204, 502 - HEIGHT_FULL_PX)).toBe(true);
    expect(claims).toEqual([2]);
    expect(c.rate()).toBe(1);
    c.move(2, 204, 502 + HEIGHT_FULL_PX);
    expect(c.rate()).toBe(-1);
    expect(c.up(2, 900)).toBe(true);
    expect(c.rate()).toBe(0);
  });
  it('leaves a plain double-tap (landing) to the walk and look recogniser', () => {
    const claims = [];
    const c = control('b', (id) => claims.push(id));
    tap(c, 1, 200, 500, 0);
    expect(c.down(2, 202, 500, 150, true)).toBe(false);
    expect(c.up(2, 210, 202, 500)).toBe(false);
    expect(claims).toEqual([]);
  });
  it('does not claim a slide after a slow second tap, a far one, or when not flying', () => {
    const slow = control('b');
    tap(slow, 1, 200, 500, 0);
    slow.down(2, 200, 500, 600, true);
    expect(slow.move(2, 200, 400)).toBe(false);
    const far = control('b');
    tap(far, 1, 100, 500, 0);
    far.down(2, 300, 500, 100, true);
    expect(far.move(2, 300, 400)).toBe(false);
    const grounded = control('b');
    grounded.down(1, 200, 500, 0, false);
    grounded.up(1, 60, 200, 500);
    grounded.down(2, 200, 500, 100, false);
    expect(grounded.move(2, 200, 400)).toBe(false);
  });
  it('a single finger that slides without a first tap is just the look half', () => {
    const c = control('b');
    expect(c.down(1, 300, 500, 0, true)).toBe(false);
    expect(c.move(1, 300, 400)).toBe(false);
    expect(c.rate()).toBe(0);
  });
});

describe('C: pinch', () => {
  it('claims two fingers on the same half at once and rises as they come together', () => {
    const claims = [];
    const c = control('c', (id) => claims.push(id));
    expect(c.down(1, 250, 400, 0, true)).toBe(false);
    expect(c.down(2, 350, 400, 30, true)).toBe(true);
    expect(claims.sort()).toEqual([1, 2]);
    c.move(1, 250 + PINCH_FULL_PX / 2, 400);
    c.move(2, 350 - PINCH_FULL_PX / 2, 400);
    expect(c.rate()).toBe(1);
    c.move(1, 150, 400);
    c.move(2, 450, 400);
    expect(c.rate()).toBe(-1);
  });
  it('works with the other thumb down, and with it lifted', () => {
    const c = control('c');
    expect(c.down(9, 60, 600, 0, true)).toBe(false); // the walking thumb, left half
    expect(c.down(1, 250, 400, 10, true)).toBe(false);
    expect(c.down(2, 330, 400, 40, true)).toBe(true);
    c.move(2, 330 - PINCH_FULL_PX, 400);
    expect(c.rate()).toBe(1);
    expect(c.move(9, 70, 590)).toBe(false); // the walker is not ours
  });
  it('does not pinch with one finger on each half (that is two thumbs)', () => {
    const c = control('c');
    c.down(1, 60, 500, 0, true);
    expect(c.down(2, 300, 500, 20, true)).toBe(false);
    c.move(2, 300, 300);
    expect(c.rate()).toBe(0);
  });
  it('ends when either finger lifts and the other does not turn the view meanwhile', () => {
    const c = control('c');
    c.down(1, 250, 400, 0, true);
    c.down(2, 350, 400, 30, true);
    c.move(2, 300, 400);
    expect(c.up(1, 400)).toBe(true);
    expect(c.rate()).toBe(0);
    expect(c.move(2, 300, 300)).toBe(true); // still ours: no look
    expect(c.rate()).toBe(0);
    expect(c.up(2, 450)).toBe(true);
  });
  it('does not pinch on the ground', () => {
    const c = control('c');
    c.down(1, 250, 400, 0, false);
    expect(c.down(2, 350, 400, 30, false)).toBe(false);
  });
});

describe('cancel', () => {
  it('lets go of everything', () => {
    const c = control('a');
    c.down(1, W - 5, 400, 0, true);
    c.move(1, W - 5, 300);
    c.cancel();
    expect(c.rate()).toBe(0);
    expect(c.claims(1)).toBe(false);
  });
});
