// #2628 (leaf of #2563, itself part of #2504/#2500's src/main.js module
// split -- see #2503's design comment and #2563's own breakdown comment
// for the full dependency map): Shop mode's Stripe checkout flow,
// post-purchase confetti, and the buy/review-button and refund-policy click
// handlers. (The tap-to-inspect product-preview modal that used to be first
// in this list is gone: #3651 replaced it with the product card in
// src/shop/productCard.js, which blooms beside the product. Buy still ends
// here, in handleShopProductBuyClick, unchanged.)
//
// Depends on shop/worldSprites.js (#2627, already landed) -- reads
// shopTappedProduct (the tap-to-inspect listener's own state, still owned
// by main.js's click listener and worldSprites.js's updateReviewFade) and
// shopReviews, calls rebuildReviewSprites back.
//
// Deliberately NOT included here, even though main.js's own tap-to-inspect
// click listener (which sets shopTappedProduct and opens the product card)
// lives right alongside this module's own code -- that listener itself
// stays in main.js.
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
import { openModalA11y, closeModalA11y } from '../ui/modal.js';
import { openProductReviewModal } from '../ui/productReviewModal.js';
import { confirmDestructive } from '../ui/confirmModal.js';
import { showNotice } from '../ui/noticeModal.js';
import {
  createProductReview,
  purchaseInstance, getPurchaseQuote, clearPurchaseIdempotencyKey, finalizePurchase,
} from '../api.js';
import { ensureBuilderIdentity } from '../account/identity.js';
import { requireLogin, requireVerification, currentAuthUser, setCurrentAuthUser } from '../account/auth.js';
import { buyTimeAccountRefusal } from './buyAccountRefusal.js';
import { loadStripeJs, formatPriceCents } from '../main.js';
import { createCheckoutPayState, runPayAttempt, describePayFailure, canLeaveAfterCharge, CHARGED_CLOSED_MESSAGE, PAY_STAGES } from './checkoutPayAttempt.js';
import { promptShippingAddress } from './shippingAddressModal.js';
import { shopTappedProduct, shopReviews, rebuildReviewSprites, invalidateProductReviews } from './worldSprites.js';
// #3651: the card's own buttons (Buy, Rate this product), for focus return after a notice.
import { productCardBuyButton, productCardReviewButton, refreshOwnedAfterPurchase, refreshRatedOrders, markProductJustBought } from './productCard.js';

const refundPolicyModalEl = document.getElementById('refund-policy-modal');
const checkoutModalEl = document.getElementById('checkout-modal');
const checkoutSummaryEl = document.getElementById('checkout-summary');
const checkoutCardElementEl = document.getElementById('checkout-card-element');
const checkoutStatusEl = document.getElementById('checkout-status');
const checkoutProgressEl = document.getElementById('checkout-progress');
const checkoutPayBtn = document.getElementById('checkout-pay-btn');
const checkoutCancelBtn = document.getElementById('checkout-cancel-btn');

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
  // #3775 (owner, 2026-11-18): a rating belongs to one order. The card offers this only when
  // the shopper has an order of the product that is not rated yet, so what it opens is always
  // a new rating for the oldest such order (the server picks it); changing or removing a
  // rating you gave is done on that order in My purchases (#1975's edit/delete moved there).
  // #3249: one in-app modal, not native prompt()/alert(); failures are thrown out of the
  // callback and shown inside the modal.
  productCardReviewButton().disabled = true;
  try {
    await openProductReviewModal({
      existing: null,
      returnFocusEl: productCardReviewButton(),
      onSubmit: async ({ rating, text }) => {
        // A star rating alone is already a complete, useful review.
        const posted = await createProductReview(review.templateId, { rating, text: text || undefined });
        invalidateProductReviews(review.templateId);
        refreshRatedOrders();
        // Same unloaded-landlet guard as the sign-post and calendar handlers (#426).
        if (!shopReviews.includes(review)) return;
        review.reviews.push(posted);
        rebuildReviewSprites(review);
      },
    });
  } finally {
    productCardReviewButton().disabled = false;
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
// #3116: set once the card has been charged and cleared only when the
// purchase is recorded. While set, closing the modal (Escape included) is
// ignored -- otherwise a charged buyer could dismiss it and be told
// "Checkout cancelled." for a purchase that was in fact paid for.
let checkoutChargedAwaitingFinalize = false;

function closeCheckoutModal() {
  if (checkoutChargedAwaitingFinalize) return;
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
    // #3116: a previous checkout may have left the retry label/lock behind.
    // #3946: Pay names the amount, since this sheet is now the one place the buyer says yes.
    checkoutPayBtn.dataset.defaultLabel = `Pay ${formatPriceCents(totalCents)}`;
    checkoutPayBtn.textContent = checkoutPayBtn.dataset.defaultLabel;
    checkoutChargedAwaitingFinalize = false;
    checkoutCancelBtn.textContent = 'Cancel';
    checkoutProgressEl.hidden = true;
    const payState = createCheckoutPayState();
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
        checkoutStatusEl.classList.remove('error');
        // #3947: the words and the bar follow the real step (see PAY_STAGES), set by runPayAttempt.
        const showStage = (stage) => {
          checkoutStatusEl.textContent = PAY_STAGES[stage].label;
          checkoutProgressEl.style.setProperty('--checkout-progress', String(PAY_STAGES[stage].share));
          checkoutProgressEl.hidden = false;
        };
        try {
          // #3116: after the card is charged, a retry only re-runs finalize
          // (see checkoutPayAttempt.js) -- confirming the card again would
          // fail with Stripe's own wording and leave the buyer believing a
          // paid purchase had failed.
          const finalized = await runPayAttempt(payState, {
            onStage: showStage,
            confirm: () => stripe.confirmCardPayment(clientSecret, { payment_method: { card: checkoutCardElement } }),
            finalize: () => {
              checkoutChargedAwaitingFinalize = true;
              return finalizePurchase(paymentIntentId);
            },
          });
          // Disarm before closing -- closeCheckoutModal's own reject must
          // not fire after a genuinely completed purchase (a settled
          // promise's second settle attempt is a silent no-op, but relying
          // on that would be fragile and misleading to read).
          rejectCheckoutFlow = null;
          checkoutChargedAwaitingFinalize = false;
          closeCheckoutModal();
          resolve(finalized);
        } catch (err) {
          checkoutProgressEl.hidden = true;
          checkoutStatusEl.textContent = describePayFailure(payState, err);
          checkoutStatusEl.classList.add('error');
          checkoutPayBtn.disabled = false;
          if (payState.paymentConfirmed) {
            // Charged: only finishing the purchase is on offer. Cancel stays
            // disabled (as #841 did during confirmation) and the button
            // says what it now does.
            checkoutPayBtn.textContent = 'Finish purchase';
            if (canLeaveAfterCharge(payState)) {
              // #4457: after a few failed tries the buyer can leave; the order is recorded when the
              // provider confirms the charge, and the notice says so.
              checkoutCancelBtn.textContent = 'Close';
              checkoutCancelBtn.disabled = false;
              checkoutCancelBtn.onclick = () => {
                checkoutChargedAwaitingFinalize = false;
                const leave = rejectCheckoutFlow;
                rejectCheckoutFlow = null; // so closing does not settle the flow as "cancelled" first
                closeCheckoutModal();
                if (leave) leave(Object.assign(new Error(CHARGED_CLOSED_MESSAGE), { chargedClosed: true }));
              };
            } else {
              checkoutCancelBtn.disabled = true;
            }
          } else {
            checkoutCancelBtn.disabled = false;
          }
        }
      };
    }).catch((err) => {
      // #4458: the card form could not be built, before any payment was taken (Stripe.js did not load, or the key is missing).
      // A fixed sentence, never the library's own text.
      checkoutStatusEl.textContent = "Card payments can't load right now. You were not charged. Try again in a moment.";
      checkoutStatusEl.classList.add('error');
    });
  });
}

// #3116: e2e-only hook (same window.__test* convention as the other hooks in
// this file) -- runs the real checkout modal directly, so a test can drive
// the charged-but-not-finalized path with a stubbed Stripe and finalize
// response instead of needing real Stripe keys and a Shop-mode tap. Inert
// unless a test calls it.
window.__testRunCheckoutFlow = (intent, summary) => runCheckoutFlow(intent, summary);

// #659: read-only, no submit/confirm action -- just the close button, same
// as every other dismissible modal in this file (see #checkout-modal's own
// comment on why there's no backdrop-click-to-close convention here).
export function closeRefundPolicyModal() {
  refundPolicyModalEl.classList.remove('visible');
  closeModalA11y(refundPolicyModalEl);
  // (#2515 used to re-arm the product-preview modal's focus trap here; the
  // product card that replaced it (#3651) is not a modal, so there is no trap
  // to re-arm and focus returns to the petal that opened this.)
}
export function handleShopReturnPolicyClick() {
  refundPolicyModalEl.classList.add('visible');
  openModalA11y(refundPolicyModalEl, closeRefundPolicyModal);
}

// #3945: confetti at the product it was bought from, and the card says so. Never blocks, never
// throws into the purchase: the order is already recorded by the time this runs.
function showPurchaseCelebration(review) {
  try {
    const mesh = review?.mesh;
    if (mesh?.parent) spawnConfettiBurst(mesh.position, mesh.parent);
  } catch { /* the celebration is decoration */ }
  markProductJustBought(review);
}

// #4456: the price moved after the shopper saw it. The card's own copy of the price follows the server's, and the
// shopper is told, in terms of money, that nothing was charged and what to do next.
async function showPriceChanged(review, unitPriceCents) {
  const known = Number.isInteger(unitPriceCents);
  if (known) review.mesh.userData.template.priceCents = unitPriceCents;
  await showNotice({
    title: 'The price changed',
    message: known
      ? `The price is now ${formatPriceCents(unitPriceCents)}. You were not charged. Review it and buy again if you still want it.`
      : 'The price changed. You were not charged. Review the new price and buy again.',
    returnFocusEl: productCardBuyButton(),
  });
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
  productCardBuyButton().disabled = true;
  const instanceId = review.mesh.userData.instanceId;
  let paymentStarted = false;
  try {
    // #3946: ask first what this purchase will do, without doing it. A purchase that takes a card
    // opens the one payment sheet (price, refund line, card field, Pay), so Pay is the one yes;
    // anything else keeps the one-tap confirm below. A refusal surfaces here, before any sheet.
    const quote = await getPurchaseQuote(instanceId);
    // #4456: the sheet and the Pay button show the price the shopper saw, and the server charges the live one. If
    // the seller changed it since this card was loaded, say so before anything is shown to pay.
    if (Number.isInteger(quote.unitPriceCents) && quote.unitPriceCents !== priceCents) {
      await showPriceChanged(review, quote.unitPriceCents);
      return;
    }
    // #4599: a shipped product asks where it goes before anything starts, for every way of paying; the server checks the
    // address again, and the order keeps its own copy. A digital good never asks.
    let shippingAddress;
    if (quote.requiresShippingAddress) {
      productCardBuyButton().disabled = false;
      shippingAddress = await promptShippingAddress({ domesticOnly: !!quote.domesticOnly });
      if (!shippingAddress) return;
      productCardBuyButton().disabled = true;
    }
    if (!quote.paysWithCard) {
      // #659: a one-line mention right at the moment of buying, alongside the
      // full Return policy button this same tapped product already surfaces
      // (#product-card-return-policy-btn) -- a plain sentence, the fact
      // worth knowing before saying yes.
      // #3278: its own in-app modal, not window.confirm(): a browser that
      // suppresses native dialogs answers false at once, so Buy did nothing and
      // said nothing (the same failure Sell > Manage Delete had, #3249).
      // The card's Buy button is live again while the confirm is open, so focus can return to it.
      productCardBuyButton().disabled = false;
      const confirmed = await confirmDestructive({
        title: 'Buy this item?',
        message: `Buy "${name}" for ${formatPriceCents(priceCents)}? (Refunds return 99% — see Return policy.)`,
        confirmLabel: 'Buy',
        variant: 'primary',
        returnFocusEl: productCardBuyButton(),
      });
      if (!confirmed) return;
      productCardBuyButton().disabled = true;
    }
    const result = await purchaseInstance(instanceId, { expectedUnitPriceCents: priceCents, shippingAddress });
    if (result.requiresPayment) {
      paymentStarted = true; // from here a card can be charged, so "you were not charged" is no longer ours to say (#4461)
      const finalized = await runCheckoutFlow(result, { name, totalCents: priceCents });
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
      // #3249: a notice the buyer can select and copy from, not alert() --
      // a suppressed alert would also have lost the link for good.
      // #3945: the confirmation is in the world (confetti at the product, "Yours now." on its
      // card). A sheet stays only where something would be lost without it: the delivery link is
      // shown once and the buyer must be able to select it (#3249).
      showPurchaseCelebration(review);
      if (finalized.deliveryConfirmUrl) {
        await showNotice({
          title: 'Purchase complete',
          message: 'Once you receive it, confirm delivery with this link so the seller gets paid. It is shown only once, so copy it now.',
          copyText: finalized.deliveryConfirmUrl,
          returnFocusEl: productCardBuyButton(),
        });
      }
    } else {
      clearPurchaseIdempotencyKey(instanceId);
      // #3255: real payments are live, so this branch (free / zero-price items
      // and any path that returns the purchase directly) reads the same as the
      // paid branch above rather than the dev-era "simulated" wording.
      showPurchaseCelebration(review);
    }
    // #3681: what was just bought may now be owned (an avatar, an animation).
    refreshOwnedAfterPurchase();
    // #3256 (owner report): no immediate "Leave feedback for the seller?"
    // prompt here. Right after buying is too early to judge accuracy,
    // timeliness or communication (the buyer had not even equipped the
    // item); My purchases offers "Rate this seller" per purchase for when
    // they actually know how it went (#3198).
  } catch (err) {
    if (err.code === 'price_changed') {
      // The race the quote could not catch: the seller changed it between the quote and Buy. Nothing was charged.
      await showPriceChanged(review, err.body?.unitPriceCents);
    } else if (err.message !== 'Checkout cancelled.') {
      // #4461: a refusal at Buy time that is about the person's own account says so, says nothing was charged
      // (a 401 or a verification refusal comes from the quote or the purchase request, before any card is
      // touched), and then offers the step that fixes it, instead of the server's bare "Not authenticated".
      const accountRefusal = paymentStarted ? null : buyTimeAccountRefusal(err, { requireLogin, requireVerification, currentAuthUser: () => currentAuthUser, setCurrentAuthUser });
      await showNotice({
        title: err.chargedClosed ? 'Your payment went through' : "Purchase didn't go through",
        message: accountRefusal?.message || err.message || 'Couldn\'t complete this purchase.',
        returnFocusEl: productCardBuyButton(),
      });
      if (accountRefusal) await accountRefusal.fix().catch(() => {});
    }
  } finally {
    productCardBuyButton().disabled = false;
  }
}
