// #1642: owner-free-standing backlog finding -- rebuildCalendarSprites and
// rebuildReviewSprites (src/main.js) still had the exact bug #1594 already
// fixed one function over in rebuildSignSprites: each sprite's z was
// computed as `mesh.position.z + baseHeight + 0.4 + i * 0.5`, but
// mesh.position.z is the mesh's own vertical *center*, per this codebase's
// ground-rest convention (createMeshForInstance sets position.z =
// height / 2 by default; supportZ/itemZMax elsewhere in src/main.js both
// compute a mesh's top surface the same way, as
// `mesh.position.z + height / 2`). Adding the *full* height instead of
// half overshot the actual top surface by another half-height, floating
// calendar-event and review text a full half-model-height above the model
// instead of just above its surface -- same symptom #1594 fixed for
// community-sign posts, just never propagated to these two copy-pasted
// siblings.
//
// Mirrors e2e/community-sign-mount-offset.test.mjs's own real-in-world-
// render verification approach (rather than just re-deriving the already-
// fixed formula in isolation): teleport-and-force-proximity into Shop mode
// load range, then read the new window.__lastCalendarSpriteDebug/
// __lastReviewSpriteDebug hooks (added alongside this fix, same
// "expose computed state purely for verification" convention as
// window.__lastSignSpriteDebug).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, finish, emailForLabel, grantAdmin } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

const LABEL = 'Calendar Review Mount Offset Tester';
const PRODUCT_NAME = 'Mount Offset Reviewable Product';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

async function fetchJson(path, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [path, options]);
}

// Place a tree, flag it as a community calendar, and leave an event --
// placeholder-tree has no modelUrl (migrations/0001_initial.sql), so this
// resolves synchronously via the plain-box fallback, same reasoning
// community-sign-mount-offset.test.mjs's own header comment gives.
await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
await page.waitForTimeout(300);
await page.mouse.click(210, 400);
await page.waitForTimeout(800);
await page.click('#toggle-community-calendar');
await page.waitForTimeout(500);

const { landlets } = (await fetchJson('/api/landlets?limit=100')).body;
const myLandlet = landlets.find((l) => l.ownerBuilderId);
const { instances } = (await fetchJson(`/api/instances?landletId=${myLandlet.landletId}`)).body;
const calendarInstance = instances.find((i) => i.templateId === 'placeholder-tree');

await fetchJson(`/api/instances/${calendarInstance.instanceId}/events`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: 'Bonfire night, Friday 8pm!' }),
});

// Upload a product, purchase it, and leave a review -- same setup
// e2e/product-reviews.test.mjs's own header comment describes.
await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForTimeout(300);
await page.click('#upload-model-btn');
await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });
await page.fill('#upload-name', PRODUCT_NAME);
await page.fill('#upload-price', '10');
await page.setInputFiles('#upload-file-input', CRATE_MODEL_PATH);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-step-dimensions').hidden, null, { timeout: 45000 });
await page.waitForTimeout(300);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), null, { timeout: 45000 });
await page.waitForTimeout(500);
await page.click('#seller-close-btn');
await page.waitForTimeout(300);

const { templates } = (await fetchJson('/api/catalog?limit=100')).body;
const template = templates.find((t) => t.name === PRODUCT_NAME);
const reviewInstanceId = 'mount-offset-review-instance';
await fetchJson('/api/instances', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ instanceId: reviewInstanceId, landletId: myLandlet.landletId, templateId: template.templateId, x: 5, y: 5 }),
});
// #653: the simulated path is now admin-only (this seller hasn't
// completed Stripe Connect onboarding) — grant it to this same
// browser-session account rather than switching to a separate one, so
// this purchase still lands against the product/landlet this test
// already built up under this session's own cookie.
await grantAdmin(emailForLabel(LABEL));
await fetchJson(`/api/instances/${reviewInstanceId}/purchase`, { method: 'POST' });
await fetchJson(`/api/catalog/${template.templateId}/reviews`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ rating: 5, text: 'Lovely product!' }),
});

await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: false });
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 10000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });

// #1445: a brief real joystick deflection breaks Shop-mode's own hands-off
// spawn orbit, freeing shopAvatarPosition for the teleport hook below to
// actually drive (see community-sign-mount-offset.test.mjs's own comment).
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

// #2143: waitForFunction's signature is (pageFunction, arg, options) --
// the explicit null reaches the options slot; without it the timeout
// below silently fell back to Playwright's actual default (30000ms).
await page.waitForFunction(
  () => (window.__lastCalendarSpriteDebug?.spriteZs?.length ?? 0) > 0 && (window.__lastReviewSpriteDebug?.spriteZs?.length ?? 0) > 0,
  null,
  { timeout: 30000 },
);

const calendarDebug = await page.evaluate(() => window.__lastCalendarSpriteDebug);
const reviewDebug = await page.evaluate(() => window.__lastReviewSpriteDebug);
console.log('calendar mesh z / measured height / event sprite z values:', calendarDebug);
console.log('review mesh z / measured height / review sprite z values:', reviewDebug);

function checkFirstSpriteZ(debug, label) {
  const expectedTopSurfaceZ = debug.meshZ + debug.meshHeight / 2;
  const expectedFirstSpriteZ = expectedTopSurfaceZ + 0.4;
  const buggyFirstSpriteZ = debug.meshZ + debug.meshHeight + 0.4;
  const firstSpriteZ = debug.spriteZs[0];
  console.log(`${label} first sprite z (should be ~${expectedFirstSpriteZ}, just above the real top surface ~${expectedTopSurfaceZ} -- NOT the pre-fix ~${buggyFirstSpriteZ}):`, firstSpriteZ);
  // The buggy and fixed values are exactly meshHeight / 2 apart -- as long
  // as that gap is itself bigger than the equality tolerance below (true
  // for any mesh with real height), pinning firstSpriteZ to the fixed
  // value already rules out the buggy one, without needing a separate,
  // model-size-dependent magic-number threshold (the sign test's own ">1"
  // check happened to hold for its particular 4-unit-tall tree, but not
  // for this file's shorter review-product mesh).
  return Math.abs(firstSpriteZ - expectedFirstSpriteZ) < 0.001 && Math.abs(firstSpriteZ - buggyFirstSpriteZ) > 0.001;
}

const calendarOk = checkFirstSpriteZ(calendarDebug, 'calendar event');
const reviewOk = checkFirstSpriteZ(reviewDebug, 'product review');

const pass = calendarOk && reviewOk && errors.length === 0;
await finish(browser, {
  pass,
  label: '#1642: calendar-event and product-review sprites sit just above the model\'s real top surface, not hovering a full extra half-height above it',
  errors,
});
