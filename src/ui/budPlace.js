// #3770 (part of #3759, the flower): the lándlet a person is on is named at the top of the open
// menu, before any leaf, as a small wordmark with "by <builder>" under it. It answers "where am I?".
// The name and the builder are separate spans and the lettering lives on one class (.bud-place-name),
// so the wordmark renderer (#3782) swaps that class and its face without touching the layout.
// The element keeps its old id, account-menu-landlet-info, so what reads it carries over.
//
//   showBudPlace({ name, builder })   name the place; builder is the person's label or null
//   hideBudPlace()                    nothing is named (not on a lándlet, or the Sell showroom,
//                                     which is not a real place, so nothing is made up for it)
//
// The text is real text a person can select; tapping it does nothing.
import { renderWordmark } from './wordmark.js';

const placeEl = () => document.getElementById('account-menu-landlet-info');
const part = (cls) => placeEl()?.querySelector(`.${cls}`);

export function showBudPlace({ name, builder, wordmarkStyle, wordmarkColors }) {
  const el = placeEl();
  if (!el) return;
  // #3782: the lettering the builder chose (the default look when none is stored or offered).
  renderWordmark(part('bud-place-name'), { name, styleId: wordmarkStyle, colourId: wordmarkColors });
  part('bud-place-by').textContent = builder ? `by ${builder}` : '';
  el.hidden = !name;
  watchClipping(el);
  markClipped(el);
}

// #3844: past its height cap the sign scrolls inside itself; a fade says there is more. It is
// measured when the name changes and whenever the sign is laid out again (it has no size while the
// menu is folded, so opening the menu is what shows whether it is clipped).
function markClipped(el) {
  requestAnimationFrame(() => el.toggleAttribute('data-clipped', el.scrollHeight > el.clientHeight + 1));
}
let watching = null;
function watchClipping(el) {
  if (watching === el || typeof ResizeObserver === 'undefined') return;
  watching = el;
  new ResizeObserver(() => markClipped(el)).observe(el);
}

// e2e only (#3844): names the place without a lándlet to stand on, to try long names. Inert unless called.
if (typeof window !== 'undefined') window.__testShowBudPlace = showBudPlace;

export function hideBudPlace() {
  const el = placeEl();
  if (el) el.hidden = true;
}
