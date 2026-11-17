// #3649 (part of #3648, interface week #3539; the owner chose direction C, "one bud"):
// the interface folds into one small living thing in a corner. Tapping it unfolds petals;
// a petal runs an action or opens a leaf. This module is the small contract every other
// leaf of that work builds on (docs/DESIGN.md, "The bud"):
//
//   registerBudPetals(mode, [{ id, label, run }])  one definition per mode; a mode with none has no bud
//   openLeaf({ id, title, render }) / closeLeaf()  one soft sheet at a time, close upper-right
//   setBudMark(key) / clearBudMark(key)            any key set shows the bud's one unread mark
//
// The bud is the existing #account-menu-toggle and its petals are the buttons of
// #account-menu-panel, so the account rows (Settings, Friends, My Purchases, ...) are petals
// without being rebuilt, and the id the e2e suite drives is unchanged.

const FIRST_OPEN_KEY = 'hh_bud_opened';
const registry = new Map();
const marks = new Set();
let leafEl = null;
let leafId = null;

const toggle = () => document.getElementById('account-menu-toggle');
const panel = () => document.getElementById('account-menu-panel');

export function registerBudPetals(mode, petals) {
  registry.set(mode, petals.map((p) => ({ id: p.id, label: p.label, run: p.run })));
  syncBud();
}

export function budPetalsFor(mode) {
  return registry.get(mode) || [];
}

function foldBud() {
  panel()?.classList.remove('expanded');
  toggle()?.classList.remove('active');
  toggle()?.setAttribute('aria-expanded', 'false');
}

// Petals registered for the current mode are buttons in the panel: created once, shown only
// while their mode is showing. Existing account rows keep their own handlers and ids.
function syncBud() {
  // Until a mode has been entered (setCurrentMode) nothing is decided: no flash of the bud
  // on a page that is about to be Build or Sell.
  const mode = document.body.dataset.mode;
  const host = panel();
  if (!host) return;
  for (const [petalMode, petals] of registry) {
    for (const petal of petals) {
      const id = `bud-petal-${petalMode}-${petal.id}`;
      let btn = document.getElementById(id);
      if (!btn) {
        btn = document.createElement('button');
        btn.type = 'button';
        btn.id = id;
        btn.className = 'bud-petal';
        btn.dataset.budMode = petalMode;
        btn.textContent = petal.label;
        btn.addEventListener('click', () => {
          foldBud();
          petal.run();
        });
        host.appendChild(btn);
      }
      btn.hidden = petalMode !== mode;
    }
  }
  if (!mode) return;
  // A mode with a definition has the bud; without one its old controls are still its way in.
  document.body.dataset.bud = registry.has(mode) ? 'on' : 'off';
  // Shop's mode buttons become petals; the old top row (logo, gear, pills) is gone in Shop.
  for (const btn of document.querySelectorAll('.mode-nav-btn')) {
    const inBud = registry.has(mode) && btn.dataset.mode !== mode;
    if (inBud && btn.parentElement !== host) host.appendChild(btn);
    if (!inBud && btn.parentElement === host) document.getElementById('mode-nav')?.appendChild(btn);
  }
}

export function closeLeaf() {
  leafEl?.remove();
  leafEl = null;
  leafId = null;
}

export function openLeaf({ id, title, render }) {
  closeLeaf();
  foldBud();
  const leaf = document.createElement('section');
  leaf.className = 'bud-leaf';
  leaf.id = `bud-leaf-${id}`;
  leaf.setAttribute('role', 'dialog');
  leaf.setAttribute('aria-labelledby', `${leaf.id}-title`);
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'bud-leaf-close';
  close.setAttribute('aria-label', 'Close');
  close.textContent = '×';
  close.addEventListener('click', () => {
    closeLeaf();
    toggle()?.focus({ preventScroll: true });
  });
  const heading = document.createElement('h2');
  heading.id = `${leaf.id}-title`;
  heading.textContent = title;
  const body = document.createElement('div');
  body.className = 'bud-leaf-body';
  leaf.append(close, heading, body);
  document.body.appendChild(leaf);
  leafEl = leaf;
  leafId = id;
  render(body);
  close.focus({ preventScroll: true });
  return body;
}

export function currentLeafId() {
  return leafId;
}

function showMarks() {
  document.body.toggleAttribute('data-bud-mark', marks.size > 0);
}

export function setBudMark(key) {
  marks.add(key);
  showMarks();
}

export function clearBudMark(key) {
  marks.delete(key);
  showMarks();
}

// Until the bud has been opened once it pulses and says Menu; after that the word goes.
function learned() {
  try { return localStorage.getItem(FIRST_OPEN_KEY) === '1'; } catch { return false; }
}
function markLearned() {
  try { localStorage.setItem(FIRST_OPEN_KEY, '1'); } catch { /* the word just stays */ }
  document.body.removeAttribute('data-bud-new');
}

if (typeof document !== 'undefined') {
  document.addEventListener('higglehaven:mode', syncBud);
  if (!learned()) document.body.setAttribute('data-bud-new', '');
  toggle()?.addEventListener('click', () => {
    if (panel()?.classList.contains('expanded')) markLearned();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (leafEl) { closeLeaf(); toggle()?.focus({ preventScroll: true }); return; }
    if (panel()?.classList.contains('expanded')) { foldBud(); toggle()?.focus({ preventScroll: true }); }
  });
}

// How to move: one leaf, shared by every mode that walks the world with Shop's controls.
export function openHowToMoveLeaf() {
  openLeaf({
    id: 'how-to-move',
    title: 'How to move',
    render: (body) => {
      const lines = [
        'Walk: the left stick, or W A S D / the arrow keys.',
        'Look: the right stick, or Q and E to turn.',
        'Fly: the bird button, or press Space twice.',
        'Tap a product to look at it.',
      ];
      for (const text of lines) {
        const p = document.createElement('p');
        p.textContent = text;
        body.appendChild(p);
      }
    },
  });
}

// Shop's petals. Settings, Friends and My Purchases are rows of the same panel already;
// Build and Sell are the mode buttons moved in; How to move is a leaf. (Chat arrives with the
// leaf that moves the chat controls, so there is never a second way in.) Sell's own petals are
// registered by src/sell/mode.js, next to the product list they open (#3699).
registerBudPetals('shop', [
  { id: 'how-to-move', label: 'How to move', run: openHowToMoveLeaf },
]);
