// #3649 (part of #3648, interface week #3539; the owner chose direction C, "one bud"):
// the interface folds into one small living thing in a corner. Tapping it unfolds petals;
// a petal runs an action or opens a leaf. This module is the small contract every other
// leaf of that work builds on (docs/DESIGN.md, "The bud"):
//
//   registerBudPetals(mode, [{ id, label, run, domId? }])  one definition per mode; a mode with none has no bud
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
//
// The bud is the existing #account-menu-toggle and its petals are the buttons of
// #account-menu-panel, so the account rows (Settings, Friends, My Purchases, ...) are petals
// without being rebuilt, and the id the e2e suite drives is unchanged.

import { iconKeyFor, svgIcon } from './budIcons.js';
import { BUD_MENUS, budMenuProblem } from './budMenuRules.js';

export { BUD_MENUS };

const FIRST_OPEN_KEY = 'hh_bud_opened';
const registry = new Map();
const marks = new Set();
const words = new Map();
const MENU_WORD = 'Menu';
// Rows that already sit in #account-menu-panel (static HTML with their own handlers) and the menu
// each belongs to. Everything else in the panel is a registered petal, which carries its own menu.
const STATIC_MENU = {
  'account-auth-btn': 'general',
  'notifications-btn': 'general',
  'friends-btn': 'general',
  'assistant-menu-btn': 'general',
  'my-purchases-btn': 'general',
  'settings-btn': 'general',
  'account-menu-tax-notice': 'general',
  'account-menu-landcap': 'build',
  'account-menu-landlet-info': 'build',
};
let openMenu = 'general';
let leafEl = null;
let leafId = null;

const toggle = () => document.getElementById('account-menu-toggle');
const panel = () => document.getElementById('account-menu-panel');

const copyPetal = (p) => ({ id: p.id, label: p.label, run: p.run, domId: p.domId, element: p.element, visible: p.visible });

function refuse(message) {
  if (import.meta.env?.DEV) throw new Error(`bud: ${message}`);
  console.error(`bud: ${message}`);
}
function accepted(menu, petals) {
  return petals.filter((petal) => {
    const problem = budMenuProblem(menu, petal);
    if (problem) refuse(problem);
    return !problem;
  });
}

export function registerBudPetals(mode, petals) {
  registry.set(mode, accepted(mode, petals).map(copyPetal));
  syncBud();
}

// #3690: slices of one mode's petals land separately, so a leaf adds its own rather than
// rewriting the whole list. A petal with the same id replaces the earlier one.
export function addBudPetals(mode, petals) {
  const list = registry.get(mode) || [];
  for (const petal of accepted(mode, petals)) {
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

function foldBud() {
  panel()?.classList.remove('expanded');
  toggle()?.classList.remove('active');
  toggle()?.setAttribute('aria-expanded', 'false');
}

// Petals registered for the current mode are buttons in the panel: created once, shown only
// while their mode is showing. Existing account rows keep their own handlers and ids.
// The general menu's petals show in every mode; a mode's own only while it is the current one.
const inMode = (petalMode, mode) => petalMode === 'general' || petalMode === mode;

// Every leaf in the panel carries the menu it belongs to, and is drawn only while that menu is the
// open one. The static rows are marked here; registered petals were marked as they were made.
function markMenus(host) {
  for (const [id, menu] of Object.entries(STATIC_MENU)) {
    const el = document.getElementById(id);
    if (el) el.dataset.budMenu = menu;
  }
  for (const el of host.querySelectorAll('[data-bud-menu]')) {
    el.toggleAttribute('data-menu-off', el.dataset.budMenu !== openMenu);
  }
}

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
        petal.element.dataset.budMenu = petalMode;
        petal.element.hidden = !inMode(petalMode, mode) || (petal.visible ? !petal.visible() : false);
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
        btn.addEventListener('click', () => {
          foldBud();
          petal.run();
        });
        host.appendChild(btn);
      }
      btn.dataset.budMenu = petalMode;
      btn.hidden = !inMode(petalMode, mode);
    }
  }
  markMenus(host);
  scheduleStem();
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
    if (el.hidden || el.hasAttribute('data-menu-off') || el.style.display === 'none') {
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
// while the bud is unfolded. It holds the three places and the general menu (#3760): four petals
// around the head. A place you are not in takes you there and folds the bud; the place you are in
// opens that place's own menu; "Menu" opens the general one. One stem is open at a time.
function modesRing() {
  let ring = document.getElementById('bud-modes');
  if (ring) return ring;
  ring = document.createElement('div');
  ring.id = 'bud-modes';
  ring.setAttribute('role', 'group');
  ring.setAttribute('aria-label', 'Places and menu');
  const menuBtn = document.createElement('button');
  menuBtn.type = 'button';
  menuBtn.id = 'bud-menu-general';
  menuBtn.className = 'bud-menu-btn';
  menuBtn.dataset.menu = 'general';
  menuBtn.textContent = 'Menu';
  ring.appendChild(menuBtn);
  ring.addEventListener('click', (event) => {
    const btn = event.target.closest('button');
    if (!btn) return;
    if (btn === menuBtn) { showMenu('general'); return; }
    if (btn.dataset.mode && btn.dataset.mode === document.body.dataset.mode) { showMenu(btn.dataset.mode); return; }
    foldBud();
  });
  panel()?.after(ring);
  return ring;
}

// A menu with nothing in it (Shop's, today) has no stem to open: tapping its petal does nothing.
function menuHasLeaves(menu) {
  return (registry.get(menu) || []).length > 0 || Object.values(STATIC_MENU).includes(menu);
}

export function currentBudMenu() {
  return openMenu;
}

// Open one menu's stem and close the other. `menu` is one of BUD_MENUS.
export function showMenu(menu) {
  if (!BUD_MENUS.includes(menu) || !menuHasLeaves(menu)) return;
  openMenu = menu;
  document.body.dataset.budMenu = menu;
  syncBud();
  for (const btn of document.querySelectorAll('#bud-modes button')) {
    const own = btn.dataset.mode ?? btn.dataset.menu;
    btn.setAttribute('aria-expanded', String(own === menu));
  }
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
  closeLeaf();
  leafOnClose = onClose;
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
}

if (typeof document !== 'undefined') {
  document.addEventListener('higglehaven:mode', () => { showMenu('general'); syncBud(); });
  // Every time the bud opens it opens on the general menu: the one thing in it that never changes.
  const host = panel();
  if (host) {
    let wasOpen = host.classList.contains('expanded');
    new MutationObserver(() => {
      const open = host.classList.contains('expanded');
      if (open && !wasOpen) showMenu('general');
      wasOpen = open;
    }).observe(host, { attributes: true, attributeFilter: ['class'] });
  }
  document.body.dataset.budMenu = openMenu;
  if (panel()) {
    new MutationObserver(scheduleStem).observe(panel(), { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'class'] });
    scheduleStem();
  }
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
  // #3760: My Lándlets is a Build tool, so it lives in Build's menu, not the general one. The row keeps
  // its id and its handler (src/account/menu.js, which also shows it only in Build).
  { id: 'my-lands', label: 'My Lándlets', domId: 'my-lands-btn', run: () => {} },
]);
