// #3649 (part of #3648, interface week #3539; the owner chose direction C, "one bud"):
// the interface folds into one small living thing in a corner. Tapping it unfolds petals;
// a petal runs an action or opens a leaf. This module is the small contract every other
// leaf of that work builds on (docs/DESIGN.md, "The bud"):
//
//   registerBudPetals(mode, [{ id, label, name?, run, domId? }])  one definition per mode; a mode with none has no bud
//   addBudPetals(mode, [petal])                    adds petals to a mode without replacing the others
//                                                  (#3690: each Build slice adds its own); a petal with
//                                                  `element` adopts that element instead of making a
//                                                  button, and `visible()` says when it is drawn
//   refreshBud()                                   re-reads every `visible()` (call when it may have changed)
//   openLeaf({ id, title, render, onClose }) / closeLeaf()  one soft sheet at a time, close upper-right;
//                                                  onClose runs as it goes (give back anything lent to it)
//   setBudMark(key) / clearBudMark(key)            any key set shows the bud's one unread mark
//   setBudWord(key, text, { open, label }) / clearBudWord(key)
//                                                  the bud wears a short word beside it (a minimised
//                                                  conversation's name); "Menu" comes back when none is set.
//                                                  A word that announces something carries its door:
//                                                  `open` runs when the note is tapped (the owner of the
//                                                  key clears the word once the thing is open), `label`
//                                                  is what a screen reader says. With no `open` the word
//                                                  is just a word, as before (#3774)
//   beginBudModeSwitch(target)                     a mode petal was tapped (#3752): the chosen petal is lit at
//                                                  once and the ring stays open across the reload; the new page
//                                                  folds it when the mode is on screen
//
// The bud is the existing #account-menu-toggle and its petals are the buttons of
// #account-menu-panel, so the account rows (Settings, Friends, My Purchases, ...) are petals
// without being rebuilt, and the id the e2e suite drives is unchanged.

import { iconKeyFor, svgIcon } from './budIcons.js';

const FIRST_OPEN_KEY = 'hh_bud_opened';
const registry = new Map();
const marks = new Set();
const words = new Map();
const MENU_WORD = 'Menu';
let leafEl = null;
let leafId = null;

const toggle = () => document.getElementById('account-menu-toggle');
const panel = () => document.getElementById('account-menu-panel');

const copyPetal = (p) => ({ id: p.id, label: p.label, name: p.name, run: p.run, domId: p.domId, element: p.element, visible: p.visible });

export function registerBudPetals(mode, petals) {
  registry.set(mode, petals.map(copyPetal));
  syncBud();
}

// #3690: slices of one mode's petals land separately, so a leaf adds its own rather than
// rewriting the whole list. A petal with the same id replaces the earlier one.
export function addBudPetals(mode, petals) {
  const list = registry.get(mode) || [];
  for (const petal of petals) {
    const at = list.findIndex((p) => p.id === petal.id);
    if (at >= 0) list[at] = copyPetal(petal);
    else list.push(copyPetal(petal));
  }
  registry.set(mode, list);
  syncBud();
}

export function refreshBud() {
  syncBud();
}

export function budPetalsFor(mode) {
  return registry.get(mode) || [];
}

// #3752: the three mode petals grow out of the bud and fold back into it. body[data-bud-ring]
// says what the ring is doing beyond "the bud is unfolded" (src/app.css): "held" while a chosen
// mode loads (open, still, the chosen petal lit) and "folding" for the short trip back in.
const SWITCH_KEY = 'higglehaven.budSwitch';
const SWITCH_FRESH_MS = 60000;
const FOLD_MS = 300;
let foldTimer = null;
// The switch this page was opened by, if any: { target, from }.
let switching = null;

function setRing(state) {
  if (state) document.body.setAttribute('data-bud-ring', state);
  else document.body.removeAttribute('data-bud-ring');
}

function foldRing() {
  clearTimeout(foldTimer);
  setRing('folding');
  foldTimer = setTimeout(() => {
    if (document.body.getAttribute('data-bud-ring') === 'folding') setRing(null);
  }, FOLD_MS);
}

function foldBud() {
  const wasOpen = panel()?.classList.contains('expanded');
  panel()?.classList.remove('expanded');
  toggle()?.classList.remove('active');
  toggle()?.setAttribute('aria-expanded', 'false');
  // The petals fold in instead of vanishing, unless a mode is still loading (they stay out then).
  if (wasOpen && document.body.getAttribute('data-bud-ring') !== 'held') foldRing();
}

// Marks one mode's petal as the current one; the others are not.
function litPetal(mode) {
  for (const btn of document.querySelectorAll('.mode-nav-btn')) {
    if (btn.dataset.mode === mode) btn.setAttribute('aria-current', 'true');
    else btn.removeAttribute('aria-current');
  }
}

export function beginBudModeSwitch(target) {
  const from = document.body.dataset.mode || null;
  try { sessionStorage.setItem(SWITCH_KEY, JSON.stringify({ target, from, at: Date.now() })); } catch { /* the ring just folds as usual */ }
  litPetal(target);
}

function readSwitch() {
  let record = null;
  try {
    record = JSON.parse(sessionStorage.getItem(SWITCH_KEY) || 'null');
    sessionStorage.removeItem(SWITCH_KEY);
  } catch { return null; }
  if (!record || typeof record.target !== 'string' || Date.now() - Number(record.at) > SWITCH_FRESH_MS) return null;
  return { target: record.target, from: record.from };
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
      if (petal.element) {
        // An element that already exists (a pair of buttons with their own handlers): the bud
        // holds it and shows it only in its mode, and only while `visible()` says so.
        if (petal.element.parentElement !== host) host.appendChild(petal.element);
        petal.element.hidden = petalMode !== mode || (petal.visible ? !petal.visible() : false);
        continue;
      }
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
        // A petal whose word is a symbol ("?") names itself for a screen reader (#3818).
        if (petal.name) btn.setAttribute('aria-label', petal.name);
        btn.addEventListener('click', () => {
          foldBud();
          petal.run();
        });
        host.appendChild(btn);
      }
      btn.hidden = petalMode !== mode;
    }
  }
  scheduleStem();
  if (!mode) return;
  // A mode with a definition has the bud; without one its old controls are still its way in.
  document.body.dataset.bud = registry.has(mode) ? 'on' : 'off';
  // #3723: the three modes are a group of their own, a half-ring of petals at the bud's corner
  // (docs/DESIGN.md, "The bud"), the same three in every mode with the current one marked. They
  // are the existing .mode-nav-btn buttons moved here, so their ids and handlers carry over; a
  // mode without a bud keeps them in the old top row.
  placeModePetals(registry.has(mode), mode);
}

// The three mode buttons live in the ring while the bud is on and in the old top row while it is
// not; the current one is marked.
function placeModePetals(inBud, mode) {
  const ring = modesRing();
  for (const btn of document.querySelectorAll('.mode-nav-btn')) {
    if (inBud && btn.parentElement !== ring) ring.appendChild(btn);
    if (!inBud && btn.parentElement === ring) document.getElementById('mode-nav')?.appendChild(btn);
    if (inBud && btn.dataset.mode === mode) btn.setAttribute('aria-current', 'true');
    else btn.removeAttribute('aria-current');
    if (inBud) decoratePetal(btn);
  }
}

// #3761 (part of #3759): each of the three mode petals is a picture first with its one small word
// under it, like every leaf. The icon goes inside the petal's upright label, so it stays upright
// with the word however the petal is turned. Once per button; the word is the label's own text.
function decoratePetal(btn) {
  const label = btn.querySelector('.mode-nav-label');
  if (!label || label.querySelector('.bud-icon')) return;
  const icon = document.createElement('span');
  icon.className = 'bud-icon';
  icon.dataset.icon = iconKeyFor(btn);
  icon.appendChild(svgIcon(icon.dataset.icon));
  label.prepend(icon);
}


// #3761 (part of #3759): an open menu is a stem with leaves on both sides, and every leaf is an
// icon with its word under it. This only decorates and places what is already in the panel: which
// leaf is in which menu is decided elsewhere (registerBudPetals and friends), so it walks the
// *visible* children, never :nth-child, and runs again whenever one is added, shown, hidden or has
// its text replaced (Add item's "Cancel placing" does that).
function decorateLeaf(el) {
  // The sign-in leaf says "Log In / Sign Up" before an account and the person's name after it: an
  // arrow into a door, then a person.
  const key = el.id === 'account-auth-btn' && !/log in|sign up/i.test(el.textContent) ? 'person' : iconKeyFor(el);
  const have = el.querySelector(':scope > .bud-icon');
  if (have && have.dataset.icon === key) return;
  have?.remove();
  const icon = document.createElement('span');
  icon.className = 'bud-icon';
  icon.dataset.icon = key;
  icon.setAttribute('aria-hidden', 'true');
  icon.appendChild(svgIcon(key));
  el.prepend(icon);
}

function layoutStem() {
  const host = panel();
  if (!host) return;
  let index = 0;
  let last = null;
  for (const el of host.children) {
    if (!el.matches('button, .bud-pair')) continue;
    if (el.matches('.bud-pair')) el.querySelectorAll('button').forEach(decorateLeaf);
    else decorateLeaf(el);
    if (el.hidden || el.style.display === 'none') {
      el.removeAttribute('data-side');
      continue;
    }
    // Alternate: the first leaf on the right (the head is upper left, so the right has the room),
    // then left, and so on; --leaf-i staggers the unfold from the stem's root outward.
    el.setAttribute('data-side', index % 2 === 0 ? 'right' : 'left');
    el.style.setProperty('--leaf-i', String(index));
    last = el;
    index += 1;
  }
  // The stem ends at the middle of the last leaf, so the notes under the leaves (the lándlet cap)
  // are not struck through by it. Measured only while the panel is drawn.
  const hostBox = host.getBoundingClientRect();
  if (last && hostBox.height > 0) {
    const box = last.getBoundingClientRect();
    host.style.setProperty('--stem-h', `${Math.round(box.top + box.height / 2 - hostBox.top)}px`);
  }
}

let stemPending = false;
function scheduleStem() {
  if (stemPending) return;
  stemPending = true;
  queueMicrotask(() => {
    stemPending = false;
    layoutStem();
  });
}

let leafOnClose = null;

// The ring lives after the petal column, so it is last in reading order, and CSS shows it only
// while the bud is unfolded. Choosing a mode folds the bud.
function modesRing() {
  let ring = document.getElementById('bud-modes');
  if (ring && ring.dataset.wired) return ring;
  if (!ring) {
    ring = document.createElement('div');
    ring.id = 'bud-modes';
    ring.setAttribute('role', 'group');
    ring.setAttribute('aria-label', 'Places');
    panel()?.after(ring);
  }
  ring.dataset.wired = '1';
  // Another mode: the page reloads and keeps the ring out (beginBudModeSwitch). The mode you are
  // already in: nothing to load, so the bud just folds.
  ring.addEventListener('click', (event) => {
    const btn = event.target.closest?.('.mode-nav-btn');
    if (btn && btn.dataset.mode === document.body.dataset.mode) foldBud();
  });
  return ring;
}

export function closeLeaf() {
  const onClose = leafOnClose;
  leafOnClose = null;
  // Before the leaf goes, so anything it was lent can be handed back while it still exists.
  if (onClose) onClose();
  leafEl?.remove();
  leafEl = null;
  leafId = null;
}

export function openLeaf({ id, title, render, onClose = null }) {
  if (id === 'help') document.body.removeAttribute('data-bud-teach-help');
  closeLeaf();
  leafOnClose = onClose;
  foldBud();
  const leaf = document.createElement('section');
  leaf.className = 'bud-leaf';
  leaf.id = `bud-leaf-${id}`;
  leaf.setAttribute('role', 'dialog');
  leaf.setAttribute('aria-modal', 'true'); // #3818: with Tab kept inside it (below), nothing behind is reached
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
  nameHead();
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
// #3818: the head's name for a screen reader says what the sight shows: its word when it wears one
// that is not a door (a door has its own button) and that something new is waiting.
function nameHead() {
  const head = toggle();
  if (!head) return;
  const latest = [...words.values()].pop();
  const parts = ['Account menu'];
  if (latest && !latest.open) parts.push(latest.label || latest.text);
  if (marks.size > 0) parts.push('something new');
  head.setAttribute('aria-label', parts.join(', '));
}

function showWord() {
  const wordEl = toggle()?.querySelector('.bud-word');
  const latest = [...words.values()].pop();
  nameHead();
  if (wordEl) wordEl.textContent = latest ? latest.text : MENU_WORD;
  document.body.toggleAttribute('data-bud-word', words.size > 0);
  showNote(latest && latest.open ? latest : null);
}

// #3774: the note beside the head is a door when it announces something. It is its own button (a
// button cannot sit inside the head's button), attached to the head, 44px tall, and grows out of
// it and folds back like the petals. The plain word inside the head stays for words with no door.
let noteEl = null;
let noteTimer = null;
function ensureNote() {
  if (noteEl) return noteEl;
  const host = document.getElementById('account-menu');
  if (!host) return null;
  noteEl = document.createElement('button');
  noteEl.id = 'bud-note';
  noteEl.type = 'button';
  noteEl.hidden = true;
  noteEl.addEventListener('click', () => {
    const latest = [...words.values()].pop();
    if (!latest || !latest.open) return;
    foldBud();
    latest.open();
  });
  host.appendChild(noteEl);
  return noteEl;
}
function showNote(entry) {
  const el = entry ? ensureNote() : noteEl;
  if (!el) return;
  clearTimeout(noteTimer);
  if (entry) {
    el.textContent = entry.text;
    el.setAttribute('aria-label', entry.label || entry.text);
    el.classList.remove('folding');
    el.hidden = false;
    document.body.setAttribute('data-bud-note', 'on');
  } else if (!el.hidden) {
    document.body.removeAttribute('data-bud-note');
    el.classList.add('folding');
    noteTimer = setTimeout(() => { el.hidden = true; el.classList.remove('folding'); }, 180);
  }
}

export function setBudWord(key, text, { open = null, label = '' } = {}) {
  words.set(key, { text: String(text), open: typeof open === 'function' ? open : null, label: String(label || '') });
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
  document.body.removeAttribute('data-bud-teach-help');
}

if (typeof document !== 'undefined') {
  document.addEventListener('higglehaven:mode', syncBud);
  // #3752: this page was opened by tapping a mode petal. The ring is already out with the chosen
  // petal lit; it folds when the mode is on screen, or stays and says so when the mode will not load
  // (the opening screen shows the reason in a sentence).
  switching = readSwitch();
  if (switching) {
    // The bud and its ring are there from the first paint, so the opening screen does not show the
    // old top row for a moment first; syncBud takes over once the mode is known.
    document.body.dataset.bud = 'on';
    placeModePetals(true, switching.target);
    setRing('held');
  }
  document.addEventListener('higglehaven:mode-ready', () => {
    if (!switching) return;
    switching = null;
    foldRing();
  });
  document.addEventListener('higglehaven:mode-failed', () => {
    if (switching) litPetal(switching.from);
  });
  // Opening the bud again while the petals are still folding cancels the fold.
  if (panel()) {
    new MutationObserver(() => {
      if (panel().classList.contains('expanded') && document.body.getAttribute('data-bud-ring') === 'folding') {
        clearTimeout(foldTimer);
        setRing(null);
      }
    }).observe(panel(), { attributes: true, attributeFilter: ['class'] });
  }
  if (panel()) {
    new MutationObserver(scheduleStem).observe(panel(), { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'class'] });
    scheduleStem();
  }
  if (!learned()) document.body.setAttribute('data-bud-new', '');
  toggle()?.setAttribute('aria-controls', 'account-menu-panel');
  toggle()?.addEventListener('click', (event) => {
    if (panel()?.classList.contains('expanded')) markLearned();
    // #3762: the first time the bud is opened ever, the "?" leaf pulses so a newcomer sees where the
    // instructions are (the bud's own "Menu" word has gone while it is open). It stops when "?" is
    // opened or the bud is closed, and is not shown again once learned. The menu's own click handler
    // opens the panel after this one runs, hence the deferred check.
    else if (!learned()) setTimeout(() => { if (panel()?.classList.contains('expanded') && !learned()) document.body.setAttribute('data-bud-teach-help', ''); }, 0);
    // #3818: opened from the keyboard (Enter or Space gives a click with no pointer), focus goes
    // into the menu, to its first leaf, so Tab reads it in order; a tap leaves focus where it was.
    // Checked a frame later, for the same reason: the menu's own handler opens it after this one.
    if (event.detail === 0) {
      requestAnimationFrame(() => {
        if (!panel()?.classList.contains('expanded')) return;
        const first = [...panel().querySelectorAll('button')].find((b) => !b.hidden && b.getBoundingClientRect().width > 0);
        first?.focus({ preventScroll: true });
      });
    }
  });
  // #3818: while a leaf is open Tab stays inside it: from its last control to its first, and back.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab' || !leafEl) return;
    const items = [...leafEl.querySelectorAll('button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])')]
      .filter((el) => !el.disabled && !el.hidden && el.getBoundingClientRect().width > 0);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const here = document.activeElement;
    if (event.shiftKey && (here === first || !leafEl.contains(here))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (here === last || !leafEl.contains(here))) { event.preventDefault(); first.focus(); }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (leafEl) { closeLeaf(); toggle()?.focus({ preventScroll: true }); return; }
    if (panel()?.classList.contains('expanded')) { foldBud(); toggle()?.focus({ preventScroll: true }); }
  });
}

// Shop's petals. Settings, Friends and My Purchases are rows of the same panel already;
// the modes are the half-ring (#3723); "?" is a leaf that adds itself to Shop and Build from
// src/ui/helpLeaf.js (#3762: it holds how to move and the manuals; this file cannot import it, since it
// imports this one). (Chat arrives with the
// leaf that moves the chat controls, so there is never a second way in.) Sell's own petals are
// registered by src/sell/mode.js, next to the product list they open (#3699).
registerBudPetals('shop', []);

// Build's petals. The modes are the same half-ring as everywhere. Add item
// adopts the old "+ Add Item" button, so there is no second control for it: it sits in the bud and
// keeps its id and its handler (src/catalog/picker.js). Levels, Tools and Undo/Redo arrive with
// the slices that move them (#3690, #3691), so they are never in two places.
registerBudPetals('build', [
  { id: 'add-item', label: 'Add item', domId: 'add-item-btn', run: () => {} },
]);
