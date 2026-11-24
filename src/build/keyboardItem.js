// #4162 (leaf 4 of #4158): nudge and turn the selected item from the keyboard in Build. Plain keys move
// the camera (src/build/keyboardCamera.js), so Shift means "the item": Shift with the arrows slides it
// (the same Nudge pad steps as the card: left, right, forward, back, in the item's own axes), Shift with
// Page Up and Page Down lifts and lowers it, Shift with Q and E turns it. A key is a press of the same
// step a tap on the card makes, through the same pipeline, so the limits and their messages are the
// card's. Pure, so it is unit-tested (keyboardItem.test.js); src/build/scene.js runs the action.
import { isTypingOrInDialog } from '../shop/keyboardInput.js';

export const ITEM_TURN_DEGREES = 5;
// A held key repeats this often at most, so a hold is a steady slide and not a flood of undo steps.
export const ITEM_KEY_MIN_GAP_MS = 120;

const NUDGES = {
  ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'forward', ArrowDown: 'back',
  PageUp: 'up', PageDown: 'down',
};

// -> { type: 'nudge', direction } | { type: 'turn', degrees } | null. Only with Shift (and no Ctrl, Cmd or
// Alt), only for a single selected item, never while someone is typing or answering a dialog.
export function buildItemKeyAction(event, { singleSelected = false } = {}) {
  if (!singleSelected || !event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || isTypingOrInDialog(event)) return null;
  if (NUDGES[event.code]) return { type: 'nudge', direction: NUDGES[event.code] };
  // Q turns it counter-clockwise seen from above (to the left), E clockwise (to the right), as the keys
  // turn the view.
  if (event.code === 'KeyQ') return { type: 'turn', degrees: ITEM_TURN_DEGREES };
  if (event.code === 'KeyE') return { type: 'turn', degrees: -ITEM_TURN_DEGREES };
  return null;
}

// Whether a shifted key is the item's rather than the camera's: the camera ignores it then.
export function isItemKey(event, singleSelected) {
  return buildItemKeyAction(event, { singleSelected }) !== null;
}
