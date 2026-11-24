// #4161 (leaf 3 of #4158): Delete and undo/redo from the keyboard in Build. A key does exactly what the
// button of the same name does (the buttons stay the one definition: Delete is undoable, so it asks no
// more from a key than from a tap), so this only maps a key event to which button to press. Pure, so it
// is unit-tested (keyboardEdit.test.js); src/build/scene.js presses the button.
import { isTypingOrInDialog } from '../shop/keyboardInput.js';

// -> 'delete' | 'undo' | 'redo' | null. Nothing while someone is typing or answering a dialog, and a
// key held down is one press (auto-repeat does not delete the next thing or undo twice).
export function buildEditKeyAction(event, { hasSelection = false, canUndo = false, canRedo = false } = {}) {
  if (event.repeat || isTypingOrInDialog(event) || event.altKey) return null;
  const command = event.ctrlKey || event.metaKey;
  const key = String(event.key || '').toLowerCase();
  if (!command) {
    if ((event.code === 'Delete' || event.code === 'Backspace') && hasSelection) return 'delete';
    return null;
  }
  if (key === 'z' && event.shiftKey) return canRedo ? 'redo' : null;
  if (key === 'z') return canUndo ? 'undo' : null;
  if (key === 'y') return canRedo ? 'redo' : null;
  return null;
}
