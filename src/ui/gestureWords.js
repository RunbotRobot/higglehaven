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
// #4080: every Shop arrival starts in the air, where the same left-half drag flies. The hint says the
// verb that is true where the person is.
export const FLY_MOVE_WORDS = 'Drag on the left half of the screen to fly';
// #3555 (taught under #3657): a tap on another person in Shop offers friendship. Not one of the
// three movement gestures, but a gesture nothing on screen shows, so it is taught the same way.
export const FRIEND_WORDS = 'Tap a person to offer friendship';
// #3832: the same three, for a computer with a mouse and a keyboard (#3831: a mouse drag looks).
export const KEY_WALK_WORDS = 'Press W, A, S and D (or the arrow keys) to walk';
export const KEY_LOOK_WORDS = 'Hold the left mouse button on the world and drag to look around';
export const KEY_FLY_WORDS = 'Press T to fly';
export const KEY_FLY_MOVE_WORDS = 'Press W, A, S and D (or the arrow keys) to fly';
export const KEY_LAND_WORDS = 'Press T to land';

// What the handbook must say for each, so the surfaces cannot drift from it.
export const GESTURE_HANDBOOK = [
  { entry: 'How do I walk around and look around?', phrases: ['left half of the screen', 'right half of the screen', 'drag', 'w, a, s and d', 'left button on the world'] },
  { entry: 'How do I fly, go up and come back down?', phrases: ['double-tap the world', 'look up', 'look down', 'press t', 'left half of the screen to fly'] },
  { entry: 'How do I add a friend and send them a message?', phrases: ['offer friendship', 'tap their avatar', 'send request'] },
];
