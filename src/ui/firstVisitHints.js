// #3657: the first time someone is in the world on a touch screen, one quiet hint at a time
// appears in the world (never a modal, never blocking) and goes as soon as they do the thing it
// names: walk, then look, then fly. After the last one it never comes back on this device.
// (The owner's "Signing in on a new device does not replay it" needs a server-side flag per
// account; that is the follow-up, tracked on #3657. Until then it is remembered per browser.)
// Driven by the world-gesture events src/shop/flightMovement.js already fires, once per kind.
// Same string as WORLD_GESTURE_EVENT in src/shop/flightMovement.js (not imported: that module needs a
// browser page to load, which would pull the whole world into this one's unit test).
const WORLD_GESTURE_EVENT = 'higglehaven:world-gesture';

import {
  WALK_WORDS, LOOK_WORDS, FLY_WORDS, LAND_WORDS, FLY_MOVE_WORDS,
  KEY_WALK_WORDS, KEY_LOOK_WORDS, KEY_FLY_WORDS, KEY_LAND_WORDS, KEY_FLY_MOVE_WORDS,
} from './gestureWords.js';

export const FIRST_HINTS_KEY = 'higglehaven.firstHints.done';
// #4080: a Shop arrival starts in the air, so the first words a person reads must be true there: the
// same left-half drag that walks on the ground flies in the air, and a double-tap that flies from the
// ground lands from the air. `airText` is what the step says while the person is flying; `text` is
// what it says on the ground. A gesture is learned once, whichever state it was learned in (a
// person who dragged to fly is not then told to "walk"), because only the verb would differ.
export const FIRST_HINT_STEPS = [
  { kind: 'walk', text: WALK_WORDS, airText: FLY_MOVE_WORDS },
  { kind: 'look', text: LOOK_WORDS },
  { kind: 'fly', text: FLY_WORDS, airText: LAND_WORDS },
];
// #3832: a computer with a mouse and a keyboard is taught the same three things in its own words.
export const FIRST_HINT_STEPS_KEYBOARD = [
  { kind: 'walk', text: KEY_WALK_WORDS, airText: KEY_FLY_MOVE_WORDS },
  { kind: 'look', text: KEY_LOOK_WORDS },
  { kind: 'fly', text: KEY_FLY_WORDS, airText: KEY_LAND_WORDS },
];

export function createFirstVisitHints({ show, hide, done, markDone, steps = FIRST_HINT_STEPS, isFlying = () => false }) {
  let index = 0;
  let started = false;
  let shownIndex = -1;
  let shownText = null;
  const seen = new Set();
  const textFor = (step) => (isFlying() && step.airText ? step.airText : step.text);
  function advance() {
    while (index < steps.length && seen.has(steps[index].kind)) index++;
    if (index >= steps.length) {
      hide();
      markDone();
      return;
    }
    const text = textFor(steps[index]);
    if (shownIndex !== index || shownText !== text) show(text);
    shownIndex = index;
    shownText = text;
  }
  return {
    start() {
      if (started || done()) return false;
      started = true;
      advance();
      return true;
    },
    onGesture(kind) {
      seen.add(kind);
      if (started && index < steps.length) advance();
    },
    // Taking off or landing changes what the shown step should say.
    onFlightChange() {
      if (started && index < steps.length) advance();
    },
    stepIndex: () => index,
  };
}

// #3657: an account that has been through the hints is not taught again on a new device. Copies
// the account's "done" onto this device (never the other way round: an account with no opinion
// leaves the device as it is), the same shape as adoptAccountLoadingTips.
export function adoptAccountFirstHints(user, storage) {
  if (!user || user.firstHintsDone !== true) return;
  try {
    (storage || localStorage).setItem(FIRST_HINTS_KEY, '1');
  } catch { /* the hints may show again on this device; harmless */ }
}

function storageDone() {
  try { return localStorage.getItem(FIRST_HINTS_KEY) === '1'; } catch { return false; }
}
function storageMarkDone() {
  try { localStorage.setItem(FIRST_HINTS_KEY, '1'); } catch { /* the hints may show again; harmless */ }
  // #3657: tell the account too, so another device does not replay them. Best effort (a visitor
  // who is not signed in gets a 401 and the device alone remembers); loaded on demand so this
  // module's unit test does not pull the API client in.
  import('../api.js').then((api) => api.saveFirstHintsDone()).catch(() => {});
}

let el = null;
function ensureEl() {
  if (el?.isConnected) return el;
  el = document.createElement('div');
  el.id = 'world-hint';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  document.body.appendChild(el);
  return el;
}

export function startFirstVisitHints() {
  // A touch screen is taught the gestures; a computer (a fine pointer and no touch) is taught the
  // keys and the mouse (#3832). Anything else gets nothing.
  if (typeof window === 'undefined' || !window.matchMedia) return null;
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const fine = window.matchMedia('(pointer: fine)').matches;
  if (!coarse && !fine) return null;
  // Automated browsers (the e2e suite, scripts/live-site.mjs) are desktop-shaped; a hint over their
  // screenshots and clicks helps nobody, so the computer's hints are for real computers.
  if (!coarse && navigator.webdriver === true) return null;
  const hints = createFirstVisitHints({
    steps: coarse ? FIRST_HINT_STEPS : FIRST_HINT_STEPS_KEYBOARD,
    show: (text) => {
      const node = ensureEl();
      node.textContent = text;
      node.classList.add('visible');
    },
    hide: () => ensureEl().classList.remove('visible'),
    done: storageDone,
    markDone: storageMarkDone,
    isFlying: () => document.body.classList.contains('shop-flying'),
  });
  // The hint's words follow the person into the air and back down (#4080).
  let wasFlying = document.body.classList.contains('shop-flying');
  new MutationObserver(() => {
    const flying = document.body.classList.contains('shop-flying');
    if (flying !== wasFlying) {
      wasFlying = flying;
      hints.onFlightChange();
    }
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  window.addEventListener(WORLD_GESTURE_EVENT, (event) => hints.onGesture(event.detail?.kind));
  if (storageDone()) return hints;
  // Wait for the world: the loading screen, and any sign-in card, come first.
  const ready = () => document.body.classList.contains('shop-ready') && !document.querySelector('#auth-modal.visible');
  const tryStart = () => {
    if (!ready()) return false;
    observer.disconnect();
    hints.start();
    return true;
  };
  const observer = new MutationObserver(tryStart);
  observer.observe(document.body, { attributes: true, attributeFilter: ['class'], subtree: true });
  tryStart();
  return hints;
}
