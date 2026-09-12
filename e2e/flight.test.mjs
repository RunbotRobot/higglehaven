// Regression/coverage for #120: the Shop-mode flight state machine
// (tap-to-toggle, takeoff, ascend/descend, landing) had zero e2e coverage
// — src/flight.test.js now covers the pure altitude/speed math directly,
// but the real tap gesture and DOM wiring (body.shop-flying,
// #shop-fly-btn.active, #shop-vertical-controls) had never been exercised
// end-to-end in a real browser. Doesn't attempt to measure the exact
// altitude/speed-multiplier curve itself here — that's what
// src/flight.test.js's direct unit tests are for; this proves the
// click/DOM plumbing around that math actually works.
//
// Owner (u7rvtz1jn1wchfsz6c1o): the bird button toggles flight on a single
// tap now, not a double-tap — see bindShopFlyToggle in src/main.js. The
// spacebar gesture (desktop) still requires a double-press and is covered
// separately; this file only exercises the button.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const { browser, page, errors } = await launchPage({ promptAnswer: 'Flight Tester' });

// A fresh page load lands in Shop mode by default (see bootstrap() in
// src/main.js) — clicking the Shop nav button here is a no-op (already the
// current mode, per its own click handler), so this only exists to drive
// chooseIdentity's login/verification flow: N44 (owner, 2026-09-12) gates
// Shop mode's own entry on the same age-attestation + credit-card-or-ID
// requirement Build/Sell already had, so the auth modal this triggers is
// really the one that opened automatically the moment enterShopMode's own
// gate (ensureShopperIdentity) ran on this page's initial load.
await chooseIdentity(page, { mode: 'shop', label: 'Flight Tester', isNew: true });
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 10000 });
// #688: `#shop-fly-btn.visible` (and `#shop-status.visible`, "Loading the
// world…") both get set at the *start* of enterShopMode's post-gate world
// build (src/main.js), well before the first-ever-visit flight spawn this
// test is about to check gets set at the very *end* of it, once
// fetchCatalog/fetchWorld/fetchAllLandlets and the landlet meshes have
// actually finished. Before N44/#678 added the login/verification gate
// above, launchPage's own fixed 1500ms settle time already covered that
// whole gap incidentally; chooseIdentity's own wait ends the instant the
// gate itself clears, with no such cushion left before this check. Wait
// for the one signal enterShopMode only clears once that tail has actually
// run — `#shop-status` losing `.visible` again (its very last DOM change,
// right after the flight-state assignment below) — rather than racing it.
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });

const isFlyingClassSet = () => page.evaluate(() => document.body.classList.contains('shop-flying'));
const isFlyBtnActive = () => page.evaluate(() => document.getElementById('shop-fly-btn').classList.contains('active'));

// #119: a genuinely first-ever Shop-mode visit on this device (no
// localStorage flag set yet — exactly this fresh browser context's state
// right now) spawns already flying, above the world, with no double-tap
// at all — checked before anything below sets that flag.
const flyingOnFirstEverVisit = await isFlyingClassSet();
const flyBtnActiveOnFirstEverVisit = await isFlyBtnActive();

// The rest of this file is about the manual double-tap toggle flow, not
// the first-visit spawn above — set the "visited before" flag and reload
// so it starts from the ordinary grounded baseline every later Shop-mode
// entry uses (matching src/main.js's own enterShopMode distinction).
await page.evaluate(() => localStorage.setItem('higglehaven.shopVisitedBefore', '1'));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 10000 });

const groundedBeforeTakeoff = !(await isFlyingClassSet());

await page.click('#shop-fly-btn');
// toggleShopFlight sets body.shop-flying and #shop-fly-btn.active
// synchronously on the tap that starts takeoff — not gated behind the ~1s
// takeoff animation itself — so this should already be true immediately.
const flyingClassRightAfterTakeoffTap = await isFlyingClassSet();
const flyBtnActiveRightAfterTakeoffTap = await isFlyBtnActive();
const verticalControlsVisibleDuringTakeoff = await page.isVisible('#shop-vertical-controls');

// Wait past SHOP_FLIGHT_TAKEOFF_DURATION_S (1s) so the internal state
// machine has actually reached 'flying' — toggling again before that has
// no effect (bindShopFlyToggle/toggleShopFlight only handle a tap from
// 'grounded' or 'flying', not mid-transition).
await page.waitForTimeout(1500);

// Hold the ascend button briefly — exercises bindShopVerticalButton's real
// pointerdown/pointerup pair (not just a click) without asserting the
// resulting altitude/speed numerically (see src/flight.test.js for that).
const upBtnBox = await page.locator('#shop-up-btn').boundingBox();
await page.mouse.move(upBtnBox.x + upBtnBox.width / 2, upBtnBox.y + upBtnBox.height / 2);
await page.mouse.down();
const upBtnActiveWhileHeld = await page.evaluate(() => document.getElementById('shop-up-btn').classList.contains('active'));
await page.waitForTimeout(500);
await page.mouse.up();
const upBtnActiveAfterRelease = await page.evaluate(() => document.getElementById('shop-up-btn').classList.contains('active'));

// Second tap, now genuinely 'flying' — starts landing. Same immediate
// (not animation-gated) class removal as takeoff's own set.
await page.click('#shop-fly-btn');
const flyingClassRightAfterLandingTap = await isFlyingClassSet();
const flyBtnActiveRightAfterLandingTap = await isFlyBtnActive();

// Wait past SHOP_FLIGHT_LANDING_DURATION_S (2s) so the internal state
// machine has actually settled back to 'grounded' before the page closes.
await page.waitForTimeout(2500);
const groundedAfterLanding = !(await isFlyingClassSet());

console.log('flying immediately on a genuinely first-ever visit, no tap needed (should be true):', flyingOnFirstEverVisit);
console.log('#shop-fly-btn.active on that same first-ever visit (should be true):', flyBtnActiveOnFirstEverVisit);
console.log('grounded before any takeoff (should be true):', groundedBeforeTakeoff);
console.log('shop-flying set immediately after the takeoff tap (should be true):', flyingClassRightAfterTakeoffTap);
console.log('#shop-fly-btn.active immediately after the takeoff tap (should be true):', flyBtnActiveRightAfterTakeoffTap);
console.log('#shop-vertical-controls visible during takeoff (should be true):', verticalControlsVisibleDuringTakeoff);
console.log('#shop-up-btn.active while held (should be true):', upBtnActiveWhileHeld);
console.log('#shop-up-btn.active after release (should be false):', upBtnActiveAfterRelease);
console.log('shop-flying cleared immediately after the landing tap (should be false):', flyingClassRightAfterLandingTap);
console.log('#shop-fly-btn.active cleared immediately after the landing tap (should be false):', flyBtnActiveRightAfterLandingTap);
console.log('grounded again after the landing duration elapses (should be true):', groundedAfterLanding);

const pass =
  flyingOnFirstEverVisit &&
  flyBtnActiveOnFirstEverVisit &&
  groundedBeforeTakeoff &&
  flyingClassRightAfterTakeoffTap &&
  flyBtnActiveRightAfterTakeoffTap &&
  verticalControlsVisibleDuringTakeoff &&
  upBtnActiveWhileHeld &&
  !upBtnActiveAfterRelease &&
  !flyingClassRightAfterLandingTap &&
  !flyBtnActiveRightAfterLandingTap &&
  groundedAfterLanding &&
  errors.length === 0;
await finish(browser, { pass, label: 'shop-mode flight takeoff/ascend/landing', errors });
