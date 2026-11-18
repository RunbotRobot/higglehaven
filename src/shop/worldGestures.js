// #3650 (part of #3648, the bud): moving through the world by touching it.
// A drag anywhere on the world walks (direction and speed from the drag, like a
// stick placed wherever the finger lands), a second finger dragging looks the
// same way, and a double-tap takes off or lands. This module is only the
// recogniser: it takes raw pointer events and says what they mean. It knows
// nothing about the DOM, the camera or the avatar (src/shop/flightMovement.js
// wires it to the same two raw stick states the keyboard and the old sticks fed,
// so everything downstream is unchanged).
//
// What a tap is stays the browser's business: a finger that goes down and up
// without moving more than TAP_SLOP_PX raises a click, which the world's own
// tap handler (inspect a product, open an assistant) already reads. This only
// adds what happens when the finger does move, and the double-tap.

// A finger must travel this far before it is a drag, not a tap. Matches the
// threshold the world's tap handler uses to tell a tap from a drag
// (CLICK_DRAG_THRESHOLD_PX in src/build/scene.js), so a touch is never both.
export const TAP_SLOP_PX = 8;
// Under this the drag has not left the finger's own spot yet: no movement.
export const DEADZONE_PX = 6;
// A drag this long is full speed (or the fastest look); longer is clamped.
export const FULL_DEFLECTION_PX = 70;
// Two quick taps close together are a double-tap.
export const DOUBLE_TAP_MS = 320;
export const DOUBLE_TAP_DISTANCE_PX = 48;
// A touch held longer than this is not a tap (so not half of a double-tap).
export const TAP_MAX_MS = 350;

const clampUnit = (value) => Math.max(-1, Math.min(1, value));

// How far a finger has moved from where it went down, as -1..1 on each axis
// after the dead zone, in the same shape a stick gave. Zero inside the dead zone.
export function deflection(dx, dy) {
  const distance = Math.hypot(dx, dy);
  if (distance < DEADZONE_PX) return { x: 0, y: 0 };
  const clamped = Math.min(distance, FULL_DEFLECTION_PX);
  return { x: clampUnit((dx / distance) * clamped / FULL_DEFLECTION_PX), y: clampUnit((dy / distance) * clamped / FULL_DEFLECTION_PX) };
}

// `handlers`: onMove(x, y) and onLook(x, y), called with -1..1 (0, 0 when the
// finger lifts or returns to its start), and onDoubleTap().
export function createWorldGestures(handlers) {
  const fingers = new Map(); // id -> { x0, y0, role, downAt }
  let lastTap = null; // { x, y, at } of the last finished tap

  const roleHolder = (role) => [...fingers.values()].find((finger) => finger.role === role);

  function report(role, finger, x, y) {
    const { x: dx, y: dy } = deflection(x - finger.x0, y - finger.y0);
    if (role === 'walk') handlers.onMove(dx, dy);
    else handlers.onLook(dx, dy);
  }

  function down(id, x, y, now) {
    if (fingers.has(id)) return;
    const finger = { x0: x, y0: y, role: 'pending', downAt: now };
    if (fingers.size === 0) {
      fingers.set(id, finger);
      return;
    }
    // A second finger: the first one is walking (even if it has not moved yet,
    // so it stays put while the other looks), the new one looks. Neither is a
    // tap any more.
    for (const other of fingers.values()) if (other.role === 'pending') other.role = 'walk';
    lastTap = null;
    if (!roleHolder('look')) {
      finger.role = 'look';
      fingers.set(id, finger);
    } else {
      finger.role = 'ignored'; // a third finger does nothing
      fingers.set(id, finger);
    }
  }

  function move(id, x, y) {
    const finger = fingers.get(id);
    if (!finger) return;
    if (finger.role === 'pending') {
      if (Math.hypot(x - finger.x0, y - finger.y0) <= TAP_SLOP_PX) return;
      finger.role = 'walk';
      lastTap = null;
    }
    if (finger.role === 'walk' || finger.role === 'look') report(finger.role, finger, x, y);
  }

  function up(id, now, x = null, y = null) {
    const finger = fingers.get(id);
    if (!finger) return;
    fingers.delete(id);
    if (finger.role === 'walk') handlers.onMove(0, 0);
    else if (finger.role === 'look') handlers.onLook(0, 0);
    else if (finger.role === 'pending' && fingers.size === 0) {
      // A finger that went down and up without travelling: a tap.
      const px = x ?? finger.x0;
      const py = y ?? finger.y0;
      const quick = now - finger.downAt <= TAP_MAX_MS;
      if (quick && lastTap && now - lastTap.at <= DOUBLE_TAP_MS && Math.hypot(px - lastTap.x, py - lastTap.y) <= DOUBLE_TAP_DISTANCE_PX) {
        lastTap = null;
        handlers.onDoubleTap();
      } else {
        lastTap = quick ? { x: px, y: py, at: now } : null;
      }
    }
    // If the walking finger lifts while another is still down, that one simply
    // keeps looking; nothing is handed over.
  }

  function cancel() {
    const hadWalk = Boolean(roleHolder('walk'));
    const hadLook = Boolean(roleHolder('look'));
    fingers.clear();
    lastTap = null;
    if (hadWalk) handlers.onMove(0, 0);
    if (hadLook) handlers.onLook(0, 0);
  }

  return { down, move, up, cancel, activeFingers: () => fingers.size };
}
