// #1588 (owner request): an opt-in setting so the free-look camera eases
// back to match the avatar's own facing instead of staying fully
// independent forever (updateShopMovement's existing comment on that
// independence is the baseline — this setting is the opt-in exception to
// it, not a change to the default). Off by default; when on, and only
// while the shopper isn't actively steering the look stick, shopYaw eases
// toward shopAvatarFacing per SHOP_CAMERA_LOCK_TO_FACING_EASE_PER_S.
//
// Three.js orientation math with no unit-test pool to live in
// (vitest.config.js's own note), so this is e2e, same idiom as
// flight-direction-tilt.test.mjs/compass.test.mjs: drive a real joystick
// drag to turn the avatar's facing away from the camera's current heading,
// then confirm the camera (a) stays put with the setting off and (b) eases
// to match with it on.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const { browser, page, errors } = await launchPage({ promptAnswer: 'Camera Lock Tester' });

await chooseIdentity(page, { mode: 'shop', label: 'Camera Lock Tester', isNew: true });
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 10000 });

function shortestAngleDeltaRad(a, b) {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

async function dragMoveJoystick(dxPx, dyPx) {
  const box = await page.locator('#shop-move-joystick').boundingBox();
  const originX = box.x + box.width / 2;
  const originY = box.y + box.height / 2;
  await page.mouse.move(originX, originY);
  await page.mouse.down();
  await page.mouse.move(originX + dxPx, originY + dyPx, { steps: 5 });
  await page.waitForTimeout(400); // past SHOP_AVATAR_TURN_EASE_PER_S's own convergence window
  await page.mouse.up();
}

async function orientation() {
  return page.evaluate(() => ({
    facingRad: window.__shopAvatarOrientation?.facingRad,
    cameraYaw: window.__shopCameraYaw,
  }));
}

// Setting starts off (default localStorage) — strafe to turn the avatar
// well away from the camera's current heading, then confirm the camera's
// own yaw does NOT follow it.
await dragMoveJoystick(40, 0); // strafe right — turns facing ~90deg from the camera's current forward
const offOrientation = await orientation();
await page.waitForTimeout(1000); // give a (buggy) camera-follow plenty of time to show up if it existed
const offOrientationAfterWait = await orientation();
const offDivergenceRad = Math.abs(shortestAngleDeltaRad(offOrientation.facingRad, offOrientation.cameraYaw));
const offCameraStayedPutRad = Math.abs(shortestAngleDeltaRad(offOrientationAfterWait.cameraYaw, offOrientation.cameraYaw));
console.log('facing/camera divergence with the setting off, radians (should be well above 0):', offDivergenceRad);
console.log('camera yaw drift over 1s with the setting off (should be ~0 -- camera must not follow facing):', offCameraStayedPutRad);

// Turn on the setting (read live from localStorage every frame, no reload
// needed), strafe the opposite way to create a fresh, clearly-nonzero
// divergence, then confirm the camera eases to close it.
await page.evaluate(() => localStorage.setItem('higglehaven.shopCameraLockToFacing', '1'));
await dragMoveJoystick(-40, 0); // strafe left — a fresh, clearly different heading from the off-test above
const onOrientationJustAfterTurn = await orientation();
const onDivergenceJustAfterTurn = Math.abs(shortestAngleDeltaRad(onOrientationJustAfterTurn.facingRad, onOrientationJustAfterTurn.cameraYaw));
console.log('facing/camera divergence right after turning (should be well above 0 -- same as the off case, a real gap to close):', onDivergenceJustAfterTurn);

await page.waitForTimeout(1500); // past SHOP_CAMERA_LOCK_TO_FACING_EASE_PER_S's own convergence window
const onOrientationAfterEase = await orientation();
const onDivergenceAfterEase = Math.abs(shortestAngleDeltaRad(onOrientationAfterEase.facingRad, onOrientationAfterEase.cameraYaw));
console.log('facing/camera divergence after easing with the setting on (should be close to 0 -- camera caught up to facing):', onDivergenceAfterEase);

const pass =
  offDivergenceRad > 0.5 &&
  offCameraStayedPutRad < 0.05 &&
  onDivergenceJustAfterTurn > 0.5 &&
  onDivergenceAfterEase < 0.1 &&
  errors.length === 0;
await finish(browser, { pass, label: 'Shop camera-lock-to-facing setting: off leaves free-look independent, on eases the camera to match facing (#1588)', errors });
