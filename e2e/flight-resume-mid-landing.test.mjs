// Regression for #2446: toggleShopFlight() (src/main.js) only branched on
// shopFlightState === 'grounded'/'flying' — a tap of the fly button while
// shopFlightState === 'landing' was silently ignored, forcing the player to
// wait out the whole SHOP_FLIGHT_LANDING_DURATION_S descent before the
// button did anything again. The fix added a 'landing' branch that resumes
// 'flying' immediately, from whatever altitude the descent had already
// reached (shopFlightAltitudeM is live/current throughout the landing ramp)
// rather than resetting to the ground or back to the landing's starting
// altitude.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const { browser, page, errors } = await launchPage({ promptAnswer: 'Resume Landing Tester' });

await chooseIdentity(page, { mode: 'shop', label: 'Resume Landing Tester', isNew: true });
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 10000 });
// Same "wait for the world build's own last DOM change" rationale as
// flight.test.mjs's identical wait — see that file's own comment.
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });

const isFlyingClassSet = () => page.evaluate(() => document.body.classList.contains('shop-flying'));
const isFlyBtnActive = () => page.evaluate(() => document.getElementById('shop-fly-btn').classList.contains('active'));
const flyBtnIconFile = () => page.evaluate(() => document.getElementById('shop-fly-btn-icon').src.split('/').pop());
const flightState = () => page.evaluate(() => window.__testShopFlightState());
const altitudeZ = () => page.evaluate(() => window.__testShopAvatarPosition().z);

// #1175: every spawn starts already flying, above a random world location.
const flyingOnSpawn = (await flightState()) === 'flying';

// Start landing from the spawn's own flight.
await page.click('#shop-fly-btn');
// #2639 (sub-issue of #2635): waitForFunction's signature is (pageFunction,
// arg, options) -- a bare (fn, { timeout }) call puts the options object in
// the `arg` slot instead, so `options` stayed undefined and the real applied
// timeout was always Playwright's actual default (30000ms), never the
// smaller number written here. The explicit `null` arg reaches the options
// slot, and the timeout itself is widened to 60000ms for real headroom under
// CI load. (The sibling waitForFunction a few lines below already passes a
// real `arg` correctly and isn't affected by this bug.)
await page.waitForFunction(() => window.__testShopFlightState() === 'landing', null, { timeout: 60000 });
const altitudeAtLandingStart = await altitudeZ();

// Let the descent run partway down before resuming — polling the avatar's
// own altitude dropping, not a fixed real-time wait, for the same
// CPU-starved-CI-tick reason e2e/flight.test.mjs's own #2423 comment on
// window.__testShopFlightState gives: simulated flight time can fall
// arbitrarily far behind real time under load, so a wait sized for
// SHOP_FLIGHT_LANDING_DURATION_S (2s) in real time isn't actually
// guaranteed to have made any simulated progress at all.
await page.waitForFunction(
  (startZ) => window.__testShopAvatarPosition().z < startZ - 0.3,
  altitudeAtLandingStart,
  { timeout: 5000 },
);
const altitudeMidDescent = await altitudeZ();
const stateMidDescent = await flightState();

// The actual regression check: a tap while shopFlightState === 'landing'.
// Dispatched as a single in-page pointerdown (matching bindShopFlyToggle's
// own binding — this button listens for pointerdown, not click) inside one
// page.evaluate() rather than page.click(), so the before/after altitude
// reads below bracket the handler with no Playwright round-trip latency in
// between — toggleShopFlight() itself runs synchronously and ticks no
// animation frame of its own, so the two reads should be the same instant.
const {
  altitudeRightBeforeResumeTap, altitudeRightAfterResumeTap, stateRightAfterResumeTap,
  flyingClassRightAfterResumeTap, flyBtnActiveRightAfterResumeTap, flyBtnIconRightAfterResumeTap,
} = await page.evaluate(() => {
  const before = window.__testShopAvatarPosition().z;
  document.getElementById('shop-fly-btn').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  return {
    altitudeRightBeforeResumeTap: before,
    altitudeRightAfterResumeTap: window.__testShopAvatarPosition().z,
    stateRightAfterResumeTap: window.__testShopFlightState(),
    flyingClassRightAfterResumeTap: document.body.classList.contains('shop-flying'),
    flyBtnActiveRightAfterResumeTap: document.getElementById('shop-fly-btn').classList.contains('active'),
    flyBtnIconRightAfterResumeTap: document.getElementById('shop-fly-btn-icon').src.split('/').pop(),
  };
});

// Give it time to drift if (bug) it silently kept landing in the
// background — past the full SHOP_FLIGHT_LANDING_DURATION_S (2s) from when
// landing originally started, well past what a resumed, steady 'flying'
// hover (no vertical input held) should ever need.
await page.waitForTimeout(2500);
const stateAfterWaitingPastOriginalLandingDuration = await flightState();
const altitudeAfterWaitingPastOriginalLandingDuration = await altitudeZ();

console.log('flying on spawn, no tap needed (should be true):', flyingOnSpawn);
console.log('internal state after the landing tap (should be "landing"):', stateMidDescent);
console.log('altitude at landing start vs. partway down (should have dropped):', altitudeAtLandingStart, '->', altitudeMidDescent);
console.log('internal state immediately after the resume tap (should be "flying", not "grounded"):', stateRightAfterResumeTap);
console.log('body.shop-flying immediately after the resume tap (should be true):', flyingClassRightAfterResumeTap);
console.log('#shop-fly-btn.active immediately after the resume tap (should be true):', flyBtnActiveRightAfterResumeTap);
console.log('#shop-fly-btn-icon immediately after the resume tap (should be bird-standing.png, i.e. "press to land"):', flyBtnIconRightAfterResumeTap);
console.log('altitude right before vs. right after the resume tap (should be nearly identical -- resumes from here, not reset):', altitudeRightBeforeResumeTap, '->', altitudeRightAfterResumeTap);
console.log('state well past the original landing duration (should still be "flying", not "grounded"):', stateAfterWaitingPastOriginalLandingDuration);
console.log('altitude well past the original landing duration (should still be hovering, not back at ground 0):', altitudeAfterWaitingPastOriginalLandingDuration);

const pass =
  flyingOnSpawn &&
  stateMidDescent === 'landing' &&
  altitudeMidDescent < altitudeAtLandingStart &&
  stateRightAfterResumeTap === 'flying' &&
  flyingClassRightAfterResumeTap &&
  flyBtnActiveRightAfterResumeTap &&
  flyBtnIconRightAfterResumeTap === 'bird-standing.png' &&
  Math.abs(altitudeRightAfterResumeTap - altitudeRightBeforeResumeTap) < 0.5 &&
  stateAfterWaitingPastOriginalLandingDuration === 'flying' &&
  altitudeAfterWaitingPastOriginalLandingDuration > 0.5 &&
  errors.length === 0;
await finish(browser, { pass, label: 'tapping the fly button mid-landing resumes flight immediately (#2446)', errors });
