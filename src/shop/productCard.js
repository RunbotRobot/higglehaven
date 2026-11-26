// #3651 (leaf 3/9 of #3648, the bud): the card of a tapped product.
//
// Tapping a product in Shop makes a small card bloom BESIDE it (anchored to the
// product in the scene: it follows the product as the view moves and stays on
// screen), arriving through fog. It carries the name and price, any disclosure
// the buyer must see before buying (digital good, ships to the United States
// only, no returns, animation compatibility, test model), and one yellow Buy
// petal. A "More" petal opens Rate this product and Return policy, so the card
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
import { meshDimensions } from '../world/models.js';
import { createWorldCard } from '../ui/worldCard.js';
import { productInfoParts, setShopTappedProduct, shopReviews } from './worldSprites.js';
import { camera } from '../world/scene.js';
import { groupNearby, stepNearby, nearbyAnnouncement, distanceWords, directionWords, nameWithCount, NO_NEARBY_PRODUCTS } from './nearbyProducts.js';
import { turnViewToward } from './viewTurn.js';
import { productCardState, sellerLine } from './productCardLayout.js';
import { fetchSellerSummaries } from '../api.js';
import { loadOwnedProducts, isOwnedProduct } from './ownedProducts.js';
import { loadUnratedOrders, hasUnratedOrder } from './unratedOrders.js';

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

// The projection, the placement writes and the bloom are the shared world-card
// mechanism (src/ui/worldCard.js, #3689): Build's item card uses the same one.
const card = createWorldCard(cardEl);
const scratchWorld = new THREE.Vector3();

let openReview = null;

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
    sellerLookups.set(sellerId, fetchSellerSummaries([sellerId])
      .then((summaries) => {
        sellerNames.set(sellerId, summaries[sellerId] ?? null);
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
  sellerEl.textContent = sellerLine(sellerNames.get(sellerId)?.label, sellerNames.get(sellerId));
  if (!sellerId || sellerNames.has(sellerId)) return;
  loadSellerName(sellerId).then((name) => {
    if (review !== openReview) return; // folded away, or another product opened meanwhile
    sellerEl.textContent = sellerLine(name?.label, name);
    card.markDirty();
  });
}

// #3681: the last range the world reported for the open card, so the card can be
// worked out again when the owned list arrives after it opened.
let lastInRange = false;

// Read once per page load (and again after a purchase); the card opens at once and
// says "You already own this." when the answer arrives, never waiting on it.
function refreshOwnedState(review, { force = false } = {}) {
  Promise.all([loadOwnedProducts({ force }), loadUnratedOrders({ force })]).then(() => {
    if (review === openReview) syncProductCardActions(review, lastInRange);
  });
}

// Called by the Buy flow once a purchase has finished, so a card that is still
// open says so for what was just bought.
export function refreshOwnedAfterPurchase() {
  if (openReview) refreshOwnedState(openReview, { force: true });
  else { loadOwnedProducts({ force: true }); loadUnratedOrders({ force: true }); }
}

// #3775: after a rating is saved, the order it used is no longer unrated.
export function refreshRatedOrders() {
  if (openReview) refreshOwnedState(openReview, { force: true });
  else loadUnratedOrders({ force: true });
}

function fillCard(review) {
  const { name, priceText, notes } = productInfoParts(review.mesh.userData.template);
  nameEl.textContent = name;
  priceEl.textContent = priceText ?? '';
  fillSellerLine(review);
  refreshOwnedState(review);
  notesEl.textContent = notes.map((note) => `(${note})`).join(' ');
  cardEl.setAttribute('aria-label', name);
  // #3824: the Buy button names what it buys and for how much; the visible word "Buy" stays first.
  buyBtn.setAttribute('aria-label', `Buy ${name}${priceText ? `, ${priceText}` : ''}`);
  stateEl.textContent = '';
  for (const btn of [buyBtn, reviewBtn, returnPolicyBtn]) btn.classList.remove('visible');
  moreEl.hidden = true;
  moreBtn.setAttribute('aria-expanded', 'false');
  card.markDirty();
}

// Which petals show, and what the card says when it offers nothing. Called by
// updateReviewFade (worldSprites.js) whenever the tapped product or whether the
// shopper stands next to it changes. The decision itself is productCardState.
// #3945 (part of #3934): the card's own line after a purchase, in place of a "Thank you!" sheet.
// It lasts while this card stays open on this product.
let justBoughtReview = null;
export function markProductJustBought(review) {
  justBoughtReview = review;
  if (review && review === openReview) syncProductCardActions(review, lastInRange);
}

export function syncProductCardActions(review, inRange) {
  if (!review || review !== openReview) return;
  lastInRange = inRange;
  const template = review.mesh.userData.template;
  const state = productCardState({ template, inRange, owned: isOwnedProduct(template?.templateId), hasUnratedOrder: hasUnratedOrder(template?.templateId) });
  buyBtn.classList.toggle('visible', state.canBuy);
  reviewBtn.classList.toggle('visible', state.canReview);
  returnPolicyBtn.classList.toggle('visible', state.canReturnPolicy);
  // Nothing in More to open when neither petal in it applies.
  moreBtn.hidden = !(state.canReview || state.canReturnPolicy);
  if (moreBtn.hidden) {
    moreEl.hidden = true;
    moreBtn.setAttribute('aria-expanded', 'false');
  }
  stateEl.textContent = state.stateText || (review === justBoughtReview ? 'Yours now.' : '');
  card.markDirty();
}

export function openProductCard(review) {
  const reopened = review === openReview;
  openReview = review;
  if (!reopened) {
    fillCard(review);
    card.resetPlacement();
    // Place it before it is shown, so it never flashes at the corner.
    cardEl.hidden = false;
    updateProductCard();
    // Restart the bloom for a different product, even when a card was open.
    card.bloom();
  }
}

export function closeProductCard() {
  if (openReview === null && cardEl.hidden) return;
  openReview = null;
  justBoughtReview = null;
  card.close();
}

// #3824: the key way to a product. Opens the card of the next nearest product (or the previous with
// `direction` -1), says its name and place in the list in a polite live region, and puts keyboard
// focus on the card so Tab reaches its buttons and Escape folds it (focus goes back to the page).
// Returns false when no product is near.
const nearbyStatusEl = document.getElementById('shop-nearby-status');
const scratchNearby = new THREE.Vector3();
const scratchForward = new THREE.Vector3();
// #4049: one entry per product (a wall of one product is one entry, with a count), nearest first.
const productKey = (review) => { const t = review.mesh.userData.template; return t?.templateId ?? t?.name ?? review; };
const nearbyGroups = () => groupNearby(shopReviews, (review) => review.mesh.getWorldPosition(scratchNearby).distanceTo(camera.position), productKey);
const nearbyList = () => nearbyGroups().map((g) => g.item);

// Opens one product's card the way a tap does, with the same focus and announcement as N.
function showNearbyProduct(review, position, total) {
  setShopTappedProduct(review);
  openProductCard(review);
  if (nearbyStatusEl) nearbyStatusEl.textContent = nearbyAnnouncement(nameEl.textContent, position, total);
  cardEl.focus({ preventScroll: true });
}

export function stepToNearbyProduct(direction = 1) {
  const list = nearbyList();
  const step = stepNearby(list, openReview, direction);
  if (!step) {
    if (nearbyStatusEl) nearbyStatusEl.textContent = NO_NEARBY_PRODUCTS;
    return false;
  }
  showNearbyProduct(step.item, step.position, step.total);
  return true;
}

// The Nearby leaf (src/shop/nearbyLeaf.js): the same nearest-first products N steps through, as rows
// a screen reader can reach by name. `choose()` opens that product's card.
export function nearbyProductChoices() {
  const groups = nearbyGroups();
  const list = groups.map((g) => g.item);
  const forward = camera.getWorldDirection(scratchForward);
  return groups.map(({ item: review, count }, at) => {
    const world = review.mesh.getWorldPosition(scratchNearby);
    const x = world.x;
    const y = world.y;
    const metres = world.distanceTo(camera.position);
    return {
      name: nameWithCount(productInfoParts(review.mesh.userData.template).name, count),
      distance: distanceWords(metres),
      // #4044: which way it is from where the person is looking (plain words, no compass).
      direction: directionWords({ x: forward.x, y: forward.y }, { x: x - camera.position.x, y: y - camera.position.y }),
      // Turns the view to face it first (never moves the avatar), then opens the card where it now is.
      choose: () => {
        turnViewToward(x, y);
        showNearbyProduct(review, at + 1, list.length);
      },
    };
  });
}

// A shopper folding the card away themselves (the close button, Escape): the
// tapped product is forgotten too, so its highlight and its Rate/Buy gating go.
function dismissProductCard() {
  // #3824: focus on the card goes back to the page with it, not to nothing.
  if (cardEl.contains(document.activeElement)) document.activeElement.blur();
  setShopTappedProduct(null);
  closeProductCard();
}

// Per frame while a card is open (src/shop/flightMovement.js, right after the
// camera has been positioned for this frame).
export function updateProductCard() {
  if (!openReview || cardEl.hidden) return;
  const mesh = openReview.mesh;
  const world = mesh.getWorldPosition(scratchWorld);
  const dims = meshDimensions(mesh);
  card.place(world, 0.5 * Math.max(dims.width, dims.depth, dims.height, 0.05));
}

moreBtn.addEventListener('click', () => {
  const opening = moreEl.hidden;
  moreEl.hidden = !opening;
  moreBtn.setAttribute('aria-expanded', opening ? 'true' : 'false');
  card.markDirty();
});
closeBtn.addEventListener('click', dismissProductCard);
// Escape folds the card, unless a modal has just used that same Escape (the
// shared modal handler in src/ui/modal.js calls preventDefault when it does):
// cancelling the Buy confirmation must not also fold the card behind it.
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && openReview && !event.defaultPrevented) dismissProductCard();
});

// e2e-only (same window.__test* convention as the rest of Shop): where the
// last frame put the tapped product on screen, so a test can check the card
// sits beside it and follows it. null when no card is open. Inert otherwise.
window.__testProductCardAnchor = () => card.anchor();
