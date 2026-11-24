// #1319: Shop mode was joystick-only, so a desktop user who can't drag the
// on-screen sticks couldn't walk, strafe or turn at all. Shape from the #3157
// re-triage: WASD and the arrow keys both move, Q/E turn, mouse/joystick look
// is unchanged, and keyboard and joystick feed one merged input vector without
// touching the Space double-press flight toggle. Pure mapping lives here so it
// can be unit-tested; the DOM wiring is in flightMovement.js.

// event.code values, so bindings are physical-key based (WASD stays WASD on
// non-QWERTY layouts) rather than character based.
const MOVE_LEFT = ['KeyA', 'ArrowLeft'];
const MOVE_RIGHT = ['KeyD', 'ArrowRight'];
const MOVE_FORWARD = ['KeyW', 'ArrowUp'];
const MOVE_BACK = ['KeyS', 'ArrowDown'];
const TURN_LEFT = ['KeyQ'];
const TURN_RIGHT = ['KeyE'];
// R looks up, F looks down (the view only; flight is level, #4105).
const LOOK_UP = ['KeyR'];
const LOOK_DOWN = ['KeyF'];
// #4105: height changes by a thumb sliding along the right edge; on a keyboard, Page Up rises and
// Page Down sinks while flying.
const RISE = ['PageUp'];
const SINK = ['PageDown'];

// #3823 (found by the accessibility pass, #3818): take off and land with one key. A
// double-tap on the world (and a double-press of Space on a desktop) already toggle
// flight; both need two quick presses in the same place, which not everyone can do.
// T is the one key that is neither a movement key nor Space (Space also activates a
// focused button), and it is not held, so it lives apart from SHOP_KEYBOARD_CODES.
export const FLIGHT_TOGGLE_CODES = ['KeyT'];

export const SHOP_KEYBOARD_CODES = new Set([
  ...MOVE_LEFT, ...MOVE_RIGHT, ...MOVE_FORWARD, ...MOVE_BACK, ...TURN_LEFT, ...TURN_RIGHT,
  ...LOOK_UP, ...LOOK_DOWN, ...RISE, ...SINK,
]);

const anyDown = (down, codes) => codes.some((code) => down.has(code));

// Same sign convention as the joysticks: x positive = right, y negative =
// forward (screen coordinates, see bindShopJoystick), lookX positive = turn
// right. Opposite keys cancel. Returns +/-1 per axis; the consumer already
// clamps the move vector's magnitude to 1, so a diagonal is not faster.
export function keyboardAxes(down) {
  const axis = (positive, negative) => (anyDown(down, positive) ? 1 : 0) - (anyDown(down, negative) ? 1 : 0);
  return {
    moveX: axis(MOVE_RIGHT, MOVE_LEFT),
    moveY: axis(MOVE_BACK, MOVE_FORWARD),
    lookX: axis(TURN_RIGHT, TURN_LEFT),
    // Same sign as the look joystick: positive is down.
    lookY: axis(LOOK_DOWN, LOOK_UP),
  };
}

// -1..1 for flight height from the keyboard: Page Up rises, Page Down sinks, both cancel.
export function keyboardRise(down) {
  return (anyDown(down, RISE) ? 1 : 0) - (anyDown(down, SINK) ? 1 : 0);
}

// One merged vector per stick: an actively held joystick wins, otherwise the
// keyboard supplies it. The two never add, so they can't fight each other.
export function mergeStickInput(joystick, keyboard) {
  return (joystick.x !== 0 || joystick.y !== 0) ? joystick : keyboard;
}

// Keys typed into a form control or a dialog are never navigation, and a held
// Ctrl/Meta/Alt means a browser or OS shortcut (Ctrl+W, Alt+Left, ...).
export function isNavigationKeyEvent(event) {
  if (!SHOP_KEYBOARD_CODES.has(event.code)) return false;
  return !isModifiedOrTyping(event);
}

// A held Ctrl/Meta/Alt means a browser or OS shortcut; a form control or a dialog is
// someone typing or answering, never the world.
function isModifiedOrTyping(event) {
  if (event.ctrlKey || event.metaKey || event.altKey) return true;
  const target = event.target;
  if (target) {
    const tag = target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return true;
    if (typeof target.closest === 'function' && target.closest('[role="dialog"]')) return true;
  }
  return false;
}

// #3823: one press of T toggles flight. Holding the key (auto-repeat) is not a second
// press, and the same exclusions as walking apply, so typing a "t" never launches anyone.
export function isFlightToggleKeyEvent(event) {
  if (!FLIGHT_TOGGLE_CODES.includes(event.code)) return false;
  if (event.repeat || event.shiftKey) return false;
  return !isModifiedOrTyping(event);
}

// #3824: N steps through the products near the shopper (Shift+N backwards) and opens each one's
// card, for anyone who cannot tap a product in the world. Not held, and the same exclusions as
// walking, so typing an "n" in a field never moves anything.
export const NEARBY_PRODUCT_CODES = ['KeyN'];
export function isNearbyProductKeyEvent(event) {
  if (!NEARBY_PRODUCT_CODES.includes(event.code)) return false;
  if (event.repeat) return false;
  return !isModifiedOrTyping(event);
}
