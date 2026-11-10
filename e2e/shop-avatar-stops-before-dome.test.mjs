// #3374: at the edge of the world the camera stopped but the avatar kept
// flying and was cut by the dome. The avatar is the thing that is bounded: its
// whole body, tipped forward in flight, has to stay inside the dome at its own
// height, and the follow camera stays within chase range of it.
//
// Flies outward at ordinary altitude and again after climbing, then reads the
// avatar's real world bounding box (window.__shopAvatarBoundsDebug) and checks
// its farthest corner against the dome's cross-section radius at that corner's
// height, independent of the clamp's own formula.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL = 'Avatar Dome Edge Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });
await page.setViewportSize({ width: 390, height: 844 });
await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 20000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 20000 });

const joystick = await page.locator('#shop-move-joystick').boundingBox();
const originX = joystick.x + joystick.width / 2;
const originY = joystick.y + joystick.height / 2;

// Chase distance is camera-to-anchor (the follow rig orbits the avatar's
// camera anchor point, not its feet), so it is rebuilt here from the pivot.
const boundsDebug = () => page.evaluate(() => {
  const bounds = window.__shopAvatarBoundsDebug();
  const ceiling = window.__shopFlightCeilingDebug;
  bounds.anchorToCameraM = Math.hypot(
    bounds.cameraXM - ceiling.avatarX, bounds.cameraYM - ceiling.avatarY, bounds.cameraZM - (ceiling.avatarZ + window.__shopAvatarMetrics.cameraAnchorHeightM),
  );
  return bounds;
});

async function flyOutward(ms) {
  await page.mouse.move(originX, originY);
  await page.mouse.down();
  await page.mouse.move(originX, originY - joystick.height / 2, { steps: 5 });
  await page.waitForTimeout(ms);
  const first = await boundsDebug();
  await page.waitForTimeout(2000); // keep pushing: it must have stopped
  const second = await boundsDebug();
  await page.mouse.up();
  return { first, second };
}

const low = await flyOutward(9000);
console.log('low altitude, at the edge:', JSON.stringify(low.second));
const lowMargin = low.second.farthest.marginM;
const lowStopped = Math.abs(low.second.pivotRadiusM - low.first.pivotRadiusM) < 0.5;
console.log(`low: body margin inside dome (>= 0): ${lowMargin.toFixed(2)}, stopped moving outward: ${lowStopped}, camera-to-anchor distance: ${low.second.anchorToCameraM.toFixed(2)}`);

// Climb (the avatar spawns already near the ceiling, so this holds it there), then fly outward again.
const upBox = await page.locator('#shop-up-btn').boundingBox();
await page.mouse.move(upBox.x + upBox.width / 2, upBox.y + upBox.height / 2);
await page.mouse.down();
await page.waitForTimeout(6000);
await page.mouse.up();
const high = await flyOutward(9000);
console.log('high altitude, at the edge:', JSON.stringify(high.second));
const highMargin = high.second.farthest.marginM;
const highStopped = Math.abs(high.second.pivotRadiusM - high.first.pivotRadiusM) < 0.5;
console.log(`high: body margin inside dome (>= 0): ${highMargin.toFixed(2)}, stopped moving outward: ${highStopped}, camera-to-anchor distance: ${high.second.anchorToCameraM.toFixed(2)}`);

const CHASE_RANGE_M = 4.2 + 0.1; // the follow distance, with float slack
const pass = lowMargin >= -0.05 && highMargin >= -0.05 && lowStopped && highStopped
  && low.second.anchorToCameraM <= CHASE_RANGE_M && high.second.anchorToCameraM <= CHASE_RANGE_M
  && errors.length === 0;
await finish(browser, {
  pass,
  label: '#3374: at the edge of the world the avatar stops with its whole body inside the dome, and the camera stays in chase range',
  errors,
});
