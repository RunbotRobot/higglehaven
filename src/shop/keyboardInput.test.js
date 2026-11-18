import { describe, expect, it } from 'vitest';
import { isFlightToggleKeyEvent, isNavigationKeyEvent, keyboardAxes, mergeStickInput } from './keyboardInput.js';

// #1319
const down = (...codes) => new Set(codes);

describe('keyboardAxes (#1319)', () => {
  it('R looks up and F looks down, so a keyboard can steer flight height (#3769)', () => {
    expect(keyboardAxes(down('KeyR'))).toMatchObject({ lookY: -1 });
    expect(keyboardAxes(down('KeyF'))).toMatchObject({ lookY: 1 });
    expect(keyboardAxes(down('KeyR', 'KeyF'))).toMatchObject({ lookY: 0 });
  });

  it('maps WASD and the arrow keys to the same move vector (y negative = forward)', () => {
    expect(keyboardAxes(down('KeyW'))).toEqual({ moveX: 0, moveY: -1, lookX: 0, lookY: 0 });
    expect(keyboardAxes(down('ArrowUp'))).toEqual({ moveX: 0, moveY: -1, lookX: 0, lookY: 0 });
    expect(keyboardAxes(down('KeyS'))).toMatchObject({ moveY: 1 });
    expect(keyboardAxes(down('KeyA'))).toMatchObject({ moveX: -1 });
    expect(keyboardAxes(down('ArrowRight'))).toMatchObject({ moveX: 1 });
  });

  it('maps Q/E to turning left/right without moving', () => {
    expect(keyboardAxes(down('KeyQ'))).toEqual({ moveX: 0, moveY: 0, lookX: -1, lookY: 0 });
    expect(keyboardAxes(down('KeyE'))).toEqual({ moveX: 0, moveY: 0, lookX: 1, lookY: 0 });
  });

  it('opposite keys cancel, including across the WASD/arrow sets', () => {
    expect(keyboardAxes(down('KeyW', 'KeyS'))).toEqual({ moveX: 0, moveY: 0, lookX: 0, lookY: 0 });
    expect(keyboardAxes(down('KeyA', 'ArrowRight', 'KeyD'))).toMatchObject({ moveX: 0 });
    expect(keyboardAxes(down('KeyQ', 'KeyE'))).toMatchObject({ lookX: 0, lookY: 0 });
  });

  it('combines axes for diagonals and is zero with nothing held', () => {
    expect(keyboardAxes(down('KeyW', 'KeyD'))).toEqual({ moveX: 1, moveY: -1, lookX: 0, lookY: 0 });
    expect(keyboardAxes(down())).toEqual({ moveX: 0, moveY: 0, lookX: 0, lookY: 0 });
  });

  it('ignores keys it does not own (Space stays with the flight toggle)', () => {
    expect(keyboardAxes(down('Space', 'KeyZ'))).toEqual({ moveX: 0, moveY: 0, lookX: 0, lookY: 0 });
  });
});

describe('mergeStickInput (#1319)', () => {
  it('uses the keyboard when the joystick is idle', () => {
    expect(mergeStickInput({ x: 0, y: 0 }, { x: 1, y: 0 })).toEqual({ x: 1, y: 0 });
  });
  it('lets an active joystick win outright rather than adding to the keyboard', () => {
    expect(mergeStickInput({ x: 0.3, y: -0.4 }, { x: 1, y: 1 })).toEqual({ x: 0.3, y: -0.4 });
  });
});

describe('isNavigationKeyEvent (#1319)', () => {
  const event = (code, extra = {}) => ({ code, ctrlKey: false, metaKey: false, altKey: false, target: { tagName: 'BODY' }, ...extra });

  it('accepts a plain navigation key on the page', () => {
    expect(isNavigationKeyEvent(event('KeyW'))).toBe(true);
  });
  it('rejects non-navigation keys', () => {
    expect(isNavigationKeyEvent(event('Space'))).toBe(false);
    expect(isNavigationKeyEvent(event('KeyZ'))).toBe(false);
  });
  it('rejects keys typed into form controls', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
      expect(isNavigationKeyEvent(event('KeyA', { target: { tagName } }))).toBe(false);
    }
    expect(isNavigationKeyEvent(event('KeyA', { target: { tagName: 'DIV', isContentEditable: true } }))).toBe(false);
  });
  it('rejects keys from inside a dialog', () => {
    const target = { tagName: 'BUTTON', closest: (selector) => (selector === '[role="dialog"]' ? {} : null) };
    expect(isNavigationKeyEvent(event('ArrowLeft', { target }))).toBe(false);
  });
  it('leaves browser shortcuts alone', () => {
    expect(isNavigationKeyEvent(event('KeyW', { ctrlKey: true }))).toBe(false);
    expect(isNavigationKeyEvent(event('ArrowLeft', { altKey: true }))).toBe(false);
    expect(isNavigationKeyEvent(event('KeyA', { metaKey: true }))).toBe(false);
  });
});

describe('isFlightToggleKeyEvent (#3823)', () => {
  const key = (code, extra = {}) => ({ code, target: { tagName: 'BODY' }, ...extra });

  it('one press of T toggles flight', () => {
    expect(isFlightToggleKeyEvent(key('KeyT'))).toBe(true);
  });

  it('is not a movement key, so it never feeds the walking vector', () => {
    expect(isNavigationKeyEvent(key('KeyT'))).toBe(false);
    expect(keyboardAxes(new Set(['KeyT']))).toEqual({ moveX: 0, moveY: 0, lookX: 0, lookY: 0 });
  });

  it('ignores other keys, including the movement keys and Space', () => {
    for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyR', 'KeyF', 'Space', 'ArrowUp', 'Enter']) {
      expect(isFlightToggleKeyEvent(key(code)), code).toBe(false);
    }
  });

  it('holding the key is not a second press', () => {
    expect(isFlightToggleKeyEvent(key('KeyT', { repeat: true }))).toBe(false);
  });

  it('leaves browser shortcuts and capital T alone', () => {
    for (const mod of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey']) {
      expect(isFlightToggleKeyEvent(key('KeyT', { [mod]: true })), mod).toBe(false);
    }
  });

  it('never fires while typing in a field or answering a dialog', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
      expect(isFlightToggleKeyEvent({ code: 'KeyT', target: { tagName } }), tagName).toBe(false);
    }
    expect(isFlightToggleKeyEvent({ code: 'KeyT', target: { tagName: 'DIV', isContentEditable: true } })).toBe(false);
    expect(isFlightToggleKeyEvent({ code: 'KeyT', target: { tagName: 'BUTTON', closest: (sel) => (sel === '[role="dialog"]' ? {} : null) } })).toBe(false);
  });
});
