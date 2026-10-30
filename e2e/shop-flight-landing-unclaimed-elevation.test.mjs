// #2899: bareGroundAltitudeM (src/shop/flightMovement.js) used to compute
// its own "rest on bare ground" altitude indirectly, by subtracting
// shopCurrentLandletEntry's own elevationM back out of
// shopTerrainHeightAtM(x, y) -- a no-op in the common case (same landlet,
// so the two values match), but wrong whenever they diverge.
// shopCurrentLandletEntry only ever tracks a *claimed* landlet
// (updateShopLandletInfo's own `status === 'claimed'` filter), while
// shopTerrainHeightAtM deliberately has no such filter (elevation applies
// to every landlet regardless of claim status) -- so on unclaimed ground,
// the old formula reduced to `0 - shopTerrainHeightAtM(x, y)`, the real
// elevation's own negative.
//
// That minAltitudeM then feeds src/flight.js's clampedLandingAltitudeM,
// whose own ramp (landingAltitudeM) eases toward 0 purely as a function of
// elapsed time -- it has no idea what minAltitudeM even is, and only ever
// *decreases* toward 0 across the whole landing duration (never negative,
// never past it). clampedLandingAltitudeM's landed-early check
// (`rampAltitudeM <= minAltitudeM`) can therefore only ever fire while
// minAltitudeM is >= 0 and still ahead of the ramp -- a *negative*
// minAltitudeM (the unclaimed-with-*positive*-elevation case: 0 - 6 = -6)
// is never reached at all, and landing instead just times out at the
// ramp's own natural elapsedS >= durationS floor of ~0. Per-frame sync
// then adds shopTerrainHeightAtM(x, y) back on top of that ~0, which
// happens to land exactly back on the real elevation -- the claimed/
// unclaimed bug is fully masked for *positive* elevation, purely as a
// side effect of the ramp's own one-directional shape.
//
// Unclaimed ground with *negative* elevation is the one case that actually
// exposes it: minAltitudeM there is 0 - (-6) = +6, a target the ramp
// genuinely passes through on its way down from a real flying altitude,
// so clampedLandingAltitudeM's early-landed check fires at +6 -- then the
// same sync adds shopTerrainHeightAtM(x, y) = -6 back on top, cancelling
// straight back to the old flat z = 0 baseline instead of the landlet's
// real z = -6. Confirmed via direct e2e reproduction (poll-logging
// shopFlightState/shopAvatarPosition every 200ms through a real landing)
// before writing this fix -- a positive TEST_ELEVATION_M here does NOT
// reproduce the bug, for exactly the masking reason above; only negative
// elevation does.
//
// e2e/shop-terrain-elevation-landing.test.mjs already covers the matching
// case (landing on the player's own CLAIMED, elevated landlet) -- this
// test specifically exercises the claimed/unclaimed asymmetry by landing
// on an unclaimed (greenbelt) landlet instead, with no claim of any kind.
import { execSync } from 'node:child_process';
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL = 'Unclaimed Elevation Landing Tester';
const TEST_ELEVATION_M = -6;

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

// No build-mode claim at all -- entering Shop mode directly only needs a
// real signed-up identity, per chooseIdentity's own "already logged in —
// entry proceeds on its own" shortcut when there's nothing left to prompt.
await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 10000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });

async function fetchJson(path, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [path, options]);
}

const { landlets } = (await fetchJson('/api/landlets?limit=100')).body;
// Deliberately unclaimed -- the whole point of this test is the claimed/
// unclaimed asymmetry bareGroundAltitudeM used to have.
const greenbeltLandlet = landlets.find((l) => l.status === 'greenbelt');
if (!greenbeltLandlet) throw new Error('shop-flight-landing-unclaimed-elevation: no unclaimed (greenbelt) landlet found to test against');

// Same "one real way to drive a nonzero elevation_m through this
// deployment" precedent e2e/shop-terrain-elevation-consistency.test.mjs
// and e2e/shop-terrain-elevation-landing.test.mjs both already use.
execSync(
  `npx wrangler d1 execute higglehaven-db --local --command "UPDATE landlets SET elevation_m = ${TEST_ELEVATION_M} WHERE landlet_id = '${greenbeltLandlet.landletId}'"`,
  { cwd: new URL('..', import.meta.url).pathname, stdio: 'pipe' },
);

// A fresh page load re-fetches /api/landlets for real, picking up the
// elevation_m just written -- same pattern those same two test files use.
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(500);
await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: false });
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 10000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });

// #1445: break the hands-off spawn orbit (shopSpawnRotating), which
// otherwise overwrites shopAvatarPosition.x/y every frame and fights the
// teleport below -- same convention shop-terrain-elevation-landing.test.mjs
// already uses.
async function stopSpawnOrbit() {
  const box = await page.locator('#shop-move-joystick').boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 25, cy, { steps: 5 });
  await page.waitForTimeout(100);
  await page.mouse.up();
  await page.waitForTimeout(100);
}
await stopSpawnOrbit();

// Same "reach 'landing' regardless of which flight state a fresh spawn
// starts in" shape as shop-terrain-elevation-landing.test.mjs's own helper.
async function clickUntilLanding() {
  for (let i = 0; i < 6; i++) {
    const state = await page.evaluate(() => window.__testShopFlightState());
    if (state === 'landing') return;
    if (state === 'grounded' || state === 'flying') {
      await page.locator('#shop-fly-btn').click();
    }
    await page.waitForTimeout(1200);
  }
}

await page.evaluate(
  ([x, y]) => window.__testTeleportShopAvatar(x, y),
  [greenbeltLandlet.center.x, greenbeltLandlet.center.y],
);
await page.waitForTimeout(300);
await clickUntilLanding();
await page.waitForFunction(() => window.__testShopFlightState() === 'grounded', { timeout: 15000 });
await page.waitForTimeout(300);
const landingPos = await page.evaluate(() => window.__testShopAvatarPosition());
console.log(
  `bare-ground landing on an UNCLAIMED elevationM=${TEST_ELEVATION_M} landlet (z should be ~${TEST_ELEVATION_M}, not ~0 -- the pre-#2899 bug floated it back up to the old flat baseline instead):`,
  landingPos,
);

const pass = Math.abs(landingPos.z - TEST_ELEVATION_M) < 0.1 && errors.length === 0;

await finish(browser, {
  pass,
  label: '#2899: landing on bare, unclaimed, negative-elevation ground rests at its real elevation, not the old flat baseline',
  errors,
});
