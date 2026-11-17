// #3649 (part of #3648, interface week #3539; the owner chose direction C, "one bud"):
// the interface folds into one small living thing in a corner. Tapping it unfolds petals;
// a petal runs an action or opens a leaf. This module is the small contract every other
// leaf of that work builds on (docs/DESIGN.md, "The bud"):
//
//   registerBudPetals(mode, [{ id, label, run, domId?, ownVisibility? }])  one definition per mode; a mode with none has no bud
//   openLeaf({ id, title, render, onClose? }) / closeLeaf()  one soft sheet at a time, close upper-right
//   setBudMark(key) / clearBudMark(key)            any key set shows the bud's one unread mark
//   setBudWord(key, text) / clearBudWord(key)      the bud wears a short word beside it (a minimised
//                                                  conversation's name); "Menu" comes back when none is set
//
// The bud is the existing #account-menu-toggle and its petals are the buttons of
// #account-menu-panel, so the account rows (Settings, Friends, My Purchases, ...) are petals
// without being rebuilt, and the id the e2e suite drives is unchanged.

const FIRST_OPEN_KEY = 'hh_bud_opened';
const registry = new Map();
const marks = new Set();
const words = new Map();
const MENU_WORD = 'Menu';
let leafEl = null;
let leafId = null;
let leafOnClose = null;

const toggle = () => document.getElementById('account-menu-toggle');
const panel = () => document.getElementById('account-menu-panel');

export function registerBudPetals(mode, petals) {
  registry.set(mode, petals.map((p) => ({ id: p.id, label: p.label, run: p.run, domId: p.domId, ownVisibility: Boolean(p.ownVisibility) })));
  syncBud();
}

export function budPetalsFor(mode) {
  return registry.get(mode) || [];
}

// Build's petals sit together at the top of the open bud, in the order they were registered;
// Shop's go at the end, after the account rows, as they always did.
function placePetal(host, btn, petalMode) {
  if (petalMode !== 'build') { host.appendChild(btn); return; }
  const mine = [...host.querySelectorAll('[data-bud-mode="build"]')].filter((el) => el !== btn);
  if (mine.length) mine[mine.length - 1].after(btn);
  else host.prepend(btn);
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
      // A petal may adopt a button that already exists (domId), keeping its id and its own
      // handler: the Build catalog's Add item is the one that did, so its tests and its
      // placement state (its label says Cancel while an item is being placed) carry over.
      const id = petal.domId ?? `bud-petal-${petalMode}-${petal.id}`;
      let btn = document.getElementById(id);
      if (btn && petal.domId && !btn.dataset.budMode) {
        btn.classList.add('bud-petal');
        btn.dataset.budMode = petalMode;
        btn.addEventListener('click', foldBud);
        if (btn.parentElement !== host) placePetal(host, btn, petalMode);
      }
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
        placePetal(host, btn, petalMode);
      }
      // A petal with ownVisibility (Undo, Redo) is drawn or not by the code that knows when it is
      // usable; the bud only keeps it out of the other modes (app.css, [data-bud-mode]).
      if (!petal.ownVisibility) btn.hidden = petalMode !== mode;
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
  // A leaf that borrowed a part of the page (Levels borrows the level controls) hands it back first.
  const onClose = leafOnClose;
  leafOnClose = null;
  if (onClose) onClose();
  leafEl?.remove();
  leafEl = null;
  leafId = null;
}

export function openLeaf({ id, title, render, onClose }) {
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
  leafOnClose = onClose ?? null;
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

// #3653: while a word is set the bud wears it (the last one set), whether or not the bud has
// been opened before; with none set the default word and its first-visit rule apply again.
function showWord() {
  const wordEl = toggle()?.querySelector('.bud-word');
  const latest = [...words.values()].pop();
  if (wordEl) wordEl.textContent = latest ?? MENU_WORD;
  document.body.toggleAttribute('data-bud-word', words.size > 0);
}

export function setBudWord(key, text) {
  words.set(key, String(text));
  showWord();
}

export function clearBudWord(key) {
  words.delete(key);
  showWord();
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
    // The account menu's own handler toggles the panel in this same click; look after it has run.
    // Opening the bud puts a leaf away: its petals unfold over the same corner, and a leaf never
    // sits on top of another thing (#3690).
    setTimeout(() => { if (panel()?.classList.contains('expanded')) closeLeaf(); }, 0);
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

// Build's petals. The mode buttons (Shop, Sell) come in as petals the same way Shop's do. Add item,
// Undo and Redo adopt the old buttons, so there is no second control for them: they sit in the bud
// and keep their ids and handlers (src/catalog/picker.js, src/build/scene.js). Undo and Redo are
// drawn only while there is something to undo or redo (ownVisibility: scene.js decides, and
// app.css hides them in the other modes). Levels opens a leaf that borrows the level controls.
// Tools arrive with their own slice (#3691), so nothing is ever in two places.
function openLevelsLeaf() {
  const panel = document.getElementById('level-menu-panel');
  const home = document.getElementById('level-controls');
  if (!panel || !home) return;
  openLeaf({
    id: 'levels',
    title: 'Levels',
    render: (body) => {
      panel.classList.add('expanded');
      body.appendChild(panel);
    },
    onClose: () => {
      panel.classList.remove('expanded');
      home.appendChild(panel);
    },
  });
}

registerBudPetals('build', [
  { id: 'add-item', label: 'Add item', domId: 'add-item-btn', run: () => {} },
  { id: 'undo', label: 'Undo', domId: 'undo-btn', ownVisibility: true, run: () => {} },
  { id: 'redo', label: 'Redo', domId: 'redo-btn', ownVisibility: true, run: () => {} },
  { id: 'levels', label: 'Levels', run: openLevelsLeaf },
]);
