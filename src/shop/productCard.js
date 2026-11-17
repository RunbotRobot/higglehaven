// #3651 (leaf 3/9 of #3648, the bud): the card of a tapped product.
//
// Tapping a product in Shop makes a small card bloom BESIDE it (anchored to the
// product in the scene: it follows the product as the view moves and stays on
// screen), arriving through fog. It carries the name and price, any disclosure
// the buyer must see before buying (digital good, ships to the United States
// only, no returns, animation compatibility, test model), and one yellow Buy
// petal. A "More" petal opens Rate this Product and Return Policy, so the card
// never becomes a wall of controls. Tapping anywhere else in the world, the
// close button or Escape folds it away.
//
// It replaced #shop-product-preview-modal, which dimmed the world, locked the
// page behind it and drew a second 3D copy of the product. Nothing here is a
// modal: no focus trap, no scrim, and the world keeps moving behind it.
//
// Buy leads into the existing checkout unchanged: the button's click handler is
// still handleShopProductBuyClick in src/shop/productCheckout.js, which calls
// purchaseInstance and runCheckoutFlow exactly as before. Nothing about money
// lives in this file, and the card never says money has moved: that notice is
// the checkout's own, after the server has said so.
//
// Layout arithmetic is pure and unit-tested (productCardLayout.js). This file
// is the DOM and the projection: one project() per frame while a card is open,
// and a style write only when the placement actually changes.
import * as THREE from 'three';
import { camera } from '../world/scene.js';
import { meshDimensions } from '../world/models.js';
import { productInfoParts, setShopTappedProduct } from './worldSprites.js';
import {
  clampAnchorRadius, placeProductCard, productCardState, sellerLine,
} from './productCardLayout.js';
import { fetchSellerLabels } from '../api.js';
import { loadOwnedProducts, isOwnedProduct } from './ownedProducts.js';

const cardEl = document.getElementById('product-card');
const nameEl = document.getElementById('product-card-name');
const priceEl = document.getElementById('product-card-price');
const sellerEl = document.getElementById('product-card-seller');
const notesEl = document.getElementById('product-card-notes');
const stateEl = document.getElementById('product-card-state');
const buyBtn = document.getElementById('product-card-buy-btn');
const moreBtn = document.getElementById('product-card-more-btn');
const moreEl = document.getElementById('product-card-more');
const reviewBtn = document.getElementById('product-card-review-btn');
const returnPolicyBtn = document.getElementById('product-card-return-policy-btn');
const closeBtn = document.getElementById('product-card-close-btn');

// The bloom's own length (--motion-bloom is 0.45s) plus a little: how long the
// card stays in its 'blooming' state if no animationend ever arrives (a browser
// that skips animations, a hidden tab).
const BLOOM_FALLBACK_MS = 800;

const scratchWorld = new THREE.Vector3();
const scratchRight = new THREE.Vector3();
const scratchForward = new THREE.Vector3();
const scratchProjected = new THREE.Vector3();

let openReview = null;
let measuredSize = { width: 240, height: 120 };
let sizeDirty = true;
let lastPlacement = null;
let bloomTimer = null;
// Where the last frame put the product on screen. Read only by the e2e hook
// below; recomputed every frame the card is open.
let lastAnchor = null;

export function productCardBuyButton() {
  return buyBtn;
}

export function productCardReviewButton() {
  return reviewBtn;
}

export function productCardReturnPolicyButton() {
  return returnPolicyBtn;
}

export function isProductCardOpen() {
  return openReview !== null;
}

function setBloomState(state) {
  clearTimeout(bloomTimer);
  cardEl.dataset.state = state;
  if (state === 'blooming') {
    bloomTimer = setTimeout(() => {
      if (cardEl.dataset.state === 'blooming') cardEl.dataset.state = 'open';
    }, BLOOM_FALLBACK_MS);
  }
}

// #3680: seller storefront names already looked up (sellerId -> name, or null
// when the lookup found none), so tapping a second product of the same seller
// costs no request, and a card never waits on one: it opens at once and the line
// fills in when the answer arrives.
const sellerNames = new Map();
const sellerLookups = new Map();

function loadSellerName(sellerId) {
  if (!sellerId) return Promise.resolve(null);
  if (sellerNames.has(sellerId)) return Promise.resolve(sellerNames.get(sellerId));
  if (!sellerLookups.has(sellerId)) {
    sellerLookups.set(sellerId, fetchSellerLabels([sellerId])
      .then((labels) => {
        sellerNames.set(sellerId, labels[sellerId] ?? null);
        return sellerNames.get(sellerId);
      })
      // A failed lookup is not remembered as "no name": the next tap tries again.
      .catch(() => null)
      .finally(() => sellerLookups.delete(sellerId)));
  }
  return sellerLookups.get(sellerId);
}

function fillSellerLine(review) {
  const sellerId = review.mesh.userData.template?.sellerId;
  sellerEl.textContent = sellerLine(sellerNames.get(sellerId));
  if (!sellerId || sellerNames.has(sellerId)) return;
  loadSellerName(sellerId).then((name) => {
    if (review !== openReview) return; // folded away, or another product opened meanwhile
    sellerEl.textContent = sellerLine(name);
    sizeDirty = true;
  });
}

// #3681: the last range the world reported for the open card, so the card can be
// worked out again when the owned list arrives after it opened.
let lastInRange = false;

// Read once per page load (and again after a purchase); the card opens at once and
// says "You already own this." when the answer arrives, never waiting on it.
function refreshOwnedState(review, { force = false } = {}) {
  loadOwnedProducts({ force }).then(() => {
    if (review === openReview) syncProductCardActions(review, lastInRange);
  });
}

// Called by the Buy flow once a purchase has finished, so a card that is still
// open says so for what was just bought.
export function refreshOwnedAfterPurchase() {
  if (openReview) refreshOwnedState(openReview, { force: true });
  else loadOwnedProducts({ force: true });
}

function fillCard(review) {
  const { name, priceText, notes } = productInfoParts(review.mesh.userData.template);
  nameEl.textContent = name;
  priceEl.textContent = priceText ?? '';
  fillSellerLine(review);
  refreshOwnedState(review);
  notesEl.textContent = notes.map((note) => `(${note})`).join(' ');
  cardEl.setAttribute('aria-label', name);
  stateEl.textContent = '';
  for (const btn of [buyBtn, reviewBtn, returnPolicyBtn]) btn.classList.remove('visible');
  moreEl.hidden = true;
  moreBtn.setAttribute('aria-expanded', 'false');
  sizeDirty = true;
}

// Which petals show, and what the card says when it offers nothing. Called by
// updateReviewFade (worldSprites.js) whenever the tapped product or whether the
// shopper stands next to it changes. The decision itself is productCardState.
export function syncProductCardActions(review, inRange) {
  if (!review || review !== openReview) return;
  lastInRange = inRange;
  const template = review.mesh.userData.template;
  const state = productCardState({ template, inRange, owned: isOwnedProduct(template?.templateId) });
  buyBtn.classList.toggle('visible', state.canBuy);
  reviewBtn.classList.toggle('visible', state.canReview);
  returnPolicyBtn.classList.toggle('visible', state.canReturnPolicy);
  // Nothing in More to open when neither petal in it applies.
  moreBtn.hidden = !(state.canReview || state.canReturnPolicy);
  if (moreBtn.hidden) {
    moreEl.hidden = true;
    moreBtn.setAttribute('aria-expanded', 'false');
  }
  stateEl.textContent = state.stateText;
  sizeDirty = true;
}

export function openProductCard(review) {
  const reopened = review === openReview;
  openReview = review;
  if (!reopened) {
    fillCard(review);
    lastPlacement = null;
    // Place it before it is shown, so it never flashes at the corner.
    cardEl.hidden = false;
    updateProductCard();
    // Restart the bloom for a different product, even when a card was open.
    setBloomState('closed');
    // eslint-disable-next-line no-unused-expressions
    cardEl.offsetWidth;
    setBloomState('blooming');
  }
}

export function closeProductCard() {
  if (openReview === null && cardEl.hidden) return;
  openReview = null;
  lastPlacement = null;
  lastAnchor = null;
  clearTimeout(bloomTimer);
  cardEl.dataset.state = 'closed';
  cardEl.hidden = true;
}

// A shopper folding the card away themselves (the close button, Escape): the
// tapped product is forgotten too, so its highlight and its Rate/Buy gating go.
function dismissProductCard() {
  setShopTappedProduct(null);
  closeProductCard();
}

function measure() {
  const width = cardEl.offsetWidth;
  const height = cardEl.offsetHeight;
  if (width > 0 && height > 0) measuredSize = { width, height };
  sizeDirty = false;
}

// Per frame while a card is open (src/shop/flightMovement.js, right after the
// camera has been positioned for this frame).
export function updateProductCard() {
  if (!openReview || cardEl.hidden) return;
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const mesh = openReview.mesh;
  const world = mesh.getWorldPosition(scratchWorld);
  const dims = meshDimensions(mesh);
  const halfSize = 0.5 * Math.max(dims.width, dims.depth, dims.height, 0.05);

  camera.getWorldDirection(scratchForward);
  const behind = scratchProjected.copy(world).sub(camera.position).dot(scratchForward) <= camera.near;
  let anchor;
  if (behind) {
    anchor = { x: NaN, y: NaN, radius: 0, behind: true };
  } else {
    scratchProjected.copy(world).project(camera);
    const x = (scratchProjected.x * 0.5 + 0.5) * viewport.width;
    const y = (-scratchProjected.y * 0.5 + 0.5) * viewport.height;
    // The product's on-screen radius: how far a point half its size away,
    // sideways to the camera, lands from its centre.
    scratchRight.setFromMatrixColumn(camera.matrixWorld, 0).multiplyScalar(halfSize).add(world).project(camera);
    const rightX = (scratchRight.x * 0.5 + 0.5) * viewport.width;
    anchor = { x, y, radius: clampAnchorRadius(Math.abs(rightX - x)), behind: false };
  }
  lastAnchor = anchor;

  if (sizeDirty) measure();
  const place = placeProductCard({ anchor, card: measuredSize, viewport });
  const left = Math.round(place.left * 2) / 2;
  const top = Math.round(place.top * 2) / 2;
  const pointerY = Math.round(place.pointerY);
  const pointerX = Math.round(place.pointerX);
  const last = lastPlacement;
  if (last && last.left === left && last.top === top && last.side === place.side
    && last.edge === place.edge && last.pointerY === pointerY && last.pointerX === pointerX) return;
  lastPlacement = {
    left, top, side: place.side, edge: place.edge, pointerY, pointerX,
  };
  cardEl.style.setProperty('--card-x', `${left}px`);
  cardEl.style.setProperty('--card-y', `${top}px`);
  cardEl.style.setProperty('--pointer-y', `${pointerY}px`);
  cardEl.style.setProperty('--pointer-x', `${pointerX}px`);
  cardEl.dataset.side = place.side;
  cardEl.dataset.edge = place.edge ? 'true' : 'false';
}

moreBtn.addEventListener('click', () => {
  const opening = moreEl.hidden;
  moreEl.hidden = !opening;
  moreBtn.setAttribute('aria-expanded', opening ? 'true' : 'false');
  sizeDirty = true;
});
closeBtn.addEventListener('click', dismissProductCard);
cardEl.addEventListener('animationend', (event) => {
  if (event.target === cardEl && cardEl.dataset.state === 'blooming') setBloomState('open');
});
// Escape folds the card, unless a modal has just used that same Escape (the
// shared modal handler in src/ui/modal.js calls preventDefault when it does):
// cancelling the Buy confirmation must not also fold the card behind it.
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && openReview && !event.defaultPrevented) dismissProductCard();
});

// e2e-only (same window.__test* convention as the rest of Shop): where the
// last frame put the tapped product on screen, so a test can check the card
// sits beside it and follows it. null when no card is open. Inert otherwise.
window.__testProductCardAnchor = () => lastAnchor;
