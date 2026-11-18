// #3702 (Sell in the bud, 4/6; part of #3655 and #3648): the card of a product tapped in the
// showroom. It blooms beside the product on the same shared mechanism as Shop's product card
// and Build's item card (src/ui/worldCard.js), follows it as the view moves, and carries the
// actions on the product directly under its name: Rename, Price (an inline field, so the price is
// on the card and not behind a link), Delete (its own in-app confirmation modal), and More, which
// opens My products on that product's row. The actions themselves are the ones the rows of My
// products use (src/sell/mode.js), so there is one copy of the wording and of the save guard.
import * as THREE from 'three';
import { createWorldCard } from '../ui/worldCard.js';
import { sellerShowcaseMeshes } from './showcase.js';
import {
  renameSellerProduct, saveSellerPrice, deleteSellerProduct, openSellerSheetOnProduct,
} from './mode.js';
import { formatDollarsForPriceInput, formatPriceCents } from '../main.js';

const cardEl = document.getElementById('seller-product-card');
const nameEl = document.getElementById('seller-product-card-name');
const priceEl = document.getElementById('seller-product-card-price');
const actionsEl = document.getElementById('seller-product-card-actions');
const renameBtn = document.getElementById('seller-product-card-rename-btn');
const priceBtn = document.getElementById('seller-product-card-price-btn');
const deleteBtn = document.getElementById('seller-product-card-delete-btn');
const moreBtn = document.getElementById('seller-product-card-more-btn');
const priceEditEl = document.getElementById('seller-product-card-price-edit');
const priceInput = document.getElementById('seller-product-card-price-input');
const priceSaveBtn = document.getElementById('seller-product-card-price-save-btn');
const statusEl = document.getElementById('seller-product-card-status');
const closeBtn = document.getElementById('seller-product-card-close-btn');
const card = createWorldCard(cardEl);

const scratchBox = new THREE.Box3();
const scratchCenter = new THREE.Vector3();
const scratchSize = new THREE.Vector3();
let openMesh = null;

const template = () => openMesh?.userData?.template ?? null;

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
  card.markDirty();
}

function fillCard() {
  const t = template();
  nameEl.textContent = t?.name ?? '';
  priceEl.textContent = t?.priceCents == null ? 'Not priced' : formatPriceCents(t.priceCents);
  card.markDirty();
}

function setPriceEditorOpen(open) {
  priceEditEl.hidden = !open;
  priceBtn.setAttribute('aria-expanded', String(open));
  if (open) {
    const t = template();
    priceInput.value = t?.priceCents == null ? '' : formatDollarsForPriceInput(t.priceCents / 100);
    priceInput.focus({ preventScroll: true });
  }
  card.markDirty();
}

export function isSellerProductCardOpen() {
  return openMesh !== null;
}

export function closeSellerProductCard() {
  if (openMesh === null && cardEl.hidden) return;
  openMesh = null;
  setPriceEditorOpen(false);
  setStatus('');
  card.close();
}

// A tap on a product in the showroom. A second tap on the same product keeps the card as it is.
export function openSellerProductCard(mesh) {
  if (!mesh?.userData?.template) return;
  const reopened = mesh === openMesh;
  openMesh = mesh;
  if (reopened) return;
  fillCard();
  setPriceEditorOpen(false);
  setStatus('');
  card.resetPlacement();
  // Place it before it is shown, so it never flashes at the corner.
  cardEl.hidden = false;
  updateSellerProductCard();
  card.bloom();
}

// Per frame (src/main.js wires it into Sell's frame update). The card goes when its product does:
// another showroom page, a delete, a rebuilt showcase.
export function updateSellerProductCard() {
  if (openMesh === null) return;
  if (!sellerShowcaseMeshes.includes(openMesh) || !openMesh.parent) {
    closeSellerProductCard();
    return;
  }
  scratchBox.setFromObject(openMesh);
  if (scratchBox.isEmpty()) return;
  scratchBox.getCenter(scratchCenter);
  scratchBox.getSize(scratchSize);
  card.place(scratchCenter, 0.5 * Math.max(scratchSize.x, scratchSize.y, scratchSize.z, 0.05));
}

function setBusy(busy) {
  for (const btn of [renameBtn, priceBtn, deleteBtn, moreBtn, priceSaveBtn]) btn.disabled = busy;
}

renameBtn.addEventListener('click', async () => {
  const t = template();
  if (!t) return;
  setStatus('');
  setBusy(true);
  const out = await renameSellerProduct(t, actionsEl);
  setBusy(false);
  if (out.changed) fillCard();
  if (out.error) setStatus(out.error, true);
});

priceBtn.addEventListener('click', () => setPriceEditorOpen(priceEditEl.hidden));

async function savePrice() {
  const t = template();
  if (!t) return;
  setStatus('');
  setBusy(true);
  const out = await saveSellerPrice(t, priceInput.value);
  setBusy(false);
  if (out.busy) setStatus('Another change to this product is still saving. Try again in a moment.', true);
  else if (out.error) setStatus(out.error, true);
  else if (out.noChange) setStatus('No change.');
  else if (out.saved) {
    fillCard();
    setPriceEditorOpen(false);
    setStatus('Saved.');
  }
}
priceSaveBtn.addEventListener('click', savePrice);
priceInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { event.preventDefault(); savePrice(); }
});

deleteBtn.addEventListener('click', async () => {
  const t = template();
  if (!t) return;
  setStatus('');
  const deleted = await deleteSellerProduct(t, deleteBtn);
  if (deleted) closeSellerProductCard();
});

moreBtn.addEventListener('click', () => {
  const t = template();
  if (!t) return;
  closeSellerProductCard();
  openSellerSheetOnProduct(t.templateId);
});

closeBtn.addEventListener('click', () => closeSellerProductCard());
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && openMesh !== null && !document.querySelector('[role="dialog"].visible')) {
    closeSellerProductCard();
  }
});
document.addEventListener('higglehaven:mode', closeSellerProductCard);

// e2e-only (same convention as window.__testItemCardAnchor): where the card's product is on screen.
window.__testSellerCardAnchor = () => card.anchor();
