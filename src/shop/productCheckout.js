// #2628 (leaf of #2563, itself part of #2504/#2500's src/main.js module
// split -- see #2503's design comment and #2563's own breakdown comment
// for the full dependency map): Shop mode's tap-to-inspect product-preview
// modal, the Stripe checkout flow, post-purchase confetti, and the
// buy/review-button and refund-policy click handlers.
//
// Depends on shop/worldSprites.js (#2627, already landed) -- reads
// shopTappedProduct (the tap-to-inspect listener's own state, still owned
// by main.js's click listener and worldSprites.js's updateReviewFade) and
// shopReviews, calls rebuildReviewSprites/productInfoText back.
//
// Deliberately NOT included here, even though main.js's own tap-to-inspect
// click listener (which sets shopTappedProduct and calls
// openShopProductPreviewModal/closeShopProductPreviewModal, both below)
// lives right alongside this module's own code -- that listener itself
// stays in main.js, which imports those two functions back from here.
// spawnConfettiBurst/updateConfettiBursts are called forward from
// worldSprites.js's checkScheduledCalendarEvents and
// shop/flightMovement.js's per-frame loop respectively -- both of those
// modules now import them from here instead of from main.js.
//
// loadStripeJs/stripeJsPromise stay in main.js (src/account/auth.js's own
// card-verification step also needs them, pending the eventual
// src/shop/mode.js extraction) -- imported back below for runCheckoutFlow.
// formatPriceCents also stays in main.js (shared well beyond Shop mode),
// imported back the same way.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { openModalA11y, closeModalA11y } from '../ui/modal.js';
import { createMeshForInstance, disposeObject } from '../world/models.js';
import {
  createProductReview, editProductReview, deleteProductReview, createSellerFeedback,
  purchaseInstance, clearPurchaseIdempotencyKey, finalizePurchase,
} from '../api.js';
import { ensureBuilderIdentity } from '../account/identity.js';
import { currentAuthUser } from '../account/auth.js';
import { loadStripeJs, formatPriceCents } from '../main.js';
import { shopTappedProduct, shopReviews, rebuildReviewSprites, productInfoText } from './worldSprites.js';

const shopProductPreviewModalEl = document.getElementById('shop-product-preview-modal');
const shopProductPreviewCanvas = document.getElementById('shop-product-preview-canvas');
const shopProductPreviewInfoEl = document.getElementById('shop-product-preview-info');
const shopProductPreviewReviewBtn = document.getElementById('shop-product-preview-review-btn');
const shopProductPreviewBuyBtn = document.getElementById('shop-product-preview-buy-btn');
const refundPolicyModalEl = document.getElementById('refund-policy-modal');
const checkoutModalEl = document.getElementById('checkout-modal');
const checkoutSummaryEl = document.getElementById('checkout-summary');
const checkoutCardElementEl = document.getElementById('checkout-card-element');
const checkoutStatusEl = document.getElementById('checkout-status');
const checkoutPayBtn = document.getElementById('checkout-pay-btn');
const checkoutCancelBtn = document.getElementById('checkout-cancel-btn');

// #1811 (sub-issue of #1809): isolated 3D preview for a tapped product,
// replacing the old #shop-product-info pill (removed in #1813). Same
// self-contained-scene technique as Sell mode's own showAxisPreview/
// disposeAxisPreview -- a dedicated scene/camera/renderer/controls bound
// to this modal's own canvas, built via createMeshForInstance so a real
// scanned model (or placeholder box) renders exactly as it would in the
// world, not a simplified stand-in. No axis arrows here (this modal is
// read-only "what is this," not the Extensibility editor those arrows
// serve), and no shared-canvas reparenting (this canvas always lives in
// this one modal's own markup, unlike the seller preview's single canvas
// moved between row panels).
let shopProductPreview = null;
// Same reopen-before-the-previous-load-finishes guard as
// axisPreviewLoadToken -- a quick double-tap, or tapping a second product
// before createMeshForInstance's await on the first resolves, would
// otherwise race two calls into building their own renderer bound to the
// same canvas.
let shopProductPreviewLoadToken = 0;

function disposeShopProductPreview() {
  if (!shopProductPreview) return;
  shopProductPreview.controls.dispose();
  shopProductPreview.renderer.dispose();
  disposeObject(shopProductPreview.previewObject);
  shopProductPreview = null;
}

async function showShopProductPreview(template) {
  const myLoadToken = ++shopProductPreviewLoadToken;
  disposeShopProductPreview();

  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 0.8);
  sun.position.set(2, -3, 4);
  scene.add(sun);

  // #1876: lets an e2e test simulate a slow load deterministically, same
  // reasoning as window.__testUploadPreviewLoadDelayMs (#1465). Always
  // undefined outside of that one test.
  if (window.__testShopProductPreviewLoadDelayMs) {
    await new Promise((resolve) => setTimeout(resolve, window.__testShopProductPreviewLoadDelayMs));
  }
  // At the origin and with no crop, same as showAxisPreview -- shows the
  // product's real full-size geometry, not the specific crop any one
  // placed instance of it happens to have in the world.
  const previewObject = await createMeshForInstance({
    templateId: template.templateId,
    x: 0, y: 0, z: 0,
    rotationX: 0, rotationY: 0, rotationZ: 0,
    crop: {},
  });
  if (myLoadToken !== shopProductPreviewLoadToken) {
    // A newer call owns the preview now -- same superseded-load leak guard
    // showAxisPreview uses: this object was never added to any scene the
    // dispose function above knows about.
    if (previewObject) disposeObject(previewObject);
    // Exposed purely so an e2e test can confirm the dispose above actually
    // ran, same reasoning as window.__supersededUploadPreviewDisposals (#1465).
    window.__supersededShopProductPreviewDisposals = (window.__supersededShopProductPreviewDisposals ?? 0) + 1;
    return;
  }
  if (!previewObject) return;
  scene.add(previewObject);

  const box = new THREE.Box3().setFromObject(previewObject);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const radius = Math.max(sphere.radius, 0.05);

  const rect = shopProductPreviewCanvas.getBoundingClientRect();
  const camera = new THREE.PerspectiveCamera(45, rect.width / Math.max(rect.height, 1), 0.01, 100);
  camera.up.set(0, 0, 1);
  const dist = radius * 2.6;
  camera.position.set(dist * 0.75, -dist * 0.95, dist * 0.65);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({ canvas: shopProductPreviewCanvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(rect.width, rect.height, false);

  const controls = new OrbitControls(camera, shopProductPreviewCanvas);
  controls.target.set(0, 0, 0);
  controls.enableDamping = false;
  controls.enablePan = false;
  controls.minDistance = dist * 0.35;
  controls.maxDistance = dist * 3;
  const render = () => renderer.render(scene, camera);
  controls.addEventListener('change', render);

  render();
  shopProductPreview = { renderer, scene, camera, controls, previewObject };
}

export function openShopProductPreviewModal(review) {
  shopProductPreviewModalEl.classList.add('visible');
  shopProductPreviewInfoEl.textContent = productInfoText(review.mesh.userData.template);
  openModalA11y(shopProductPreviewModalEl, closeShopProductPreviewModal);
  showShopProductPreview(review.mesh.userData.template);
}

export function closeShopProductPreviewModal() {
  shopProductPreviewModalEl.classList.remove('visible');
  // #1876: bump the token even though there's nothing to dispose yet if a
  // showShopProductPreview() call is still in flight -- without this, that
  // call's own stale-load check (myLoadToken !== shopProductPreviewLoadToken)
  // never fires, so it finishes building a full scene/renderer/controls
  // after the modal is already closed and assigns it as the live
  // shopProductPreview, leaking a WebGL context until the next preview open.
  shopProductPreviewLoadToken++;
  disposeShopProductPreview();
  closeModalA11y(shopProductPreviewModalEl);
}

// A lightweight, dependency-free particle burst -- small flat tumbling
// squares with an outward+upward launch velocity and simple downward
// gravity, faded out and disposed once their short lifespan ends. Not
// literally "a confetti cannon" (the spec's own phrase is one illustrative
// example of "creative-tool support," not a specific effect to replicate
// pixel-for-pixel) -- this is the same idea in the simplest form this
// app's existing rendering toolkit (plain THREE.Mesh, no particle-system
// library) can produce cheaply.
const CONFETTI_COLORS = [0xff6b6b, 0xffd93d, 0x6bcb77, 0x4d96ff, 0xff922b, 0xda77f2];
const CONFETTI_PARTICLE_COUNT = 24;
const CONFETTI_GRAVITY_M_S2 = 4;
const CONFETTI_LIFESPAN_S = 2.5;
export const confettiBursts = [];

export function spawnConfettiBurst(localPosition, group) {
  const particles = [];
  for (let i = 0; i < CONFETTI_PARTICLE_COUNT; i++) {
    const color = CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];
    const geometry = new THREE.PlaneGeometry(0.12, 0.12);
    const material = new THREE.MeshBasicMaterial({ color, transparent: true, side: THREE.DoubleSide, depthWrite: false });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(localPosition);
    mesh.position.z += 0.3; // launches from just above the calendar's own footprint, not its exact center
    group.add(mesh);
    const angle = Math.random() * Math.PI * 2;
    const speed = 1.5 + Math.random() * 2;
    particles.push({
      mesh,
      velocity: new THREE.Vector3(Math.cos(angle) * speed, Math.sin(angle) * speed, 3 + Math.random() * 2),
      spin: new THREE.Vector3((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8),
    });
  }
  confettiBursts.push({ particles, group, elapsed: 0 });
}

export function disposeConfettiBurst(burst) {
  for (const particle of burst.particles) {
    burst.group.remove(particle.mesh);
    particle.mesh.geometry.dispose();
    particle.mesh.material.dispose();
  }
}

export function updateConfettiBursts(dt) {
  for (const burst of [...confettiBursts]) {
    burst.elapsed += dt;
    const fade = 1 - THREE.MathUtils.clamp(burst.elapsed / CONFETTI_LIFESPAN_S, 0, 1);
    for (const particle of burst.particles) {
      particle.velocity.z -= CONFETTI_GRAVITY_M_S2 * dt;
      particle.mesh.position.addScaledVector(particle.velocity, dt);
      particle.mesh.rotation.x += particle.spin.x * dt;
      particle.mesh.rotation.y += particle.spin.y * dt;
      particle.mesh.rotation.z += particle.spin.z * dt;
      particle.mesh.material.opacity = fade;
    }
    if (burst.elapsed >= CONFETTI_LIFESPAN_S) {
      disposeConfettiBurst(burst);
      confettiBursts.splice(confettiBursts.indexOf(burst), 1);
    }
  }
}

export async function handleShopProductReviewClick() {
  const review = shopTappedProduct;
  if (!review) return;
  // #1113: the server now derives authorship from a real logged-in builder
  // and verifies an actual purchase, not a caller-supplied name matched
  // against a free-text label (#893's spoofing gap) -- same "builder-
  // authored, needs a real identity" shape the calendar hint listener
  // already uses, replacing this handler's own former shopperLabel() name
  // prompt.
  const builder = await ensureBuilderIdentity();
  if (!builder) return;
  // #1975 (owner decision): a shopper who already reviewed this product
  // edits or removes that one review instead of being offered an unrelated
  // second slot -- mirrors the sign-post hint's own myPost pattern (#1830)
  // exactly, using review.userId (reviewFromRow, populated server-side from
  // the posting session) rather than a free-text author match.
  const myReview = currentAuthUser && review.reviews.find((r) => r.userId === currentAuthUser.userId);
  if (myReview) {
    const stars = '★'.repeat(myReview.rating) + '☆'.repeat(5 - myReview.rating);
    const choice = (prompt(
      `Your review: ${stars}${myReview.text ? ` "${myReview.text}"` : ''}\n\nType "edit" to change it, or "delete" to remove it. Leave blank to cancel.`,
      '',
    ) || '').trim().toLowerCase();
    if (choice === 'delete') {
      shopProductPreviewReviewBtn.disabled = true;
      try {
        await deleteProductReview(review.templateId, myReview.reviewId);
        if (!shopReviews.includes(review)) return;
        review.reviews = review.reviews.filter((r) => r.reviewId !== myReview.reviewId);
        rebuildReviewSprites(review);
      } catch (err) {
        alert(err.message || 'Could not delete this review.');
      } finally {
        shopProductPreviewReviewBtn.disabled = false;
      }
    } else if (choice === 'edit') {
      const ratingInput = prompt('Rate this product 1-5 stars:', String(myReview.rating));
      if (!ratingInput || !ratingInput.trim()) return;
      const rating = Number(ratingInput.trim());
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        alert('Please enter a whole number from 1 to 5.');
        return;
      }
      const text = prompt('Add a comment (up to 280 characters), or leave blank:', myReview.text || '');
      // #2005's own fix only covered the create path right below this one
      // -- same missing guard, same data-loss consequence on edit.
      if (text && text.trim().length > 280) {
        alert('Keep it to 280 characters or fewer.');
        return;
      }
      shopProductPreviewReviewBtn.disabled = true;
      try {
        // Cancelling (null) omits `text` entirely so the server keeps the
        // existing value -- an explicit empty string (OK clicked with the
        // field cleared) is sent as-is, clearing it, same distinction
        // editProductReview's own `text !== undefined` check preserves.
        const updated = await editProductReview(review.templateId, myReview.reviewId, {
          rating, text: text === null ? undefined : text.trim(),
        });
        if (!shopReviews.includes(review)) return;
        const index = review.reviews.findIndex((r) => r.reviewId === myReview.reviewId);
        if (index !== -1) review.reviews[index] = updated;
        rebuildReviewSprites(review);
      } catch (err) {
        alert(err.message || 'Could not update this review.');
      } finally {
        shopProductPreviewReviewBtn.disabled = false;
      }
    }
    return;
  }
  const ratingInput = prompt('Rate this product 1-5 stars:', '5');
  if (!ratingInput || !ratingInput.trim()) return;
  const rating = Number(ratingInput.trim());
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    alert('Please enter a whole number from 1 to 5.');
    return;
  }
  // A star rating alone is already a complete, useful review -- this text
  // prompt is an optional extra, same as the calendar hint's own scheduling
  // step.
  const text = prompt('Add a comment (up to 280 characters), or leave blank:', '');
  // #2005: same missing client-side check #1920 already added to the
  // sign-post/calendar-event prompts -- prompt() gives no live character
  // count, and an over-length submission loses the whole typed comment on
  // the server's own 280-char rejection.
  if (text && text.trim().length > 280) {
    alert('Keep it to 280 characters or fewer.');
    return;
  }
  shopProductPreviewReviewBtn.disabled = true;
  try {
    const posted = await createProductReview(review.templateId, { rating, text: text?.trim() || undefined });
    // Same unloaded-landlet guard as the sign-post and calendar handlers
    // (#426) -- registerShopReview's own fetch already checks this.
    if (!shopReviews.includes(review)) return;
    review.reviews.push(posted);
    rebuildReviewSprites(review);
  } catch (err) {
    alert(err.message || 'Could not review this product.');
  } finally {
    shopProductPreviewReviewBtn.disabled = false;
  }
}

let checkoutCardElement = null;
let rejectCheckoutFlow = null;

// #1730: this used to only hide the modal -- registered as the modal's own
// Escape handler via openModalA11y below, but runCheckoutFlow's own promise
// contract (see its comment just below) says this modal can only be left by
// resolving or rejecting that promise. Escape skipped that step entirely,
// leaving the promise permanently unsettled (and the caller's own `finally`
// never running) if the shopper dismissed with Escape instead of the
// Cancel button. Now shares the same reject call checkoutCancelBtn's own
// handler uses, so Escape and Cancel behave identically -- same fix shape
// #1679 already applied to the Friends-map/DM modal's own Escape gap.
function closeCheckoutModal() {
  checkoutModalEl.classList.remove('visible');
  closeModalA11y(checkoutModalEl);
  if (checkoutCardElement) {
    checkoutCardElement.unmount();
    checkoutCardElement = null;
  }
  if (rejectCheckoutFlow) {
    const reject = rejectCheckoutFlow;
    rejectCheckoutFlow = null;
    reject(new Error('Checkout cancelled.'));
  }
}

// Collects real payment for a connected seller's product, once
// purchaseInstance's response comes back as `requiresPayment` instead of
// an already-completed `purchase` (#453). The returned promise resolves
// with `{ purchase, deliveryConfirmUrl }` (see finalizePurchase in
// src/api.js -- the latter is only set for a physical real-money purchase,
// #454) once the purchase has genuinely been finalized (Stripe confirmed
// the charge AND the server has recorded it), or rejects if the buyer
// cancels -- it deliberately does NOT resolve just because the modal was
// shown, so a caller's own `finally` (e.g. re-enabling the button that
// opened this) covers the whole checkout, not just the initial setup.
function runCheckoutFlow({ clientSecret, paymentIntentId, publishableKey }, { name, totalCents }) {
  return new Promise((resolve, reject) => {
    checkoutSummaryEl.textContent = `${name} — ${formatPriceCents(totalCents)}`;
    checkoutStatusEl.textContent = 'Loading payment form…';
    checkoutStatusEl.classList.remove('error');
    checkoutPayBtn.disabled = true;
    checkoutCancelBtn.disabled = false;
    checkoutModalEl.classList.add('visible');
    // #1730: closeCheckoutModal itself now rejects (see its own comment)
    // once rejectCheckoutFlow is armed here, so Escape (wired to it via
    // openModalA11y) and the explicit Cancel button settle this promise
    // identically.
    rejectCheckoutFlow = reject;
    openModalA11y(checkoutModalEl, closeCheckoutModal);

    checkoutCancelBtn.onclick = closeCheckoutModal;

    loadStripeJs().then((Stripe) => {
      const stripe = Stripe(publishableKey);
      const elements = stripe.elements();
      checkoutCardElement = elements.create('card');
      checkoutCardElement.mount(checkoutCardElementEl);
      checkoutStatusEl.textContent = '';
      checkoutPayBtn.disabled = false;

      checkoutPayBtn.onclick = async () => {
        checkoutPayBtn.disabled = true;
        // #841: the card is genuinely charged once confirmCardPayment
        // resolves, so Cancel can't stay clickable during this await --
        // otherwise a cancel-click here settles this promise as rejected
        // while the charge (and the finalize call below) still goes
        // through for real, silently reporting a completed purchase as
        // cancelled.
        checkoutCancelBtn.disabled = true;
        checkoutStatusEl.textContent = 'Processing…';
        checkoutStatusEl.classList.remove('error');
        try {
          const result = await stripe.confirmCardPayment(clientSecret, { payment_method: { card: checkoutCardElement } });
          if (result.error) throw new Error(result.error.message || 'Payment failed.');
          const finalized = await finalizePurchase(paymentIntentId);
          // Disarm before closing -- closeCheckoutModal's own reject must
          // not fire after a genuinely completed purchase (a settled
          // promise's second settle attempt is a silent no-op, but relying
          // on that would be fragile and misleading to read).
          rejectCheckoutFlow = null;
          closeCheckoutModal();
          resolve(finalized);
        } catch (err) {
          checkoutStatusEl.textContent = err.message || 'Payment failed.';
          checkoutStatusEl.classList.add('error');
          checkoutPayBtn.disabled = false;
          checkoutCancelBtn.disabled = false;
        }
      };
    }).catch((err) => {
      checkoutStatusEl.textContent = err.message || 'Could not load Stripe.';
      checkoutStatusEl.classList.add('error');
    });
  });
}

// #659: read-only, no submit/confirm action -- just the close button, same
// as every other dismissible modal in this file (see #checkout-modal's own
// comment on why there's no backdrop-click-to-close convention here).
export function closeRefundPolicyModal() {
  refundPolicyModalEl.classList.remove('visible');
  closeModalA11y(refundPolicyModalEl);
  // #2515: same gap as closeUploadModal's own #2515 fix -- this modal only
  // ever opens stacked on top of the still-visible Shop Product Preview
  // modal, so re-arm its trap rather than leaving it on screen untrapped.
  shopProductPreviewModalEl.classList.add('visible');
  openModalA11y(shopProductPreviewModalEl, closeShopProductPreviewModal);
}
export function handleShopReturnPolicyClick() {
  refundPolicyModalEl.classList.add('visible');
  openModalA11y(refundPolicyModalEl, closeRefundPolicyModal);
}

// #1096: distinct from handleShopProductReviewClick's product review above
// -- this rates the seller's own service (listing accuracy, timeliness,
// communication) for one specific purchase, not the product itself, so it
// only ever fires right after that purchase rather than from a standalone
// in-world tap. Same lightweight prompt()-based rating+comment flow as the
// review handler, for the same reason that handler uses it -- a star
// rating is already a complete, useful piece of feedback, and the comment
// is an optional extra.
async function promptSellerFeedback(purchase) {
  if (!purchase?.sellerId || !purchase.buyerLabel) return;
  if (!confirm('Leave feedback for the seller? (listing accuracy, timeliness, communication)')) return;
  const ratingInput = prompt('Rate this seller 1-5 stars:', '5');
  if (!ratingInput || !ratingInput.trim()) return;
  const rating = Number(ratingInput.trim());
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    alert('Please enter a whole number from 1 to 5.');
    return;
  }
  const text = prompt('Add a comment (up to 280 characters), or leave blank:', '');
  // #2005: same missing client-side check as the product review prompt
  // above -- see its own comment for why this matters.
  if (text && text.trim().length > 280) {
    alert('Keep it to 280 characters or fewer.');
    return;
  }
  try {
    await createSellerFeedback(purchase.purchaseId, { rating, text: text?.trim() || undefined });
  } catch (err) {
    alert(err.message || 'Could not leave feedback for this seller.');
  }
}

export async function handleShopProductBuyClick() {
  const review = shopTappedProduct;
  if (!review) return;
  const { name, priceCents, isTestModel } = review.mesh.userData.template;
  if (priceCents == null) return;
  // #1946 (owner correction): defense in depth alongside the canBuy gate
  // in updateReviewFade that already hides this button entirely for a test
  // model -- same belt-and-suspenders relationship priceCents == null
  // already has with its own .visible toggle.
  if (isTestModel) return;
  // #659: a one-line mention right at the moment of buying, alongside the
  // full Return Policy button this same tapped product already surfaces
  // (#shop-product-preview-return-policy-btn) -- this dialog is a native
  // confirm(), so it can't carry an actual link, just the fact worth
  // knowing before saying yes.
  const confirmed = confirm(`Buy "${name}" for ${formatPriceCents(priceCents)}? (Refunds return 99% — see Return Policy.)`);
  if (!confirmed) return;
  shopProductPreviewBuyBtn.disabled = true;
  const instanceId = review.mesh.userData.instanceId;
  try {
    const result = await purchaseInstance(instanceId);
    let purchase;
    if (result.requiresPayment) {
      const finalized = await runCheckoutFlow(result, { name, totalCents: priceCents });
      purchase = finalized.purchase;
      // #473: only clear the persisted idempotency key (see purchaseInstance
      // in src/api.js) once the purchase has genuinely finalized -- a
      // network failure anywhere before this point should leave it in
      // place so a retried "Buy" click reuses the same key instead of
      // risking a second real PaymentIntent for the same attempt.
      clearPurchaseIdempotencyKey(instanceId);
      // #454: the ONLY time this link is ever shown -- the server never
      // stores the raw token, only its hash, so there is no "my orders"
      // page to come back and find it later. Present for a physical
      // (non-digital-good) purchase only; a digital good pays the seller
      // out instantly with nothing to confirm.
      alert(finalized.deliveryConfirmUrl
        ? `Purchase complete — thank you! Once you receive it, confirm delivery here so the seller gets paid:\n${finalized.deliveryConfirmUrl}`
        : 'Purchase complete — thank you!');
    } else {
      purchase = result.purchase;
      clearPurchaseIdempotencyKey(instanceId);
      alert('Purchase simulated — the seller has been credited.');
    }
    // #1096: right after the purchase, while the shopper's own buyer_label
    // (locked into the purchase row at checkout -- see #761's own comment
    // on why the in-world buy flow never sends an explicit one) is already
    // known, is the only moment this dev-mode identity system can offer a
    // "leave feedback" prompt at all -- there's no "my orders" page to
    // come back to later (#454's own comment above). sellerId/buyerLabel
    // are both required server-side (handleSellerFeedbackCreate), so a
    // seller-less product or a null buyer_label (shouldn't happen via this
    // flow, but defends the same way the review gate does) just skips the
    // prompt rather than offering feedback that would only 400.
    await promptSellerFeedback(purchase);
  } catch (err) {
    if (err.message !== 'Checkout cancelled.') alert(err.message || 'Could not complete this purchase.');
  } finally {
    shopProductPreviewBuyBtn.disabled = false;
  }
}
