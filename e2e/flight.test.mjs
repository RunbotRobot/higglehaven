// Regression/coverage for #120: the Shop-mode flight state machine
// (double-tap-to-toggle, takeoff, ascend/descend, landing) had zero
// e2e coverage — src/flight.test.js now covers the pure altitude/speed
// math directly, but the real double-tap gesture and DOM wiring
// (body.shop-flying, #shop-fly-btn.active, #shop-vertical-controls) had
// never been exercised end-to-end in a real browser. Doesn't attempt to
// measure the exact altitude/speed-multiplier curve itself here — that's
// what src/flight.test.js's direct unit tests are for; this proves the
// click/DOM plumbing around that math actually works.
import { launchPage, finish } from './helpers.mjs';

const { browser, page, errors } = await launchPage({ promptAnswer: 'Flight Tester' });

// A fresh page load lands in Shop mode by default (see bootstrap() in
// src/main.js) — no login/identity needed, unlike Build/Sell.
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 10000 });

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

// Double-tap: a single click is deliberately ignored (see bindShopFlyToggle
// in src/main.js — "never launches the player into the air unintentionally").
await page.dblclick('#shop-fly-btn');
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

// Second double-tap, now genuinely 'flying' — starts landing. Same
// immediate (not animation-gated) class removal as takeoff's own set.
await page.dblclick('#shop-fly-btn');
const flyingClassRightAfterLandingTap = await isFlyingClassSet();
const flyBtnActiveRightAfterLandingTap = await isFlyBtnActive();

// Wait past SHOP_FLIGHT_LANDING_DURATION_S (2s) so the internal state
// machine has actually settled back to 'grounded' before the page closes.
await page.waitForTimeout(2500);
const groundedAfterLanding = !(await isFlyingClassSet());

console.log('flying immediately on a genuinely first-ever visit, no double-tap (should be true):', flyingOnFirstEverVisit);
console.log('#shop-fly-btn.active on that same first-ever visit (should be true):', flyBtnActiveOnFirstEverVisit);
console.log('grounded before any takeoff (should be true):', groundedBeforeTakeoff);
console.log('shop-flying set immediately after the takeoff double-tap (should be true):', flyingClassRightAfterTakeoffTap);
console.log('#shop-fly-btn.active immediately after the takeoff double-tap (should be true):', flyBtnActiveRightAfterTakeoffTap);
console.log('#shop-vertical-controls visible during takeoff (should be true):', verticalControlsVisibleDuringTakeoff);
console.log('#shop-up-btn.active while held (should be true):', upBtnActiveWhileHeld);
console.log('#shop-up-btn.active after release (should be false):', upBtnActiveAfterRelease);
console.log('shop-flying cleared immediately after the landing double-tap (should be false):', flyingClassRightAfterLandingTap);
console.log('#shop-fly-btn.active cleared immediately after the landing double-tap (should be false):', flyBtnActiveRightAfterLandingTap);
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
