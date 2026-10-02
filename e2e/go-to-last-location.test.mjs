// #1176 (sub-issue of #1174, spawn flow): the "Go to Last Location" button
// shown during #1175's spawn orbit, offering to fly the shopper straight to
// their own last-reported avatar_presence position instead of waiting out
// the hands-off rotation. Three behaviors, each needing a real browser
// (DOM classList/opacity, the actual click, and the frontend's own
// report/poll loop actually writing the position back out):
//   1. no button at all on a genuinely fresh account (no row to offer)
//   2. the button fades out 5s after the shopper navigates on their own
//      instead of clicking it
//   3. clicking it fades the avatar out, teleports it above the seeded
//      last location, fades back in, and auto-lands there — confirmed by
//      reading the position back from the server once the client's own
//      report loop has had a chance to send it, not by guessing from the
//      client alone.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL = 'Last Location Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 10000 });
// #688/#1175: see e2e/flight.test.mjs's own identical comment — the spawn
// state (including whether a last location exists to show this button for)
// isn't settled until enterShopMode's post-fetch tail finishes.
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });

const lastLocationVisible = () => page.locator('#shop-last-location-btn.visible').count().then((n) => n > 0);

// 1. A genuinely fresh account has no avatar_presence row yet — no button.
const noButtonOnFreshAccount = !(await lastLocationVisible());

async function seedPresence(x, y, heading) {
  return page.evaluate(async ([px, py, pheading]) => {
    const res = await fetch('/api/presence', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ x: px, y: py, z: 0, heading: pheading }),
    });
    return res.status;
  }, [x, y, heading]);
}

async function reenterShop() {
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.waitForSelector('#shop-fly-btn.visible', { timeout: 10000 });
  await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });
}

// --- Phase 2: auto-hide 5s after navigating on its own ---
const seedStatusA = await seedPresence(12, -7, 0.3);
await reenterShop();
const visibleAfterSeedA = await lastLocationVisible();

// Simulate real navigation input via the on-screen move joystick (the
// same pointerdown/pointermove/pointerup gesture bindShopJoystick itself
// listens for) — a brief deflection and release is enough:
// stopShopSpawnRotationForNavigation fires once on the first nonzero
// reading, regardless of how long the deflection is held afterward.
const moveJoystickBox = await page.locator('#shop-move-joystick').boundingBox();
const moveCenterX = moveJoystickBox.x + moveJoystickBox.width / 2;
const moveCenterY = moveJoystickBox.y + moveJoystickBox.height / 2;
await page.mouse.move(moveCenterX, moveCenterY);
await page.mouse.down();
await page.mouse.move(moveCenterX + 25, moveCenterY, { steps: 5 });
await page.waitForTimeout(200);
await page.mouse.up();

await page.waitForTimeout(1000);
const stillVisibleUnder5s = await lastLocationVisible();
await page.waitForTimeout(4500); // total well past SHOP_LAST_LOCATION_BUTTON_HIDE_DELAY_S (5s)
const hiddenAfter5s = !(await lastLocationVisible());

// --- Phase 3: clicking it fades, teleports, lands at the seeded spot ---
const targetX = 31;
const targetY = -18;
const seedStatusB = await seedPresence(targetX, targetY, 1.1);
await reenterShop();
const visibleAfterSeedB = await lastLocationVisible();

await page.click('#shop-last-location-btn');
const hiddenImmediatelyAfterClick = !(await lastLocationVisible());

// SHOP_LAST_LOCATION_AVATAR_FADE_S (0.6s) fade-out + 0.6s fade-in +
// SHOP_FLIGHT_LANDING_DURATION_S (2s) landing, plus a generous buffer.
await page.waitForTimeout(4500);
const groundedAfterSequence = await page.evaluate(() => !document.body.classList.contains('shop-flying'));

// SHOP_PRESENCE_REPORT_INTERVAL_MS (1500ms) — give the client's own report
// loop a cycle to actually write the post-teleport position back out,
// the same "read the real server state back, don't trust the client
// alone" approach e2e/multiplayer-presence.test.mjs uses.
await page.waitForTimeout(2000);
const finalPresence = await page.evaluate(async () => {
  const res = await fetch('/api/presence/me');
  return (await res.json()).presence;
});
console.log('presence after the Go to Last Location sequence (should be near x:31 y:-18):', finalPresence);
const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1;

console.log('no button on a genuinely fresh account (should be true):', noButtonOnFreshAccount);
console.log('seed presence A status (should be 200):', seedStatusA);
console.log('button visible after seeding + reentering (phase 2, should be true):', visibleAfterSeedA);
console.log('button still visible under 5s after navigating (should be true):', stillVisibleUnder5s);
console.log('button hidden 5s+ after navigating, via fade (should be true):', hiddenAfter5s);
console.log('seed presence B status (should be 200):', seedStatusB);
console.log('button visible after seeding + reentering (phase 3, should be true):', visibleAfterSeedB);
console.log('button hidden immediately on click, no countdown (should be true):', hiddenImmediatelyAfterClick);
console.log('grounded again once the fade/teleport/fade/land sequence finishes (should be true):', groundedAfterSequence);

const pass =
  noButtonOnFreshAccount &&
  seedStatusA === 200 &&
  visibleAfterSeedA &&
  stillVisibleUnder5s &&
  hiddenAfter5s &&
  seedStatusB === 200 &&
  visibleAfterSeedB &&
  hiddenImmediatelyAfterClick &&
  groundedAfterSequence &&
  !!finalPresence && near(finalPresence.x, targetX) && near(finalPresence.y, targetY) &&
  errors.length === 0;

await finish(browser, { pass, label: 'Go to Last Location (#1176)', errors });
