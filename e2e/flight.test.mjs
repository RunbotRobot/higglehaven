// Regression/coverage for #120: the Shop-mode flight state machine
// (tap-to-toggle, takeoff, ascend/descend, landing) had zero e2e coverage
// — src/flight.test.js now covers the pure altitude/speed math directly,
// but the real tap gesture and DOM wiring (body.shop-flying,
// the takeoff/landing plumbing) had never been exercised
// end-to-end in a real browser. Doesn't attempt to measure the exact
// altitude/speed-multiplier curve itself here — that's what
// src/flight.test.js's direct unit tests are for; this proves the
// click/DOM plumbing around that math actually works.
//
// #3650: the bird button is gone; a double-tap on the world (covered by
// e2e/shop-world-gestures.test.mjs) or a double-press of space flies. This file
// drives the same toggle through window.__testToggleShopFlight.
import { launchPage, chooseIdentity, finish, flyWithHeight } from './helpers.mjs';

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
await page.waitForSelector('body.shop-ready', { timeout: 10000 });
// #688: `#shop-fly-btn.visible` (and `#shop-status.visible`, "Loading the
// world…") both get set at the *start* of enterShopMode's post-gate world
// build (src/main.js), well before the spawn-flight state this test is
// about to check gets set at the very *end* of it, once
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

// #1175: every spawn (not just a first-ever visit) now spawns already
// flying, above a random world location — no tap needed at all.
const flyingOnSpawn = await isFlyingClassSet();

// The rest of this file is about the manual tap-to-toggle takeoff/landing
// flow, not the spawn-flying behavior above — land the spawn's own flight
// with a single tap and wait past the landing duration so it starts from
// the ordinary grounded baseline the takeoff flow below expects.
await page.evaluate(() => window.__testToggleShopFlight());
await page.waitForTimeout(2500); // past SHOP_FLIGHT_LANDING_DURATION_S (2s)

const groundedBeforeTakeoff = !(await isFlyingClassSet());

await page.evaluate(() => window.__testToggleShopFlight());
// toggleShopFlight sets body.shop-flying
// synchronously on the tap that starts takeoff — not gated behind the ~1s
// takeoff animation itself — so this should already be true immediately.
const flyingClassRightAfterTakeoffTap = await isFlyingClassSet();

// Wait past SHOP_FLIGHT_TAKEOFF_DURATION_S (1s) so the internal state
// machine has actually reached 'flying' — toggling again before that has
// no effect (toggleShopFlight only handles a tap from
// 'grounded' or 'flying', not mid-transition).
await page.waitForTimeout(1500);

// #4105: no up/down arrows. Flight is level; height changes by the height gesture (Page Up and Page
// Down stand in for the edge slide here), and with no height input the height is held.
const altitude = () => page.evaluate(() => window.__testShopAvatarPosition().z);
const arrowsGone = (await page.locator('#shop-up-btn, #shop-down-btn, #shop-vertical-controls').count()) === 0;
const z0 = await altitude();
await flyWithHeight(page, 'up', { moveMs: 1500 });
const zUp = await altitude();
await page.waitForTimeout(500);
const zHeld = await altitude(); // no move input: height is held
await flyWithHeight(page, 'down', { moveMs: 1500 });
const zDown = await altitude();
const climbedByLooking = zUp > z0 + 1;
const heldWhileNotMoving = Math.abs(zHeld - zUp) < 0.05;
const descendedByLooking = zDown < zUp - 1;

// Second tap, now genuinely 'flying' — starts landing. Same immediate
// (not animation-gated) class removal as takeoff's own set.
await page.evaluate(() => window.__testToggleShopFlight());
const flyingClassRightAfterLandingTap = await isFlyingClassSet();

// Wait past SHOP_FLIGHT_LANDING_DURATION_S (2s) so the internal state
// machine has actually settled back to 'grounded' before the page closes.
await page.waitForTimeout(2500);
const groundedAfterLanding = !(await isFlyingClassSet());

console.log('flying immediately on spawn, no tap needed (should be true):', flyingOnSpawn);
console.log('grounded before any takeoff (should be true):', groundedBeforeTakeoff);
console.log('shop-flying set immediately after the takeoff tap (should be true):', flyingClassRightAfterTakeoffTap);
console.log('no up/down arrows on the page (should be true):', arrowsGone);
console.log('rose with the height key and walking forward (should be true):', climbedByLooking, z0, zUp);
console.log('height held with no height input (should be true):', heldWhileNotMoving, zUp, zHeld);
console.log('sank with the height key and walking forward (should be true):', descendedByLooking, zUp, zDown);
console.log('shop-flying cleared immediately after the landing tap (should be false):', flyingClassRightAfterLandingTap);
console.log('grounded again after the landing duration elapses (should be true):', groundedAfterLanding);

const pass =
  flyingOnSpawn &&
  groundedBeforeTakeoff &&
  flyingClassRightAfterTakeoffTap &&
  arrowsGone &&
  climbedByLooking &&
  heldWhileNotMoving &&
  descendedByLooking &&
  !flyingClassRightAfterLandingTap &&
  groundedAfterLanding &&
  errors.length === 0;
await finish(browser, { pass, label: 'shop-mode flight takeoff/ascend/landing', errors });
