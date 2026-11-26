// #3783 (part of #3771): the picker a builder uses to choose the lettering and colours of their lándlet's name
// (My lándlets > Wordmark, beside Rename). The name is drawn in every option by the #3782 renderer, so the
// choice is made by looking at it; a tap applies at once (the preview and the sign change), the server stays
// the authority, and a refusal puts the previous choice back and says why, in text a person can select.
//
//   openWordmarkPicker({ name, styleId, colourId, save })   resolves { styleId, colourId } when it closes
//
// `save({ styleId, colourId })` stores the choice (the PATCH in src/api.js) and rejects with the server's reason.
// Which options appear is the shared list (shared/wordmark-set.js) through wordmarkOptions: with only the
// default on offer there is nothing to choose and the control that opens this is not drawn (menu.js).
import { openModalA11y, closeModalA11y } from './modal.js';
import { renderWordmark, wordmarkOptions, WORDMARK_COLOUR_PAIRS, WORDMARK_FACES } from './wordmark.js';
import { DEFAULT_WORDMARK_ID } from '../../shared/wordmark-set.js';

const modalEl = document.getElementById('wordmark-modal');
const closeBtn = document.getElementById('wordmark-modal-close-btn');
const previewNameEl = document.querySelector('#wordmark-preview .bud-place-name');
const stylesEl = document.getElementById('wordmark-styles');
const coloursEl = document.getElementById('wordmark-colours');
const statusEl = document.getElementById('wordmark-status');
const defaultBtn = document.getElementById('wordmark-default-btn');

let state = null; // { name, saved: {styleId, colourId}, save, resolve, offered, busy }

function say(message, { error = false } = {}) {
  statusEl.textContent = message;
  statusEl.classList.toggle('error', error);
}

// What is drawn right now: the saved choice, or the one just tapped while it is being stored.
function current() { return state.pending ?? state.saved; }

function paint() {
  const { styleId, colourId } = current();
  renderWordmark(previewNameEl, { name: state.name, styleId, colourId }, state.offered);
  for (const button of stylesEl.querySelectorAll('.wordmark-option')) button.setAttribute('aria-checked', String(button.dataset.id === styleId));
  for (const button of coloursEl.querySelectorAll('.wordmark-option')) button.setAttribute('aria-checked', String(button.dataset.id === colourId));
  defaultBtn.disabled = styleId === DEFAULT_WORDMARK_ID && colourId === DEFAULT_WORDMARK_ID;
}

async function choose(next) {
  if (state.busy) return;
  const before = state.saved;
  if (next.styleId === before.styleId && next.colourId === before.colourId) return;
  state.busy = true;
  state.pending = next; // shown at once; the server confirms afterwards
  say('');
  paint();
  try {
    await state.save(next);
    state.saved = next;
  } catch (err) {
    say(err?.message || "Couldn't save this lettering. Your last choice is back.", { error: true });
  } finally {
    state.pending = null;
    state.busy = false;
    paint();
  }
}

function optionButton({ id, label }, kind) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'wordmark-option';
  button.dataset.id = id;
  button.setAttribute('role', 'radio');
  button.setAttribute('aria-label', label);
  if (kind === 'style') {
    // The name itself, in this lettering (and the colours now chosen).
    const sample = document.createElement('span');
    sample.className = 'bud-place-name';
    renderWordmark(sample, { name: state.name, styleId: id, colourId: current().colourId }, state.offered);
    button.appendChild(sample);
    button.addEventListener('click', () => choose({ styleId: id, colourId: current().colourId }));
  } else {
    const pair = WORDMARK_COLOUR_PAIRS[id];
    if (pair) {
      const chip = document.createElement('span');
      chip.className = 'wordmark-chip';
      chip.setAttribute('aria-hidden', 'true');
      for (const color of [pair.ink, pair.accent]) { const half = document.createElement('i'); half.style.background = color; chip.appendChild(half); }
      button.appendChild(chip);
    }
    button.append(label);
    button.addEventListener('click', () => choose({ styleId: current().styleId, colourId: id }));
  }
  return button;
}

function close() {
  modalEl.classList.remove('visible');
  closeModalA11y(modalEl);
  const done = state?.resolve;
  const result = state?.saved;
  state = null;
  done?.(result);
}

closeBtn.addEventListener('click', close);
defaultBtn.addEventListener('click', () => choose({ styleId: DEFAULT_WORDMARK_ID, colourId: DEFAULT_WORDMARK_ID }));

export function openWordmarkPicker({ name, styleId = DEFAULT_WORDMARK_ID, colourId = DEFAULT_WORDMARK_ID, save, offered }) {
  return new Promise((resolve) => {
    state = { name, saved: { styleId, colourId }, pending: null, save, resolve, offered, busy: false };
    const options = wordmarkOptions(offered);
    stylesEl.replaceChildren(...options.styles.map((o) => optionButton(o, 'style')));
    coloursEl.replaceChildren(...options.colours.map((o) => optionButton(o, 'colour')));
    say('');
    paint();
    modalEl.classList.add('visible');
    openModalA11y(modalEl, close);
  });
}

// e2e only: opens the picker as if every candidate were offered (shared/wordmark-set.js holds only `default`
// until the owner picks), with a save the test controls. Inert unless a test calls it.
if (typeof window !== 'undefined') {
  window.__testOpenWordmarkPicker = (spec) => openWordmarkPicker({
    ...spec,
    offered: {
      styles: [DEFAULT_WORDMARK_ID, ...Object.keys(WORDMARK_FACES)],
      colours: [DEFAULT_WORDMARK_ID, ...Object.keys(WORDMARK_COLOUR_PAIRS)],
    },
  });
}
