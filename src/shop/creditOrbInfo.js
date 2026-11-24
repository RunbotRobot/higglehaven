// #4072: what a glowing orb is, in words a person reads. Two sentences, both said by the flower's head
// (see sayAtHead in src/ui/headSaying.js): what was just collected (the "Credit +1" word is a door to
// it) and what an orb in the world is (a tap on one asks; only walking into it collects). DOM-free so
// it is unit tested. The numbers are the server's, handed in by the caller: this file holds no limit
// of its own ("A message that limits or refuses an action states the limit").
import { rateLimitCapText } from '../rateLimitNotice.js';

// #4123: the word beside the head when an orb is collected says how many credits the person holds
// now, which is the figure they care about, not the increment. Until a balance is known the old
// "Credit +1" stands in for it.
export function creditOrbBalanceWord(balance) {
  if (typeof balance !== 'number' || !Number.isFinite(balance) || balance < 0) return 'Credit +1';
  const n = Math.floor(balance);
  return `${n} credit${n === 1 ? '' : 's'}`;
}

const USE_SENTENCE = 'Use it from Build when you add a product from a short video.';

// credits: how many the builder holds now (from the server), or null when it could not be read.
export function creditOrbCollectedText(credits) {
  const parts = ['You collected a free credit. It turns a short video into a 3D model for your lándlet.'];
  if (typeof credits === 'number') parts.push(`You have ${credits} now.`);
  parts.push(USE_SENTENCE);
  return parts.join(' ');
}

// standing: the server's last { limit, windowSeconds } for collecting orbs, or null when not known yet.
export function creditOrbAboutText(standing) {
  const parts = [
    'A glowing orb is a free credit for turning a short video into a 3D model for your lándlet.',
    'Walk or fly into it to collect it.',
  ];
  const cap = rateLimitCapText('orbs', standing);
  if (cap) parts.push(cap);
  return parts.join(' ');
}
