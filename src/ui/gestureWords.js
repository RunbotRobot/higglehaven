// #3657: the one place the words for the three world gestures live. The first-visit hints
// (firstVisitHints.js), the opening-screen tips (loadingTips.js) and Settings > Controls
// (shop/mode.js) all build their sentences from these, and scripts/gesture-words.test.mjs fails
// when the handbook entry each one belongs to (docs/assistant-handbook.md, which assistants
// speak from and the "?" pages show) stops saying the same thing. Change a gesture here, in
// the handbook entry and nowhere else. A person reads these: no internal words.
export const WALK_WORDS = 'Drag on the left half of the screen to walk';
export const LOOK_WORDS = 'Drag on the right half of the screen to look around';
export const FLY_WORDS = 'Double-tap the world to fly';
export const LAND_WORDS = 'Double-tap the world to land';
// #3832: the same three, for a computer with a mouse and a keyboard (#3831: a mouse drag looks).
export const KEY_WALK_WORDS = 'Press W, A, S and D (or the arrow keys) to walk';
export const KEY_LOOK_WORDS = 'Hold the left mouse button on the world and drag to look around';
export const KEY_FLY_WORDS = 'Press T to fly';

// What the handbook must say for each, so the surfaces cannot drift from it.
export const GESTURE_HANDBOOK = [
  { entry: 'How do I walk around and look around?', phrases: ['left half of the screen', 'right half of the screen', 'drag', 'w, a, s and d', 'left button on the world'] },
  { entry: 'How do I fly, go up and come back down?', phrases: ['double-tap the world', 'look up', 'look down', 'press t'] },
];
