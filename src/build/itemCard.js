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
  nameEl.textContent = '';
  moreEl.hidden = true;
  moreBtn.setAttribute('aria-expanded', 'false');
  card.close();
}

// box: the selection's world-space THREE.Box3 (already computed this frame by the
// selection boxes, so no extra pass over the members).
export function updateItemCard(box) {
  if (!open || !box || box.isEmpty()) return;
  box.getCenter(scratchCenter);
  box.getSize(scratchSize);
  card.place(scratchCenter, 0.5 * Math.max(scratchSize.x, scratchSize.y, scratchSize.z, 0.05));
}

window.__testItemCardAnchor = () => card.anchor();
