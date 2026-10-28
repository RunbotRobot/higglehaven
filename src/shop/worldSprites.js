// #2627 (leaf of #2563, itself part of #2504/#2500's src/main.js module
// split -- see #2503's design comment and #2563's own breakdown comment
// for the full dependency map): Shop mode's proximity-faded sign-post/
// calendar-event/product-review sprite rendering -- the community sign and
// calendar text-sprite stacks, product reviews, the shared per-frame fade
// loops for all three, and the tap-to-inspect preview's own info-text
// builder and raycast-resolution helper.
//
// Depends on shop/presenceAndContent.js (#2626, already landed) --
// registerShopSign/registerShopCalendar/registerShopReview here are called
// FROM that module's loadShopLandletInstances as each sign/calendar/review
// instance loads in; that module's own import now points here instead of
// main.js. Also depends on shop/avatar.js (#2623)/shop/flightMovement.js
// (#2624) only indirectly, via the shared camera this module reads for
// distance-based fade -- no direct import from either.
//
// Deliberately NOT included here, even though it was declared and called
// right alongside this module's own functions in main.js before -- a
// genuinely different concern: the product-preview modal, checkout/Stripe
// flow, confetti, and the buy/review-button click handlers now live in
// src/shop/productCheckout.js (#2628). The single tap-to-inspect click
// listener that sets shopTappedProduct and opens/closes the preview modal
// stays in main.js, which calls findTappedShopProduct forward from here --
// this module doesn't own that listener. spawnConfettiBurst (productCheckout.js's
// own territory) is called forward from checkScheduledCalendarEvents below
// the same way, now imported from there instead of main.js.
//
// shopTappedProduct/shopReviewHintsVisible/shopReviewHintsProduct/
// shopHighlightedProduct move here (updateReviewFade's own primary state --
// it's the only function that recomputes them every frame), along with
// nearestActiveSign/nearestActiveCalendar (updateSignFade's/
// updateCalendarFade's own equivalent). main.js's tap-to-inspect click
// listener and unloadShopLandletInstances (the claimed-landlet counterpart
// to presenceAndContent.js's own loadShopLandletInstances, staying in
// main.js for the same forward-import reason that module's own header
// comment gives) both need to reset one or more of these on a tap/unload --
// an ES import binding is read-only from the importing side, so main.js
// gets setShopTappedProduct/setShopReviewHintsVisible/
// setShopReviewHintsProduct/setShopHighlightedProduct/setNearestActiveSign/
// setNearestActiveCalendar setters rather than reassigning directly, same
// shape shop/avatar.js's own setShopAvatar/shop/presenceAndContent.js's own
// setShopBuilderLabel(s) already established. shopSigns/shopCalendars/
// shopReviews move here too, but need no setters -- main.js only ever
// mutates them in place (.push()/.splice()), never reassigns the array
// itself.
//
// shopEquippedAvatarSkeletonSignature stays in main.js (set elsewhere,
// during avatar equip/swap, not sprite-rendering's own concern) -- exported
// there, read here by productInfoText, never reassigned by this module.
// Same for formatPriceCents/DIGITAL_GOOD_DISCLAIMER_TEXT (already exported).
// animationCompatibility/animationCompatibilityLabel moved to ./mode.js
// (#2565) -- imported from there instead now; a circular import with that
// module (which itself imports several things back from this one), same
// shape every other extracted leaf here already uses.
import * as THREE from 'three';
import { camera } from '../world/scene.js';
import { meshDimensions } from '../world/models.js';
import { addSelectionOutline, removeSelectionOutline } from '../build/scene.js';
import {
  fetchSignPosts, fetchCalendarEvents, triggerCalendarEvent, fetchProductReviews,
} from '../api.js';
import {
  shopEquippedAvatarSkeletonSignature, formatPriceCents, DIGITAL_GOOD_DISCLAIMER_TEXT,
} from '../main.js';
import { animationCompatibility, animationCompatibilityLabel } from './mode.js';
// #2628: spawnConfettiBurst now lives in src/shop/productCheckout.js.
import { spawnConfettiBurst } from './productCheckout.js';

const shopSignHintEl = document.getElementById('shop-sign-hint');
const shopCalendarHintEl = document.getElementById('shop-calendar-hint');
const shopProductPreviewReviewBtn = document.getElementById('shop-product-preview-review-btn');
const shopProductPreviewBuyBtn = document.getElementById('shop-product-preview-buy-btn');
const shopProductPreviewReturnPolicyBtn = document.getElementById('shop-product-preview-return-policy-btn');

// Community signs (docs/SPEC.md §6, docs/API.md's "Community signs") --
// shopper-authored posts fade in as the camera approaches a sign and back
// out past it, rather than a hard show/hide cutoff, the same
// proximity-as-opacity idea the spec's own in-world social feed calls for
// generally ("size/opacity as a function of distance"). SIGN_INTERACT_RADIUS_M
// is deliberately much tighter than the fade radius — close enough to
// plausibly be able to read the sign at all before "Leave a Note" appears.
const SIGN_FADE_NEAR_M = 4; // fully opaque at/within this distance
const SIGN_FADE_FAR_M = 20; // fully transparent at/beyond this distance
const SIGN_INTERACT_RADIUS_M = 8;
const SIGN_MAX_VISIBLE_POSTS = 5;
// Community calendar (docs/SPEC.md §6, docs/API.md's "Community
// calendar") reuses the SIGN_FADE_NEAR_M/SIGN_FADE_FAR_M/
// SIGN_INTERACT_RADIUS_M/SIGN_MAX_VISIBLE_POSTS constants above directly
// rather than declaring near-duplicate CALENDAR_* ones — they're generic
// "how far can you read floating in-world text" thresholds, not anything
// specific to signs, so there's nothing calendar-specific to tune
// separately (unlike the backend's own deliberately-separate table/flag).

// Every currently-loaded community-sign instance: { mesh, group, instanceId,
// posts, sprites }. Populated/torn down alongside its landlet's own
// objects (see loadShopLandletInstances/unloadShopLandletInstances) rather
// than kept in its own load radius — a sign is exactly as "loaded" as the
// rest of its landlet.
export const shopSigns = [];
export let nearestActiveSign = null; // whichever sign #shop-sign-hint currently targets, or null
export function setNearestActiveSign(value) {
  nearestActiveSign = value;
}
// Same shape/lifecycle as shopSigns above, for community-calendar instances.
export const shopCalendars = [];
export let nearestActiveCalendar = null;
export function setNearestActiveCalendar(value) {
  nearestActiveCalendar = value;
}
// Same shape/lifecycle as shopSigns above, for every placed instance's
// reviews (no opt-in flag — see registerShopReview) — a
// {mesh, group, templateId, reviews, sprites} entry per loaded one, with
// `reviews` populated once rather than re-fetched.
export const shopReviews = [];
// The product preview modal's own content/visibility is driven by this
// (see main.js's own tap handler) — showing it the instant a shopper
// wanders near anything read as noisy/intrusive, closer to a tooltip stuck
// to the cursor than an intentional "what is this." Requiring a tap makes
// seeing it a deliberate choice.
//
// Owner (Control Room, N42): the buy/review hints used to be purely
// proximity-driven (visible whenever nearest-in-range, no tap needed) —
// "walking near a product should not make the buttons appear... they
// should only appear after the user taps the product." Now shares this
// same tapped-product state instead of its own nearest-by-distance
// tracking, so a shopper has to deliberately tap before either button can
// show. Still range-gated on top of that (see updateReviewFade below) —
// walking away from a tapped product hides its buttons again, the same
// physical-interaction requirement every other in-world hint (signs,
// calendar events) already enforces.
export let shopTappedProduct = null;
export function setShopTappedProduct(value) {
  shopTappedProduct = value;
}
export let shopReviewHintsVisible = false;
export function setShopReviewHintsVisible(value) {
  shopReviewHintsVisible = value;
}
// #994: which product shopReviewHintsVisible/canBuy were last computed for
// -- updateReviewFade's own change-detection used to key purely off
// tappedInRange, so retapping a *different* product without ever leaving
// SIGN_INTERACT_RADIUS_M (two nearby items on the same shelf, say) left
// the Buy/Return-Policy hints showing the previous product's priced state.
export let shopReviewHintsProduct = null;
export function setShopReviewHintsProduct(value) {
  shopReviewHintsProduct = value;
}
// #1810: which product's mesh currently carries addSelectionOutline's
// highlight -- mirrors shopReviewHintsProduct's own "last computed for"
// role, so updateReviewFade can tell a highlight change from a no-op on
// the same product it's already applied to.
export let shopHighlightedProduct = null;
export function setShopHighlightedProduct(value) {
  shopHighlightedProduct = value;
}

// A sign starts with no posts loaded — fetched once, here, right as it
// enters the world (rather than re-fetched on every proximity tick), then
// kept in sync locally by main.js's own promptLeaveNote-equivalent click
// handler's optimistic append. If the fetch loses the race with the
// landlet being unloaded again (camera wandered off before it resolved),
// the `shopSigns.includes` check drops the result on the floor rather than
// resurrecting sprites for a sign that's no longer in the scene.
export function registerShopSign(mesh, entry) {
  const sign = { mesh, group: entry.group, instanceId: mesh.userData.instanceId, posts: [], sprites: [] };
  shopSigns.push(sign);
  fetchSignPosts(sign.instanceId).then(({ posts }) => {
    if (!shopSigns.includes(sign)) return;
    sign.posts = posts;
    rebuildSignSprites(sign);
  }).catch(() => {});
}

export function disposeSignSprites(sign) {
  for (const sprite of sign.sprites) {
    sign.group.remove(sprite);
    sprite.material.map?.dispose();
    sprite.material.dispose();
  }
  sign.sprites = [];
}

// Renders a canvas-texture Sprite per post (THREE Sprites always face the
// camera on their own, so this needs no manual billboarding) stacked
// vertically above the sign's own footprint. Capped at
// SIGN_MAX_VISIBLE_POSTS most-recent posts — an unbounded stack would
// eventually tower well past where the fade radius could ever make it
// readable anyway. Opacity starts at 0 and is driven entirely by
// updateSignFade() every frame, not set here.
export function rebuildSignSprites(sign) {
  disposeSignSprites(sign);
  const baseHeight = meshDimensions(sign.mesh).height;
  const recent = sign.posts.slice(-SIGN_MAX_VISIBLE_POSTS);
  recent.forEach((post, i) => {
    const sprite = makeSignPostSprite(`${post.authorLabel}: ${post.text}`);
    // #1594: sign.mesh.position.z is the mesh's own vertical *center*, per
    // this codebase's ground-rest convention (createMeshForInstance sets
    // position.z = height / 2 by default) — the same convention
    // supportZ/itemZMax elsewhere in this file rely on to find a mesh's top
    // surface (mesh.position.z + height / 2). This used to add the mesh's
    // *full* height instead of half of it, overshooting the actual top
    // surface by another half-height and leaving posts hovering well above
    // the sign instead of just above its surface.
    sprite.position.set(sign.mesh.position.x, sign.mesh.position.y, sign.mesh.position.z + baseHeight / 2 + 0.4 + i * 0.5);
    sprite.material.opacity = 0;
    sign.group.add(sprite);
    sign.sprites.push(sprite);
  });
  // #1594: e2e-only hook (same "expose computed state purely for
  // verification" convention as window.__shopInstanceDisposedCount) --
  // lets a test confirm a post sprite's world-space z actually sits just
  // above the sign mesh's own top surface, without needing visual
  // inspection of the real 3D render.
  window.__lastSignSpriteDebug = { meshZ: sign.mesh.position.z, meshHeight: baseHeight, spriteZs: sign.sprites.map((s) => s.position.z) };
}

// A single line of white-on-dark text baked into a canvas texture — the
// simplest possible in-world text rendering, and enough for a short social
// post. Long posts (up to 280 chars server-side) are truncated for display;
// this is a floating nameplate-style sign, not a page to scroll.
function makeSignPostSprite(text) {
  const display = text.length > 70 ? `${text.slice(0, 69)}…` : text;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const fontSize = 48;
  ctx.font = `${fontSize}px sans-serif`;
  const paddingX = 20;
  canvas.width = Math.ceil(ctx.measureText(display).width) + paddingX * 2;
  canvas.height = Math.round(fontSize * 1.7);
  // Sizing the canvas above resets its 2D context — font has to be set again
  // before the actual draw calls below.
  ctx.font = `${fontSize}px sans-serif`;
  ctx.fillStyle = 'rgba(20, 24, 18, 0.85)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#f5f5f0';
  ctx.textBaseline = 'middle';
  ctx.fillText(display, paddingX, canvas.height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(material);
  const WORLD_UNITS_PER_PX = 0.012; // tuned so a typical post reads clearly from SIGN_INTERACT_RADIUS_M away
  sprite.scale.set(canvas.width * WORLD_UNITS_PER_PX, canvas.height * WORLD_UNITS_PER_PX, 1);
  return sprite;
}

// Community calendar — same lifecycle/rendering as the community-sign
// functions just above (registerShopSign/disposeSignSprites/
// rebuildSignSprites), reusing makeSignPostSprite directly since it's
// generic single-line text-sprite rendering with nothing sign-specific in
// its implementation despite the name.
export function registerShopCalendar(mesh, entry) {
  const calendar = { mesh, group: entry.group, instanceId: mesh.userData.instanceId, events: [], sprites: [] };
  shopCalendars.push(calendar);
  fetchCalendarEvents(calendar.instanceId).then(({ events }) => {
    if (!shopCalendars.includes(calendar)) return;
    calendar.events = events;
    rebuildCalendarSprites(calendar);
  }).catch(() => {});
}

export function disposeCalendarSprites(calendar) {
  for (const sprite of calendar.sprites) {
    calendar.group.remove(sprite);
    sprite.material.map?.dispose();
    sprite.material.dispose();
  }
  calendar.sprites = [];
}

export function rebuildCalendarSprites(calendar) {
  disposeCalendarSprites(calendar);
  const baseHeight = meshDimensions(calendar.mesh).height;
  const recent = calendar.events.slice(-SIGN_MAX_VISIBLE_POSTS);
  recent.forEach((event, i) => {
    const sprite = makeSignPostSprite(`${event.authorLabel}: ${event.text}`);
    // #1642: calendar.mesh.position.z is the mesh's own vertical *center*
    // (createMeshForInstance's ground-rest convention) — see
    // rebuildSignSprites' own comment just above (#1594) for the full
    // reasoning this sibling function was missing.
    sprite.position.set(calendar.mesh.position.x, calendar.mesh.position.y, calendar.mesh.position.z + baseHeight / 2 + 0.4 + i * 0.5);
    sprite.material.opacity = 0;
    calendar.group.add(sprite);
    calendar.sprites.push(sprite);
  });
  // #1642: same e2e-verification hook as rebuildSignSprites' own
  // window.__lastSignSpriteDebug (#1594).
  window.__lastCalendarSpriteDebug = { meshZ: calendar.mesh.position.z, meshHeight: baseHeight, spriteZs: calendar.sprites.map((s) => s.position.z) };
}

const scratchSignWorldPos = new THREE.Vector3();

// Called every Shop-mode frame (not throttled like updateShopProximity —
// opacity needs to read as a smooth fade, not a 400ms-stepped one). Two
// independent jobs: fade every loaded sign's post sprites by the camera's
// distance to that sign, and track which single nearest in-range sign (if
// any) #shop-sign-hint currently targets.
export function updateSignFade() {
  let nearest = null;
  let nearestDistance = Infinity;
  for (const sign of shopSigns) {
    const world = sign.mesh.getWorldPosition(scratchSignWorldPos);
    const distance = world.distanceTo(camera.position);
    const opacity = 1 - THREE.MathUtils.clamp(
      (distance - SIGN_FADE_NEAR_M) / (SIGN_FADE_FAR_M - SIGN_FADE_NEAR_M), 0, 1,
    );
    for (const sprite of sign.sprites) sprite.material.opacity = opacity;
    if (distance <= SIGN_INTERACT_RADIUS_M && distance < nearestDistance) {
      nearest = sign;
      nearestDistance = distance;
    }
  }
  if (nearest !== nearestActiveSign) {
    nearestActiveSign = nearest;
    shopSignHintEl.classList.toggle('visible', !!nearest);
  }
}

// Community calendar's own per-frame fade — identical logic to
// updateSignFade above, over shopCalendars instead of shopSigns.
export function updateCalendarFade() {
  let nearest = null;
  let nearestDistance = Infinity;
  for (const calendar of shopCalendars) {
    const world = calendar.mesh.getWorldPosition(scratchSignWorldPos);
    const distance = world.distanceTo(camera.position);
    const opacity = 1 - THREE.MathUtils.clamp(
      (distance - SIGN_FADE_NEAR_M) / (SIGN_FADE_FAR_M - SIGN_FADE_NEAR_M), 0, 1,
    );
    for (const sprite of calendar.sprites) sprite.material.opacity = opacity;
    if (distance <= SIGN_INTERACT_RADIUS_M && distance < nearestDistance) {
      nearest = calendar;
      nearestDistance = distance;
    }
  }
  if (nearest !== nearestActiveCalendar) {
    nearestActiveCalendar = nearest;
    shopCalendarHintEl.classList.toggle('visible', !!nearest);
  }
}

// Every placed instance starts with no reviews loaded — fetched once, here,
// right as it enters the world, keyed by the instance's underlying
// templateId (the product), not its own instanceId, since the same review
// list is shared by every placement of that product. Each placement fetches
// independently rather than sharing a per-template cache — a shopper
// posting a review near one placement won't instantly update another
// loaded instance of the same product elsewhere (an edge case rare enough,
// and purely cosmetic enough, that a shared cache isn't worth the added
// bookkeeping here).
export function registerShopReview(mesh, entry) {
  const review = { mesh, group: entry.group, templateId: mesh.userData.template.templateId, reviews: [], sprites: [] };
  shopReviews.push(review);
  fetchProductReviews(review.templateId).then(({ reviews }) => {
    if (!shopReviews.includes(review)) return;
    review.reviews = reviews;
    rebuildReviewSprites(review);
  }).catch(() => {});
}

export function disposeReviewSprites(review) {
  for (const sprite of review.sprites) {
    review.group.remove(sprite);
    sprite.material.map?.dispose();
    sprite.material.dispose();
  }
  review.sprites = [];
}

export function rebuildReviewSprites(review) {
  disposeReviewSprites(review);
  const baseHeight = meshDimensions(review.mesh).height;
  const recent = review.reviews.slice(-SIGN_MAX_VISIBLE_POSTS);
  recent.forEach((r, i) => {
    const stars = '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating);
    const label = r.text ? `${r.authorLabel} ${stars}: ${r.text}` : `${r.authorLabel} ${stars}`;
    const sprite = makeSignPostSprite(label);
    // #1642: same mesh-center-vs-base fix as rebuildCalendarSprites/
    // rebuildSignSprites (#1594) just above — review.mesh.position.z is
    // the mesh's own vertical center, not its base.
    sprite.position.set(review.mesh.position.x, review.mesh.position.y, review.mesh.position.z + baseHeight / 2 + 0.4 + i * 0.5);
    sprite.material.opacity = 0;
    review.group.add(sprite);
    review.sprites.push(sprite);
  });
  // #1642: same e2e-verification hook as rebuildSignSprites' own
  // window.__lastSignSpriteDebug (#1594).
  window.__lastReviewSpriteDebug = { meshZ: review.mesh.position.z, meshHeight: baseHeight, spriteZs: review.sprites.map((s) => s.position.z) };
}

// Product reviews' own per-frame fade — identical logic to updateSignFade/
// updateCalendarFade above, over shopReviews instead of shopSigns. Also
// drives the buy/review hints' visibility: tapped (shopTappedProduct) AND
// still within interact range, recomputed every frame so walking away from
// a tapped product hides its buttons again without needing a fresh tap.
export function updateReviewFade() {
  let tappedDistance = Infinity;
  for (const review of shopReviews) {
    const world = review.mesh.getWorldPosition(scratchSignWorldPos);
    const distance = world.distanceTo(camera.position);
    // #1800: unlike signs/calendars, a review should only be visible once its
    // product has actually been tapped -- pure proximity (the shared
    // SIGN_FADE_NEAR_M/FAR_M curve below) still governs *how* it fades in for
    // the tapped product, it just no longer applies to every nearby review.
    const opacity = review === shopTappedProduct
      ? 1 - THREE.MathUtils.clamp(
        (distance - SIGN_FADE_NEAR_M) / (SIGN_FADE_FAR_M - SIGN_FADE_NEAR_M), 0, 1,
      )
      : 0;
    for (const sprite of review.sprites) sprite.material.opacity = opacity;
    if (review === shopTappedProduct) tappedDistance = distance;
  }
  const tappedInRange = !!shopTappedProduct && tappedDistance <= SIGN_INTERACT_RADIUS_M;
  // #1810: the mesh highlight shares the Buy/Review hints' own range gate —
  // walking out of SIGN_INTERACT_RADIUS_M clears it the same way it hides
  // those buttons, rather than leaving a highlight glowing on a product the
  // shopper is no longer actually standing next to.
  const desiredHighlight = tappedInRange ? shopTappedProduct : null;
  if (desiredHighlight !== shopHighlightedProduct) {
    if (shopHighlightedProduct) removeSelectionOutline(shopHighlightedProduct.mesh);
    if (desiredHighlight) addSelectionOutline(desiredHighlight.mesh);
    shopHighlightedProduct = desiredHighlight;
  }
  // #994: recompute on a tapped-product change too, not just a tappedInRange
  // flip -- two nearby in-range products can be tapped one after another
  // without tappedInRange ever toggling, which used to leave the hints
  // showing the previous product's priced state for the new one.
  if (tappedInRange !== shopReviewHintsVisible || shopTappedProduct !== shopReviewHintsProduct) {
    shopReviewHintsVisible = tappedInRange;
    shopReviewHintsProduct = shopTappedProduct;
    shopProductPreviewReviewBtn.classList.toggle('visible', tappedInRange);
    // Only a priced product has anything to "buy" — an unpriced one (the
    // common case for most placeholder catalog items) shows no buy button at
    // all rather than one that would just 400 on click. #1946 (owner
    // correction): a test/demo model is never purchasable either, even on
    // the rare chance it somehow carried a price — same "hide the
    // affordance entirely" treatment as the unpriced case, not a disabled
    // button. tappedInRange's own !!shopTappedProduct check (above) is what
    // makes the short-circuit here safe -- shopTappedProduct can be null
    // while tappedInRange is false.
    const canBuy = tappedInRange
      && shopTappedProduct.mesh.userData.template.priceCents != null
      && !shopTappedProduct.mesh.userData.template.isTestModel;
    shopProductPreviewBuyBtn.classList.toggle('visible', canBuy);
    // #659: same gate as the Buy button just above — a return policy only
    // matters for something with a price to actually refund.
    shopProductPreviewReturnPolicyBtn.classList.toggle('visible', canBuy);
  }
}

// Shared by main.js's own tap handler and formerly by proximity — the
// actual "name — price (disclaimer)" line the preview modal
// (#shop-product-preview-info) shows once tapped.
export function productInfoText(template) {
  const {
    name, priceCents, metadata, category, skeletonSignature, isTestModel,
  } = template;
  let text = priceCents == null ? name : `${name} — ${formatPriceCents(priceCents)}`;
  // #1946 (owner correction): a test/demo model must read as obviously not
  // a real product wherever a shopper sees it, same tap-to-inspect
  // disclosure slot as the digital-goods/domestic-only/no-returns notes
  // below -- shown first since it overrides the ordinary "is this for
  // sale" assumption the rest of this text otherwise implies.
  if (isTestModel) text += ' (Testing Model — not a real product, not for sale)';
  // The "clear higglehaven-controlled disclaimer" digital goods require
  // (docs/SPEC.md §4) — shown to the shopper right where they'd otherwise
  // assume every placed item is a physical one.
  const disclaimerKey = metadata?.digitalGoodDisclaimer;
  if (disclaimerKey) text += ` (${DIGITAL_GOOD_DISCLAIMER_TEXT[disclaimerKey]})`;
  // docs/SPEC.md §5's shipping disclosure ("ships to United States only")
  // — same tap-to-inspect treatment as the digital-goods disclaimer above,
  // shown right where a shopper would otherwise assume every item ships
  // internationally like the rest of the catalog.
  if (metadata?.domesticOnly) text += ' (ships to United States only)';
  // #659 (owner, Control Room, 2026-09-11): a shopper had no way to see a
  // product's own return policy before buying it — this is the same
  // tap-to-inspect disclosure slot the digital-goods/domestic-only notes
  // above already use, so a no-returns product reads the same way those
  // do: right where a shopper would otherwise assume every item can be
  // returned like the rest of the catalog. A product that DOES accept
  // returns gets no extra text here — the general 99% refund policy
  // (see the Return Policy link this same tap also reveals) already
  // covers the default case, and repeating "returns accepted" on every
  // single product would just be noise.
  if (metadata?.noReturns) text += ' (no returns)';
  // #1164 (sub-issue of #1161): same tap-to-inspect disclosure slot as the
  // notes above, so a shopper sees whether a standalone animation will
  // actually play against their own currently-equipped avatar before
  // buying it, rather than discovering that only after purchase.
  if (category === 'animation') {
    text += ` (${animationCompatibilityLabel(animationCompatibility(skeletonSignature, shopEquippedAvatarSkeletonSignature))})`;
  }
  return text;
}

// Walks up from a raycast hit (a model's own nested child mesh — see
// loadModelInstance) to whichever shopReviews entry's root mesh is its
// ancestor, the same findRootProduct pattern Build mode's own click
// handler uses against productMeshes.
export function findTappedShopProduct(object) {
  let current = object;
  while (current) {
    const review = shopReviews.find((r) => r.mesh === current);
    if (review) return review;
    current = current.parent;
  }
  return null;
}

// event.triggeredAt is only ever set once a trigger request's own .then()
// resolves — with nothing tracking a request already in flight, a call
// slower than one 10s check interval (slow network, a throttled
// backgrounded tab, or many due events firing in the same tick) let the
// next tick re-issue a request for that same still-untriggered event.
// pendingCalendarEventTriggers closes that gap; eventId is unique enough
// on its own (no instanceId needed) since it's never reused across events.
const pendingCalendarEventTriggers = new Set();
export function checkScheduledCalendarEvents() {
  const nowIso = new Date().toISOString();
  for (const calendar of shopCalendars) {
    for (const event of calendar.events) {
      if (!event.scheduledAt || event.triggeredAt || event.scheduledAt > nowIso) continue;
      if (pendingCalendarEventTriggers.has(event.eventId)) continue;
      pendingCalendarEventTriggers.add(event.eventId);
      triggerCalendarEvent(calendar.instanceId, event.eventId).then(({ event: updated, triggered }) => {
        // Cache the server's own triggeredAt locally regardless of who
        // actually won the race, so a lost race doesn't keep retrying
        // this same event every 10 seconds for the rest of the visit.
        event.triggeredAt = updated.triggeredAt;
        // #436: this request's own await is a real gap the landlet can
        // unload (or reload with a fresh calendar object of the same
        // instanceId) across — main.js's own unloadShopLandletInstances
        // already disposes calendar.group/sprites in that case, so
        // spawning into it here would burst confetti into a detached,
        // no-longer-in-scene Three.js group. Same guard the click-driven
        // sign-post/calendar-event handlers already use for #426.
        if (triggered && shopCalendars.includes(calendar)) spawnConfettiBurst(calendar.mesh.position, calendar.group);
        pendingCalendarEventTriggers.delete(event.eventId);
      }).catch(() => { pendingCalendarEventTriggers.delete(event.eventId); });
    }
  }
}
