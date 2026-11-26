// #3689 (leaf 2/6 of #3654, Build in the bud): the card of the selected item.
// It blooms beside what is selected and follows it as the view moves, on the same
// mechanism as the Shop product card (src/ui/worldCard.js), so there is one way a
// card sits in the world. Its title is the item's name (#3573); Copy, Delete and
// Snap are buttons of the card (their handlers stay in scene.js, unchanged).
import * as THREE from 'three';
import { createWorldCard } from '../ui/worldCard.js';

const cardEl = document.getElementById('item-card');
const nameEl = document.getElementById('item-card-name');
const moreBtn = document.getElementById('item-card-more-btn');
const moreEl = document.getElementById('item-card-more');
const closeBtn = document.getElementById('item-card-close-btn');
const card = createWorldCard(cardEl);
const ABOVE_EXTRA_CLEARANCE_PX = 60; // #4410: the up arrow reaches about 165 px above the middle (tip included), the others about 135
const RING_CLEARANCE_PX = 122; // #4410: the movement arrows (drawn a little larger than the rings) reach about 110 px
// #3691: the Selecting brush's size slider. It lives in #tool-controls (and the Tools leaf lends it
// out); while Selecting is on and the card shows the selection, it is hosted here, beside what is
// being painted, so it can be adjusted without leaving the world. scene.js keeps the same element,
// ids and handlers: this only changes where it sits.
const brushSlot = document.getElementById('item-card-brush');
const brushEl = document.getElementById('multiselect-brush-control');
const brushHome = document.getElementById('tool-controls');

export function isBrushInItemCard() {
  return brushSlot.contains(brushEl);
}

function hostBrush() {
  if (!brushSlot.contains(brushEl)) {
    brushSlot.append(brushEl);
    card.markDirty();
  }
}

function unhostBrush() {
  if (brushSlot.contains(brushEl)) {
    brushHome.append(brushEl);
    card.markDirty();
  }
}

// The Tools leaf hands the slider back to #tool-controls as it closes; if the card is still
// showing a Selecting selection, take it again.
export function syncBrushHost() {
  if (open && cardEl.classList.contains('pass-through')) hostBrush();
}

const scratchCenter = new THREE.Vector3();
const scratchSize = new THREE.Vector3();
let open = false;
let onClose = () => {};

export function setItemCardCloseHandler(fn) {
  onClose = fn;
}

export function isItemCardOpen() {
  return open;
}

moreBtn.addEventListener('click', () => {
  const expand = moreEl.hidden;
  moreEl.hidden = !expand;
  moreBtn.setAttribute('aria-expanded', String(expand));
  card.markDirty();
});

closeBtn.addEventListener('click', () => onClose());

// title: the item's name, or "N items selected". Called whenever the selection
// changes; blooms only when the card was not already showing.
// passThrough: in multi-select the next taps add items to the selection, so the card
// shrinks to its title and lets every tap through to the world.
export function showItemCard(title, { passThrough = false } = {}) {
  if (cardEl.classList.contains('pass-through') !== passThrough) {
    cardEl.classList.toggle('pass-through', passThrough);
    card.markDirty();
  }
  if (passThrough) hostBrush();
  else unhostBrush();
  const wasOpen = open;
  if (nameEl.textContent !== title) {
    nameEl.textContent = title;
    card.markDirty();
  }
  if (wasOpen) return;
  open = true;
  card.resetPlacement();
  cardEl.hidden = false;
  card.bloom();
}

export function hideItemCard() {
  if (!open) return;
  open = false;
  unhostBrush();
  nameEl.textContent = '';
  moreEl.hidden = true;
  moreBtn.setAttribute('aria-expanded', 'false');
  card.close();
}

// box: the selection's world-space THREE.Box3 (already computed this frame by the
// selection boxes, so no extra pass over the members).
export function updateItemCard(box, { holding = false } = {}) {
  if (!open || !box || box.isEmpty()) return;
  card.hold(holding); // #4242: a ring being dragged: the card stays put and lets touches through
  box.getCenter(scratchCenter);
  box.getSize(scratchSize);
  // #4118: the three rings reach about 100 px from the item on a phone, and the owner: "The product
  // information popup blocks us from accessing the rotation handle easily." The card keeps that much
  // clear space round the item, so it opens beyond the rings, not on them.
  card.place(scratchCenter, 0.5 * Math.max(scratchSize.x, scratchSize.y, scratchSize.z, 0.05), RING_CLEARANCE_PX, ABOVE_EXTRA_CLEARANCE_PX);
}

window.__testItemCardAnchor = () => card.anchor();
