// #4105 (part of #3539; chosen by the owner after flying three ways in #4102): how height changes while
// flying. Flight is LEVEL: the view's pitch does not climb, the path does not tilt and the body does not
// tip with the view, so a person can look straight down at what they fly over. Height changes by one
// gesture, a thumb sliding up or down along a narrow strip at the right edge of the screen.
//
// The Shop calls createHeightControl once, feeds it the same pointer events it feeds
// src/shop/worldGestures.js (the control answers whether it has claimed a finger; a claimed finger is not
// seen by the walk/look recogniser) and reads rate() each frame. Pure maths and state, no DOM, so it is
// unit-tested (flightHeight.test.js).

import { HEIGHT_WORDS, KEY_HEIGHT_WORDS } from '../ui/gestureWords.js';

// The right-edge strip, in CSS pixels. 36 px is roughly the width of a thumb pad: wide enough to land on
// without looking, narrow enough that the look half of the screen keeps all but a sliver. Cost, accepted
// with the choice: a drag that starts inside this strip while flying no longer turns the view.
export const EDGE_STRIP_PX = 36;
// A slide this far (up or down) from where the finger went down is full rise or sink; the first few
// pixels are a dead zone so a resting thumb does not drift.
export const HEIGHT_DEADZONE_PX = 6;
export const HEIGHT_FULL_PX = 70;
// Full rise or sink is this share of the flight speed (sin 50 degrees: the steepest the old pitch-climb
// path gave, kept so the strength a person felt before does not change).
export const FLIGHT_CLIMB_FRACTION = Math.sin((50 * Math.PI) / 180);

// The one sentence taught the first time someone flies (the gesture cannot be seen).
export const HEIGHT_HINT = HEIGHT_WORDS;
export const KEY_HEIGHT_HINT = KEY_HEIGHT_WORDS;

// The hint for the device in front of the person: a computer (a fine pointer and no touch) reads the
// keys, everything else the edge slide (the same test as src/ui/loadingTips.js's tipText, #3832).
export function heightHint(win = typeof window === 'undefined' ? null : window) {
  const media = win && typeof win.matchMedia === 'function' ? win.matchMedia.bind(win) : null;
  const computer = Boolean(media && media('(pointer: fine)').matches && !media('(pointer: coarse)').matches);
  return computer ? KEY_HEIGHT_HINT : HEIGHT_HINT;
}

const clampUnit = (value) => Math.max(-1, Math.min(1, value));

// -1..1 from a distance in pixels (positive in, positive out), after the dead zone.
export function ramp(distancePx, deadzonePx, fullPx) {
  const a = Math.abs(distancePx);
  if (a <= deadzonePx) return 0;
  return Math.sign(distancePx) * clampUnit((a - deadzonePx) / (fullPx - deadzonePx));
}

// Screen y grows downward, so a finger sliding UP is a negative dy and means rise (positive rate).
export function slideRate(dyPx) {
  return ramp(-dyPx, HEIGHT_DEADZONE_PX, HEIGHT_FULL_PX);
}

// `options`: viewportWidth() in the same units as the pointer positions.
export function createHeightControl({ viewportWidth }) {
  const edgeFingers = new Map(); // id -> { y0 }
  let heldRate = 0;

  // `flying`: only while flying does the strip claim a finger; on the ground it is just the world.
  function down(id, x, y, now, flying) {
    if (edgeFingers.has(id) || !flying || x < viewportWidth() - EDGE_STRIP_PX) return false;
    edgeFingers.set(id, { y0: y });
    return true;
  }

  function move(id, x, y) {
    const finger = edgeFingers.get(id);
    if (!finger) return false;
    heldRate = slideRate(y - finger.y0);
    return true;
  }

  function up(id) {
    if (!edgeFingers.delete(id)) return false;
    heldRate = 0;
    return true;
  }

  function cancel() {
    edgeFingers.clear();
    heldRate = 0;
  }

  function claims(id) {
    return edgeFingers.has(id);
  }

  // -1..1: rise (positive) or sink. 0 when no gesture is held.
  function rate() {
    return heldRate;
  }

  return { down, move, up, cancel, claims, rate };
}
