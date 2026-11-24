// #3650, #3749 (part of #3648, the bud): moving through the world by touching it.
// Where a finger lands decides what it does: a drag that starts on the LEFT half of the
// screen walks (direction and speed from the drag, like a stick placed wherever the thumb
// lands), a drag that starts on the RIGHT half turns the camera, and a double-tap anywhere
// takes off or lands. Each works alone (stand still and look around with one thumb) and the
// two work together (one thumb each); which finger went down first does not matter. This
// module is only the recogniser: it takes raw pointer events and says what they mean. It
// knows nothing about the DOM, the camera or the avatar (src/shop/flightMovement.js wires it
// to the same two raw stick states the keyboard and the old sticks fed, so everything
// downstream is unchanged).
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
// Two fingers that land this close together in time are a fumble (a hand set down on the screen),
// not two thumbs doing two jobs: neither is a tap. A finger landing later, while the other thumb is
// walking or looking, is the double-tap that takes off or lands (#4064).
export const SIMULTANEOUS_LANDING_MS = 60;

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
// finger lifts or returns to its start), onDoubleTap(), and splitX(), the x (in the same
// units as the pointer positions) that divides the screen: left of it walks, right looks.
export function createWorldGestures(handlers) {
  const fingers = new Map(); // id -> { x0, y0, role, active, fumble, downAt }
  let lastTap = null; // { x, y, at } of the last finished tap

  const roleHolder = (role) => [...fingers.values()].find((finger) => finger.role === role);

  function report(finger, x, y) {
    const { x: dx, y: dy } = deflection(x - finger.x0, y - finger.y0);
    if (finger.role === 'walk') handlers.onMove(dx, dy);
    else handlers.onLook(dx, dy);
  }

  // `forcedRole` is for a pointer that has no halves: a computer's mouse (#3831) has one
  // button and one meaning, so a drag with it always looks, wherever on the screen it starts.
  // It also never counts toward a double-tap (a mouse's double-click is not "fly").
  function down(id, x, y, now, forcedRole = null) {
    if (fingers.has(id)) return;
    // The half it landed on decides the job; a second finger on a half that already has
    // one does nothing (it is not a walker's helper and not a tap).
    const wanted = forcedRole || (x < handlers.splitX() ? 'walk' : 'look');
    // A mouse never taps (a double-click is not "fly"), so it starts as a fumble.
    const finger = { x0: x, y0: y, role: roleHolder(wanted) ? 'ignored' : wanted, active: false, fumble: Boolean(forcedRole), downAt: now };
    // "a gesture means the same thing every time, by where it starts, never by what another finger is
    // doing" (AGENTS.md, the bud, 2026-11-18): a double-tap takes off or lands whether or not the other
    // thumb is down. The one thing that is not a tap is two fingers landing at nearly the same moment.
    for (const other of fingers.values()) {
      if (now - other.downAt <= SIMULTANEOUS_LANDING_MS) {
        other.fumble = true;
        finger.fumble = true;
        lastTap = null;
      }
    }
    fingers.set(id, finger);
  }

  function move(id, x, y) {
    const finger = fingers.get(id);
    if (!finger || finger.role === 'ignored') return;
    if (!finger.active) {
      if (Math.hypot(x - finger.x0, y - finger.y0) <= TAP_SLOP_PX) return;
      finger.active = true;
      lastTap = null;
    }
    report(finger, x, y);
  }

  function up(id, now, x = null, y = null) {
    const finger = fingers.get(id);
    if (!finger) return;
    fingers.delete(id);
    if (finger.active) {
      if (finger.role === 'walk') handlers.onMove(0, 0);
      else handlers.onLook(0, 0);
    } else if (finger.role !== 'ignored' && !finger.fumble) {
      // A finger that went down and up without travelling, and not as one of two that landed together: a tap.
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
  }

  function cancel() {
    const hadWalk = [...fingers.values()].some((finger) => finger.active && finger.role === 'walk');
    const hadLook = [...fingers.values()].some((finger) => finger.active && finger.role === 'look');
    fingers.clear();
    lastTap = null;
    if (hadWalk) handlers.onMove(0, 0);
    if (hadLook) handlers.onLook(0, 0);
  }

  return { down, move, up, cancel, activeFingers: () => fingers.size };
}
