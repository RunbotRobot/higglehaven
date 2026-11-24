// #4102 (part of #3539): three ways of changing height while flying, to fly and compare, so the
// owner can choose one. Not a setting and not a control on the world: the Shop address takes
// `?height=a|b|c` (remembered in this browser until `?height=off`), and the page
// public/design-directions/flight-height.html has the three links. With no choice made nothing
// here runs: the live default stays "the view's pitch is the climb" (src/shop/flightPitch.js,
// #3769) until the owner picks.
//
// What is common to all three: flight is LEVEL. Height changes only by the chosen gesture, so a
// person can look straight down at what they fly over (the view's pitch no longer climbs, the path
// no longer tilts, the body no longer tips with the view).
//   A  edge slide        a thumb sliding up or down along a narrow strip at the right edge.
//   B  double-tap-hold   double-tap and keep the finger down, then slide up or down (the one-finger
//                        zoom of map apps). A plain double-tap still lands or takes off.
//   C  pinch             two fingers on the same half of the screen: bring them together to rise,
//                        spread them apart to sink (maps, reversed to read as "pull up / push down").
//
// One interface so removing two later is a small change: the Shop calls createHeightControl once,
// feeds it the same pointer events it feeds src/shop/worldGestures.js (the control answers whether
// it has claimed a finger; a claimed finger is not seen by the walk/look recogniser) and reads
// rate() each frame. Pure maths and state, no DOM, so it is unit-tested (flightHeight.test.js).
// Removing the two losers: delete their branches below and this header; the Shop's one call site
// and the level-flight switch stay.
import { TAP_SLOP_PX, TAP_MAX_MS, DOUBLE_TAP_MS, DOUBLE_TAP_DISTANCE_PX } from './worldGestures.js';

export const HEIGHT_PARAM = 'height';
export const HEIGHT_STORAGE_KEY = 'higglehaven.flightHeight';
export const HEIGHT_MODES = ['a', 'b', 'c'];

// The right-edge strip for option A, in CSS pixels. 36 px is roughly the width of a thumb pad:
// wide enough to land on without looking, narrow enough that the look half of the screen keeps
// all but a sliver. Cost: a drag that starts inside this strip while flying no longer turns the view.
export const EDGE_STRIP_PX = 36;
// A slide this far (up or down) from where the finger went down is full rise or sink; the first few
// pixels are a dead zone so a resting thumb does not drift.
export const HEIGHT_DEADZONE_PX = 6;
export const HEIGHT_FULL_PX = 70;
// Option C: how far the two fingers' distance has to change before it counts, and how far is full.
export const PINCH_DEADZONE_PX = 8;
export const PINCH_FULL_PX = 80;

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

// Two fingers coming together (distance shrinks) rise; spreading apart sinks.
export function pinchRate(startDistancePx, distancePx) {
  return ramp(startDistancePx - distancePx, PINCH_DEADZONE_PX, PINCH_FULL_PX);
}

// Which option is chosen: the address wins and is remembered; `off` (or `none`) forgets it; with
// neither, what this browser remembered. Anything else is no choice. Never throws: storage can be
// missing (a private window) and the page must still work.
export function resolveHeightMode(search, storage) {
  let requested = null;
  try {
    requested = new URLSearchParams(search || '').get(HEIGHT_PARAM);
  } catch { requested = null; }
  const read = () => {
    try { return storage ? storage.getItem(HEIGHT_STORAGE_KEY) : null; } catch { return null; }
  };
  const write = (value) => {
    try {
      if (!storage) return;
      if (value === null) storage.removeItem(HEIGHT_STORAGE_KEY);
      else storage.setItem(HEIGHT_STORAGE_KEY, value);
    } catch { /* storage refused: the choice just is not remembered */ }
  };
  if (requested !== null) {
    const wanted = requested.trim().toLowerCase();
    if (HEIGHT_MODES.includes(wanted)) {
      write(wanted);
      return wanted;
    }
    if (wanted === 'off' || wanted === 'none') {
      write(null);
      return null;
    }
  }
  const stored = read();
  return HEIGHT_MODES.includes(stored) ? stored : null;
}

// The one sentence taught the first time someone flies with an option, in the gesture's own words.
export const HEIGHT_HINT_WORDS = {
  a: 'Slide a thumb up or down along the right edge of the screen to rise or sink',
  b: 'Double-tap, keep your finger down and slide up to rise or down to sink',
  c: 'Bring two fingers together to rise, spread them apart to sink',
};

// `options`: mode ('a'|'b'|'c'), viewportWidth() in the same units as the pointer positions,
// halfX() the x that divides walk (left) from look (right) halves, onClaim(id) called when a finger
// the walk/look recogniser has already seen turns out to belong here (so it can forget it).
export function createHeightControl({ mode, viewportWidth, halfX, onClaim = () => {} }) {
  // id -> { x0, y0, half, role: 'edge'|'hold'|'pinch'|null, tapped }
  const fingers = new Map();
  let lastTap = null; // { x, y, at } of the last quick, still tap
  let pinch = null; // { ids: [a, b], start }
  let heldRate = 0;

  const halfOf = (x) => (x < halfX() ? 'walk' : 'look');
  const distanceBetween = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  function down(id, x, y, now, flying) {
    if (fingers.has(id)) return false;
    const finger = { id, x, y, x0: x, y0: y, half: halfOf(x), role: null, moved: false, downAt: now };
    fingers.set(id, finger);
    if (!flying) return false;
    if (mode === 'a' && x >= viewportWidth() - EDGE_STRIP_PX) {
      finger.role = 'edge';
      return true;
    }
    if (mode === 'b') {
      // The second tap of a double-tap, landing close to and soon after the first. Not claimed yet:
      // a plain double-tap is the walk/look recogniser's (it lands), a slide makes it ours.
      if (lastTap && now - lastTap.at <= DOUBLE_TAP_MS && Math.hypot(x - lastTap.x, y - lastTap.y) <= DOUBLE_TAP_DISTANCE_PX) {
        finger.candidate = true;
      }
      return false;
    }
    if (mode === 'c' && !pinch) {
      // Two fingers on the same half of the screen. The other thumb (the other half) may be down or
      // lifted. Both are claimed at once, so neither walks nor turns the view.
      const partner = [...fingers.values()].find((other) => other.id !== id && other.role === null && other.half === finger.half);
      if (partner) {
        pinch = { ids: [partner.id, id], start: distanceBetween(partner, finger) };
        for (const f of [partner, finger]) {
          f.role = 'pinch';
          onClaim(f.id);
        }
        return true;
      }
    }
    return false;
  }

  function move(id, x, y) {
    const finger = fingers.get(id);
    if (!finger) return false;
    finger.x = x;
    finger.y = y;
    if (finger.role === 'spent') return true;
    if (finger.role === 'edge' || finger.role === 'hold') {
      heldRate = slideRate(y - finger.y0);
      return true;
    }
    if (finger.role === 'pinch') {
      const [a, b] = pinch.ids.map((pid) => fingers.get(pid));
      if (a && b) heldRate = pinchRate(pinch.start, distanceBetween(a, b));
      return true;
    }
    if (Math.hypot(x - finger.x0, y - finger.y0) > TAP_SLOP_PX) finger.moved = true;
    if (finger.candidate && finger.moved) {
      finger.role = 'hold';
      lastTap = null;
      onClaim(id);
      heldRate = slideRate(y - finger.y0);
      return true;
    }
    return false;
  }

  function up(id, now, x = null, y = null) {
    const finger = fingers.get(id);
    if (!finger) return false;
    fingers.delete(id);
    const claimed = finger.role !== null;
    if (finger.role === 'pinch') {
      // Either finger lifting ends the pinch; the other stays claimed until it lifts too, so it
      // does not suddenly start turning the view.
      pinch = null;
      heldRate = 0;
      for (const other of fingers.values()) {
        if (other.role === 'pinch') other.role = 'spent';
      }
    } else if (finger.role === 'edge' || finger.role === 'hold') {
      heldRate = 0;
    } else if (finger.role === 'spent') {
      return true;
    } else if (!finger.moved && now - finger.downAt <= TAP_MAX_MS) {
      lastTap = { x: x ?? finger.x0, y: y ?? finger.y0, at: now };
    } else {
      lastTap = null;
    }
    return claimed;
  }

  function cancel() {
    fingers.clear();
    pinch = null;
    lastTap = null;
    heldRate = 0;
  }

  // A finger's role is `spent` after its pinch partner lifts: still claimed (moves are ours and do
  // nothing) so it does not start turning the view mid-gesture.
  function claims(id) {
    const finger = fingers.get(id);
    return Boolean(finger && finger.role !== null);
  }

  // -1..1: rise (positive) or sink. 0 when no gesture is held.
  function rate() {
    return heldRate;
  }

  return { mode, down, move, up, cancel, claims, rate };
}
