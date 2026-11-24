// #3738 (part of #3735): the lines the opening screen shows one at a time while
// the world loads. They live here, in one place, and each names the handbook
// entry it is a short form of (docs/assistant-handbook.md) plus the phrases it
// borrows from that entry, so scripts/loading-tips.test.mjs can fail when the
// interface changes the way a thing is done and only one of the two is updated.
// Everything here is read by a person: "lándlet" always, with the accent, and
// no internal words. When the way of moving changes, change the first two lines and
// their handbook entries together (#3650, #3749: left half walks, right half looks,
// double-tap flies).
import { WALK_WORDS, FLY_WORDS, FRIEND_WORDS, KEY_WALK_WORDS, KEY_LOOK_WORDS, KEY_FLY_WORDS, KEY_HEIGHT_WORDS } from './gestureWords.js';

export const LOADING_TIPS = [
  {
    text: `${WALK_WORDS}, and on the right half to look around.`,
    keyText: `${KEY_WALK_WORDS}. ${KEY_LOOK_WORDS}.`, // #3832: a computer reads the keys
    handbook: 'How do I walk around and look around?',
    words: ['left half', 'right half'],
  },
  {
    text: `${FLY_WORDS}. Slide a thumb along the right edge to rise or sink.`,
    keyText: `${KEY_FLY_WORDS}. ${KEY_HEIGHT_WORDS}.`,
    handbook: 'How do I fly, go up and come back down?',
    words: ['double-tap the world', 'right edge'],
  },
  {
    text: 'Tap a product to read about it. A small card blooms beside it.',
    handbook: 'How do I look at a product and read about it?',
    words: ['product', 'card'],
  },
  {
    text: `${FRIEND_WORDS}. To add someone who is far away, use Friends in the menu.`,
    handbook: 'How do I add a friend and send them a message?',
    words: ['offer friendship', 'friends'],
  },
  {
    text: 'Glowing orbs are free credits for making models. Fly into one to collect it.',
    handbook: 'What are the glowing orbs, and what if I hit the limit?',
    words: ['glowing orbs', 'free'],
  },
  {
    text: 'Tap the round higglehaven logo, then Build, to claim a lándlet of your own.',
    handbook: 'How do I get my own lándlet?',
    words: ['higglehaven logo', 'build', 'lándlet'],
  },
];

// #3763 (part of #3759, #3738): a tip stays up long enough to be read. The owner
// is "an unusually slow reader" and has been frustrated by games whose tips go
// before they can be read, so the time a tip is held is worked out from its own
// length: two and a half words a second (a fast reader manages about four), and
// never under six seconds. One function, so the pacing is tested in one place.
export const TIP_WORDS_PER_SECOND = 2.5;
export const TIP_MIN_MS = 6000;

export function tipReadingMs(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  return Math.max(TIP_MIN_MS, Math.ceil((words / TIP_WORDS_PER_SECOND) * 1000));
}

// #3832: the line to show for the device in front of the person. A computer (a fine pointer and no
// touch) reads the keys and the mouse; everything else reads the touch words.
export function tipText(tip, win = typeof window === 'undefined' ? null : window) {
  const media = win && typeof win.matchMedia === 'function' ? win.matchMedia.bind(win) : null;
  const computer = Boolean(media && media('(pointer: fine)').matches && !media('(pointer: coarse)').matches);
  return computer && tip.keyText ? tip.keyText : tip.text;
}
