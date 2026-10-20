// #2447: a sustained genuine network failure (not a single dropped frame)
// collecting a credit orb used to retry forever in total silence --
// updateCreditOrbs's catch handler only ever distinguished 403/404 from
// "everything else," and "everything else" always just quietly retried,
// with no way for a shopper to tell a brief blip apart from a real outage.
// Reproduces the real failure shape route.abort('failed') gives -- the
// same idiom e2e/connectivity-indicator.test.mjs uses -- rather than a 429/
// 500, which is a real HTTP response and deliberately does NOT trigger this
// notice (see updateCreditOrbs's own #2447 comment).
import { launchPage, chooseIdentity, createGreenbeltLandletAsAdmin, seedCreditOrbAsAdmin, finish } from './helpers.mjs';

const LABEL = 'Credit Orb Offline Notice Tester';
const LANDLET_ID = `credit-orb-offline-e2e-${Date.now()}`;
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

// #1445: a brief real joystick deflection breaks Shop mode's own hands-off
// spawn orbit, freeing shopAvatarPosition for the teleport hook to drive --
// same sequence e2e/credit-orb-collect.test.mjs/credit-orb-survives-rate-limit.test.mjs use.
const moveJoystickBox = await page.locator('#shop-move-joystick').boundingBox();
const moveCenterX = moveJoystickBox.x + moveJoystickBox.width / 2;
const moveCenterY = moveJoystickBox.y + moveJoystickBox.height / 2;
await page.mouse.move(moveCenterX, moveCenterY);
await page.mouse.down();
await page.mouse.move(moveCenterX + 25, moveCenterY, { steps: 5 });
await page.waitForTimeout(100);
await page.mouse.up();
await page.waitForTimeout(100);

const noticeHiddenBeforeAnyFailure = !(await page.isVisible('#shop-credit-orb-offline-notice.visible'));
console.log('offline notice hidden before any collect attempt (should be true):', noticeHiddenBeforeAnyFailure);

// Genuinely unreachable, not just a rejecting HTTP response -- aborting the
// route makes the page's own fetch() reject with a TypeError, exactly what
// isNetworkError (src/main.js) checks for, same as connectivity-indicator's
// own simulated outage.
let abortedCollectAttempts = 0;
await page.route('**/api/credit-orbs/*/collect', (route) => {
  abortedCollectAttempts += 1;
  return route.abort('failed');
});

const orbWorldX = myLandlet.center.x + ORB_X;
const orbWorldY = myLandlet.center.y + ORB_Y;
await page.evaluate(([x, y]) => {
  window.__testTeleportShopAvatar(x, y);
  window.__testForceShopProximityCheck();
}, [orbWorldX, orbWorldY]);

// Standing on the orb for well under CREDIT_ORB_OFFLINE_NOTICE_THRESHOLD_MS
// (3000ms) -- a brief failure streak shouldn't flash the notice yet.
await page.waitForTimeout(1200);
console.log('route actually intercepted at least one real collect attempt (should be true):', abortedCollectAttempts > 0);
const noticeHiddenDuringBriefOutage = !(await page.isVisible('#shop-credit-orb-offline-notice.visible'));
console.log('offline notice still hidden well under the threshold (should be true):', noticeHiddenDuringBriefOutage);

const activeDuringOutage = await page.evaluate(() => window.__testActiveCreditOrbIds());
console.log('orb survives the outage instead of vanishing (should be true):', activeDuringOutage.includes(orbId));

// Past the threshold now -- the sustained streak should surface the notice.
await page.waitForTimeout(2500);
const noticeVisibleAfterSustainedOutage = await page.isVisible('#shop-credit-orb-offline-notice.visible');
console.log('offline notice visible after a sustained network failure (should be true):', noticeVisibleAfterSustainedOutage);

// Connectivity returns -- the very next successful collect should clear it,
// with no special recovery action needed from the shopper.
await page.unroute('**/api/credit-orbs/*/collect');
await page.waitForTimeout(1500);

const toastVisibleAfterRecovery = await page.isVisible('#shop-credit-orb-toast.visible');
console.log('collect-confirmation toast shown once the outage clears (should be true):', toastVisibleAfterRecovery);

const noticeHiddenAfterRecovery = !(await page.isVisible('#shop-credit-orb-offline-notice.visible'));
console.log('offline notice hidden again once a collect succeeds (should be true):', noticeHiddenAfterRecovery);

const activeAfterRecovery = await page.evaluate(() => window.__testActiveCreditOrbIds());
console.log('orb actually collected (removed from the scene) after recovery (should be false, i.e. gone):', activeAfterRecovery.includes(orbId));

// The aborted requests above are a deliberate, real network-level failure
// (the whole point of this test), and Chromium logs that to the console
// independent of anything this app's own code does -- same expected
// fallout e2e/connectivity-indicator.test.mjs's own comment documents.
const unexpectedErrors = errors.filter((e) => !e.includes('net::ERR_FAILED'));

const pass = !!myLandlet &&
  noticeHiddenBeforeAnyFailure &&
  abortedCollectAttempts > 0 &&
  noticeHiddenDuringBriefOutage &&
  activeDuringOutage.includes(orbId) &&
  noticeVisibleAfterSustainedOutage &&
  toastVisibleAfterRecovery &&
  noticeHiddenAfterRecovery &&
  !activeAfterRecovery.includes(orbId) &&
  unexpectedErrors.length === 0;
await finish(browser, {
  pass,
  label: 'Credit-orb collection shows/hides an offline notice across a sustained network failure instead of retrying in total silence (#2447)',
  errors: unexpectedErrors,
});
