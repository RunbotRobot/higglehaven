// #3738 (part of #3735): the lines the opening screen shows one at a time while
// the world loads. They live here, in one place, and each names the handbook
// entry it is a short form of (docs/assistant-handbook.md) plus the phrases it
// borrows from that entry, so scripts/loading-tips.test.mjs can fail when the
// interface changes the way a thing is done and only one of the two is updated.
// Everything here is read by a person: "lándlet" always, with the accent, and
// no internal words. When the way of moving changes, change the first two lines and
// their handbook entries together (#3650, #3749: left half walks, right half looks,
// double-tap flies).
export const LOADING_TIPS = [
  {
    text: 'Drag on the left half of the screen to walk, and on the right half to look around.',
    handbook: 'How do I walk around and look around?',
    words: ['left half', 'right half'],
  },
  {
    text: 'Double-tap the world to come down to the ground, and again to fly back up.',
    handbook: 'How do I fly, go up and come back down?',
    words: ['double-tap the world'],
  },
  {
    text: 'Tap a product to read about it. A small card blooms beside it.',
    handbook: 'How do I look at a product and read about it?',
    words: ['product', 'card'],
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
