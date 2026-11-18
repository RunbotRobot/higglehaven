// #3657: the first time someone is in the world on a touch screen, one quiet hint at a time
// appears in the world (never a modal, never blocking) and goes as soon as they do the thing it
// names: walk, then look, then fly. After the last one it never comes back on this device.
// (The owner's "Signing in on a new device does not replay it" needs a server-side flag per
// account; that is the follow-up, tracked on #3657. Until then it is remembered per browser.)
// Driven by the world-gesture events src/shop/flightMovement.js already fires, once per kind.
// Same string as WORLD_GESTURE_EVENT in src/shop/flightMovement.js (not imported: that module needs a
// browser page to load, which would pull the whole world into this one's unit test).
const WORLD_GESTURE_EVENT = 'higglehaven:world-gesture';

import { WALK_WORDS, LOOK_WORDS, FLY_WORDS } from './gestureWords.js';

export const FIRST_HINTS_KEY = 'higglehaven.firstHints.done';
export const FIRST_HINT_STEPS = [
  { kind: 'walk', text: WALK_WORDS },
  { kind: 'look', text: LOOK_WORDS },
  { kind: 'fly', text: FLY_WORDS },
];

export function createFirstVisitHints({ show, hide, done, markDone, steps = FIRST_HINT_STEPS }) {
  let index = 0;
  let started = false;
  let shownIndex = -1;
  const seen = new Set();
  function advance() {
    while (index < steps.length && seen.has(steps[index].kind)) index++;
    if (index >= steps.length) {
      hide();
      markDone();
      return;
    }
    if (shownIndex !== index) show(steps[index].text);
    shownIndex = index;
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
    stepIndex: () => index,
  };
}

function storageDone() {
  try { return localStorage.getItem(FIRST_HINTS_KEY) === '1'; } catch { return false; }
}
function storageMarkDone() {
  try { localStorage.setItem(FIRST_HINTS_KEY, '1'); } catch { /* the hints may show again; harmless */ }
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
  // Touch screens only: a mouse and keyboard person has the keys and the "?" leaf.
  if (typeof window === 'undefined' || !window.matchMedia?.('(pointer: coarse)').matches) return null;
  const hints = createFirstVisitHints({
    show: (text) => {
      const node = ensureEl();
      node.textContent = text;
      node.classList.add('visible');
    },
    hide: () => ensureEl().classList.remove('visible'),
    done: storageDone,
    markDone: storageMarkDone,
  });
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
