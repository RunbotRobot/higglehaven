// #2264: updateCreditOrbs's collect-request catch handler only special-cased
// a 403 (presence not caught up yet, #2222) as "transient, leave the orb in
// place" -- every other failure, including a 429 from
// CREDIT_ORB_COLLECT_RATE_LIMIT_MAX (#2092), fell through to the same
// branch as a real 404 (someone else collected it first) and removed the
// orb from the scene. Since loadCreditOrbsForLandlet only ever fetches a
// landlet's orbs once, a wrongly-removed orb was gone from that session's
// view for good. This exhausts the builder's own rate-limit bucket first
// (same shape as worker/credit-orbs.test.js's own rate-limit test), then
// walks onto a real orb and confirms it survives the resulting 429 instead
// of vanishing -- using window.__testActiveCreditOrbIds (#2264) since
// shopCreditOrbs isn't otherwise observable from a test.
import { launchPage, chooseIdentity, createGreenbeltLandletAsAdmin, seedCreditOrbAsAdmin, finish } from './helpers.mjs';

const LABEL = 'Credit Orb Rate Limit Tester';
const LANDLET_ID = `credit-orb-ratelimit-e2e-${Date.now()}`;
const ORB_X = 2;
const ORB_Y = -1;

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await createGreenbeltLandletAsAdmin(LANDLET_ID, { areaM2: 1000 });
const orbId = await seedCreditOrbAsAdmin(LANDLET_ID, { x: ORB_X, y: ORB_Y });

async function fetchJson(path, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [path, options]);
}

await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 10000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });

const { body: { landlets } } = await fetchJson('/api/landlets?limit=100');
const myLandlet = landlets.find((l) => l.landletId === LANDLET_ID);
console.log('seeded landlet found via the API (should be true):', !!myLandlet);

// Exhaust CREDIT_ORB_COLLECT_RATE_LIMIT_MAX (20 per 15-minute window, #2092)
// against a bogus orb id first, same as worker/credit-orbs.test.js's own
// "rate-limits repeated collect attempts" test -- a 404 still counts
// against the bucket.
let lastStatus;
for (let i = 0; i < 20; i += 1) {
  const { status } = await fetchJson('/api/credit-orbs/not-a-real-orb/collect', { method: 'POST' });
  lastStatus = status;
}
console.log('bucket exhausted via 20 bogus attempts (last status should be 404):', lastStatus);
const confirmLimited = await fetchJson('/api/credit-orbs/not-a-real-orb/collect', { method: 'POST' });
console.log('21st attempt confirms the bucket is exhausted (should be 429):', confirmLimited.status);

// #1445: a brief real joystick deflection breaks Shop mode's own hands-off
// spawn orbit, freeing shopAvatarPosition for the teleport hook to drive --
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

await page.evaluate(([x, y]) => {
  window.__testTeleportShopAvatar(x, y);
  window.__testForceShopProximityCheck();
}, [myLandlet.center.x, myLandlet.center.y]);
await page.waitForTimeout(500);

const activeBeforeWalkingOver = await page.evaluate(() => window.__testActiveCreditOrbIds());
console.log('orb present in the scene before walking onto it (should be true):', activeBeforeWalkingOver.includes(orbId));

// Walk exactly onto the orb's own world position, well within
// CREDIT_ORB_COLLECT_RADIUS_M -- the resulting collect attempt will 429
// since the bucket above is already exhausted.
const orbWorldX = myLandlet.center.x + ORB_X;
const orbWorldY = myLandlet.center.y + ORB_Y;
await page.evaluate(([x, y]) => {
  window.__testTeleportShopAvatar(x, y);
  window.__testForceShopProximityCheck();
}, [orbWorldX, orbWorldY]);
await page.waitForTimeout(1000);

const toastVisible = await page.isVisible('#shop-credit-orb-toast.visible');
console.log('no collect-confirmation toast shown (should be true, the 429 never succeeded):', !toastVisible);

const activeAfterFailedCollect = await page.evaluate(() => window.__testActiveCreditOrbIds());
console.log('orb still present in the scene after the 429 (should be true, was the #2264 bug -- used to vanish):', activeAfterFailedCollect.includes(orbId));

const listedOnServer = await fetchJson(`/api/credit-orbs?landletId=${encodeURIComponent(LANDLET_ID)}`);
console.log('orb still active server-side (should be true, the 429 never actually collected it):', listedOnServer.body.orbs.some((o) => o.orbId === orbId));

// The deliberate 404s/429s above are real, expected HTTP error responses --
// Chromium logs each one to the console as "Failed to load resource"
// independent of anything this app's own code does, the same expected
// fallout e2e/seller-feedback.test.mjs's own comment documents filtering out.
const unexpectedErrors = errors.filter((e) => !e.includes('Failed to load resource'));

const pass = !!myLandlet &&
  confirmLimited.status === 429 &&
  activeBeforeWalkingOver.includes(orbId) &&
  !toastVisible &&
  activeAfterFailedCollect.includes(orbId) &&
  listedOnServer.body.orbs.some((o) => o.orbId === orbId) &&
  unexpectedErrors.length === 0;
await finish(browser, {
  pass,
  label: 'Credit orb survives a rate-limited (429) collect attempt instead of vanishing from the scene (#2264)',
  errors,
});
