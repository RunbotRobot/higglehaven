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

export const SHOP_KEYBOARD_CODES = new Set([
  ...MOVE_LEFT, ...MOVE_RIGHT, ...MOVE_FORWARD, ...MOVE_BACK, ...TURN_LEFT, ...TURN_RIGHT,
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
  };
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
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  const target = event.target;
  if (target) {
    const tag = target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return false;
    if (typeof target.closest === 'function' && target.closest('[role="dialog"]')) return false;
  }
  return true;
}
