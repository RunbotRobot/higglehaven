// #3649 (part of #3648, interface week #3539; the owner chose direction C, "one bud"):
// the interface folds into one small living thing in a corner. Tapping it unfolds petals;
// a petal runs an action or opens a leaf. This module is the small contract every other
// leaf of that work builds on (docs/DESIGN.md, "The bud"):
//
//   registerBudPetals(mode, [{ id, label, run, domId? }])  one definition per mode; a mode with none has no bud
//   openLeaf({ id, title, render }) / closeLeaf()  one soft sheet at a time, close upper-right
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

const toggle = () => document.getElementById('account-menu-toggle');
const panel = () => document.getElementById('account-menu-panel');

export function registerBudPetals(mode, petals) {
  registry.set(mode, petals.map((p) => ({ id: p.id, label: p.label, run: p.run, domId: p.domId })));
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
      // A petal may adopt a button that already exists (domId), keeping its id and its own
      // handler: the Build catalog's Add item is the one that did, so its tests and its
      // placement state (its label says Cancel while an item is being placed) carry over.
      const id = petal.domId ?? `bud-petal-${petalMode}-${petal.id}`;
      let btn = document.getElementById(id);
      if (btn && petal.domId && !btn.dataset.budMode) {
        btn.classList.add('bud-petal');
        btn.dataset.budMode = petalMode;
        btn.addEventListener('click', foldBud);
        if (btn.parentElement !== host) host.appendChild(btn);
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
        host.appendChild(btn);
      }
      btn.hidden = petalMode !== mode;
    }
  }
  if (!mode) return;
  // A mode with a definition has the bud; without one its old controls are still its way in.
  document.body.dataset.bud = registry.has(mode) ? 'on' : 'off';
  // #3723: the three modes are a group of their own, a half-ring of petals at the bud's corner
  // (docs/DESIGN.md, "The bud"), the same three in every mode with the current one marked. They
  // are the existing .mode-nav-btn buttons moved here, so their ids and handlers carry over; a
  // mode without a bud keeps them in the old top row.
  const ring = modesRing();
  for (const btn of document.querySelectorAll('.mode-nav-btn')) {
    const inBud = registry.has(mode);
    if (inBud && btn.parentElement !== ring) ring.appendChild(btn);
    if (!inBud && btn.parentElement === ring) document.getElementById('mode-nav')?.appendChild(btn);
    if (inBud && btn.dataset.mode === mode) btn.setAttribute('aria-current', 'true');
    else btn.removeAttribute('aria-current');
  }
}

// The ring lives after the petal column, so it is last in reading order, and CSS shows it only
// while the bud is unfolded. Choosing a mode folds the bud.
function modesRing() {
  let ring = document.getElementById('bud-modes');
  if (ring) return ring;
  ring = document.createElement('div');
  ring.id = 'bud-modes';
  ring.setAttribute('role', 'group');
  ring.setAttribute('aria-label', 'Places');
  ring.addEventListener('click', foldBud);
  panel()?.after(ring);
  return ring;
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
// the modes are the half-ring (#3723); How to move is a leaf. (Chat arrives with the
// leaf that moves the chat controls, so there is never a second way in.) Sell's own petals are
// registered by src/sell/mode.js, next to the product list they open (#3699).
registerBudPetals('shop', [
  { id: 'how-to-move', label: 'How to move', run: openHowToMoveLeaf },
]);

// Build's petals. The modes are the same half-ring as everywhere. Add item
// adopts the old "+ Add Item" button, so there is no second control for it: it sits in the bud and
// keeps its id and its handler (src/catalog/picker.js). Levels, Tools and Undo/Redo arrive with
// the slices that move them (#3690, #3691), so they are never in two places.
registerBudPetals('build', [
  { id: 'add-item', label: 'Add item', domId: 'add-item-btn', run: () => {} },
]);
