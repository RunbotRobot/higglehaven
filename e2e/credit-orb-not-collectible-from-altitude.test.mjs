// #2443: updateCreditOrbs' own collect-trigger check used to be
// horizontal-only (x/y via CREDIT_ORB_COLLECT_RADIUS_M), never looking at
// altitude at all -- so flying directly over an orb's world position at any
// height auto-collected it exactly like a real ground walk-in would. Same
// seeding approach (seedCreditOrbAsAdmin) and teleport-hook choreography as
// e2e/credit-orb-collect.test.mjs; this exercises the new altitude
// exclusion (CREDIT_ORB_COLLECT_ALTITUDE_TOLERANCE_M, checked against
// shopFlightAltitudeM) that test's own ground-level case doesn't cover.
import { launchPage, chooseIdentity, createGreenbeltLandletAsAdmin, seedCreditOrbAsAdmin, finish } from './helpers.mjs';

const LABEL = 'Credit Orb Flight Altitude Tester';
const LANDLET_ID = `credit-orb-altitude-e2e-${Date.now()}`;
const ORB_X = 2;
const ORB_Y = -1;
// Negligible curvatureDropM at this landlet's own near-origin test
// coordinates, same convention e2e/shop-walk-after-landing-on-object.test.mjs
// already relies on for its own exact-z assertion.
const GROUND_Z = 0;
// Well above CREDIT_ORB_COLLECT_ALTITUDE_TOLERANCE_M (1.5m) -- a real flight
// altitude, not a borderline case near the tolerance boundary.
const FLIGHT_ALTITUDE_M = 20;

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await createGreenbeltLandletAsAdmin(LANDLET_ID, { areaM2: 1000 });
const orbId = await seedCreditOrbAsAdmin(LANDLET_ID, { x: ORB_X, y: ORB_Y });

async function fetchJson(path) {
  return page.evaluate(async (p) => (await fetch(p)).json(), path);
}

await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 10000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });

const { landlets } = await fetchJson('/api/landlets?limit=100');
const myLandlet = landlets.find((l) => l.landletId === LANDLET_ID);
console.log('seeded landlet found via the API (should be true):', !!myLandlet);

// #1445: a brief real joystick deflection breaks Shop mode's own hands-off
// spawn orbit, freeing shopAvatarPosition for the teleport hook to drive —
// same sequence e2e/credit-orb-collect.test.mjs uses.
const moveJoystickBox = await page.locator('#shop-move-joystick').boundingBox();
const moveCenterX = moveJoystickBox.x + moveJoystickBox.width / 2;
const moveCenterY = moveJoystickBox.y + moveJoystickBox.height / 2;
await page.mouse.move(moveCenterX, moveCenterY);
await page.mouse.down();
await page.mouse.move(moveCenterX + 25, moveCenterY, { steps: 5 });
await page.waitForTimeout(100);
await page.mouse.up();
await page.waitForTimeout(100);

// Teleport onto the landlet's own center first and force the load decision,
// same two-step choreography as e2e/credit-orb-collect.test.mjs. Explicit
// z=0 (rather than omitting z, which leaves the avatar at whatever altitude
// it last had -- still SHOP_SPAWN_START_ALTITUDE_M's 80m here, since
// breaking the hands-off spawn orbit above only frees x/y, it doesn't land
// the avatar) genuinely grounds it, matching credit-orb-collect.test.mjs'
// own #2443 fix.
await page.evaluate(([x, y, z]) => {
  window.__testTeleportShopAvatar(x, y, z);
  window.__testForceShopProximityCheck();
}, [myLandlet.center.x, myLandlet.center.y, GROUND_Z]);
await page.waitForTimeout(500);

const orbWorldX = myLandlet.center.x + ORB_X;
const orbWorldY = myLandlet.center.y + ORB_Y;

// Fly directly over the orb's own world position, well above
// CREDIT_ORB_COLLECT_ALTITUDE_TOLERANCE_M -- #2443's own bug let this
// auto-collect purely on horizontal proximity, ignoring altitude entirely.
await page.evaluate(([x, y, z]) => {
  window.__testTeleportShopAvatar(x, y, z);
  window.__testForceShopProximityCheck();
}, [orbWorldX, orbWorldY, GROUND_Z + FLIGHT_ALTITUDE_M]);
await page.waitForTimeout(500);

const listedWhileFlyingOver = await fetchJson(`/api/credit-orbs?landletId=${encodeURIComponent(LANDLET_ID)}`);
console.log('orb still active while flying directly over it at altitude (should be true):', listedWhileFlyingOver.orbs.some((o) => o.orbId === orbId));
const toastVisibleWhileFlying = await page.evaluate(() => document.getElementById('shop-credit-orb-toast')?.classList.contains('visible') ?? false);
console.log('no collect toast while flying over it (should be false):', toastVisibleWhileFlying);

// Now land back on the ground at the exact same x/y -- confirms this is a
// genuine altitude exclusion, not an accidental horizontal-radius regression
// that would also break the ordinary walk-in case.
await page.evaluate(([x, y, z]) => {
  window.__testTeleportShopAvatar(x, y, z);
  window.__testForceShopProximityCheck();
}, [orbWorldX, orbWorldY, GROUND_Z]);
await page.waitForSelector('#shop-credit-orb-toast.visible', { timeout: 5000 });
const toastText = await page.textContent('#shop-credit-orb-toast');
console.log('collect confirmation toast text after landing on it (should mention credit):', toastText);

const listedAfterLandingOnIt = await fetchJson(`/api/credit-orbs?landletId=${encodeURIComponent(LANDLET_ID)}`);
console.log('orb no longer active after landing on it and auto-collecting (should be true):', !listedAfterLandingOnIt.orbs.some((o) => o.orbId === orbId));

const pass = !!myLandlet &&
  listedWhileFlyingOver.orbs.some((o) => o.orbId === orbId) &&
  !toastVisibleWhileFlying &&
  toastText.includes('credit') &&
  !listedAfterLandingOnIt.orbs.some((o) => o.orbId === orbId) &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: 'Credit orb: flying directly over it at altitude does not auto-collect it, only a real ground walk-in does (#2443)',
  errors,
});
