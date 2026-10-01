// #1169 (owner request via Control Room): a small on-screen compass in
// Shop and Build modes, hidden in Sell (no free-look camera/avatar facing
// there to orient by — see SELL_HIDDEN_BUILDER_UI_IDS's own comment).
//
// Shop mode's needle is driven by shopAvatarFacing; Build mode has no
// avatar, so it's driven directly off the free OrbitControls camera's own
// current look direction instead. Neither mode's initial spawn facing is
// asserted to a specific value here (#1210: #1175's spawn flow gives Shop
// mode a random initial facing via its hands-off orbit, not a fixed 0/North
// the way it used to be — the Build-mode camera's own fixed start position
// is still deterministic, see its own comment below). Both modes instead
// confirm the needle actually tracks a real rotation (a canvas drag in
// Build, a move-joystick drag in Shop — the latter also doubles as the
// navigation input that stops Shop's spawn orbit), not just its own static
// initial value.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Compass Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

async function needleRotationDeg() {
  return page.evaluate(() => {
    const transform = document.getElementById('compass-needle').style.transform;
    const match = /rotate\(([-\d.]+)deg\)/.exec(transform);
    return match ? parseFloat(match[1]) : null;
  });
}

const compassVisibleInBuild = await page.locator('#compass-panel').isVisible();
console.log('compass visible in Build mode (should be true):', compassVisibleInBuild);

// The default Build camera starts at (0.6S, 0.6S, 0.5S) looking at the
// origin (src/main.js, module scope) — equal x/y offsets, so its initial
// look direction is an exact southwest diagonal regardless of landlet
// size, giving a clean, deterministic expected bearing rather than an
// arbitrary float: facing 0 (= +Y = "North", the convention inferred from
// the claim-flyover's own default camera placement — see
// updateCompassNeedle's own comment) means the needle points straight up
// (rotate(0deg)); southwest is -135deg from there.
const initialBuildRotation = await needleRotationDeg();
console.log('initial Build-mode needle rotation (should be ~-135, the default camera\'s southwest-facing look direction):', initialBuildRotation);

// A real pointer drag on the main canvas — OrbitControls' own default
// left-drag-to-orbit, the same interaction a builder actually uses to look
// around. Large and slow (several intermediate moves, like a real drag)
// so OrbitControls' damping has something unambiguous to settle toward.
const canvasBox = await page.locator('#app').boundingBox();
const startX = canvasBox.x + canvasBox.width / 2;
const startY = canvasBox.y + canvasBox.height / 2;
await page.mouse.move(startX, startY);
await page.mouse.down();
for (let i = 1; i <= 10; i++) {
  await page.mouse.move(startX + i * 30, startY, { steps: 2 });
}
await page.mouse.up();
await page.waitForTimeout(500); // let OrbitControls' damping settle

const rotatedBuildRotation = await needleRotationDeg();
console.log('Build-mode needle rotation after dragging the camera (should differ meaningfully from the initial value):', rotatedBuildRotation);

await page.click('.mode-nav-btn[data-mode="shop"]');
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 15000 });
const compassVisibleInShop = await page.locator('#compass-panel').isVisible();
console.log('compass visible in Shop mode (should be true):', compassVisibleInShop);
const initialShopRotation = await needleRotationDeg();
console.log('initial Shop-mode needle rotation (random — #1175\'s spawn orbit picks a random facing, not asserted to a specific value):', initialShopRotation);

// Drags the move joystick (left stick) from its base's own center toward
// (dxPx, dyPx) — mirrors bindShopJoystick's real pointerdown/move pair, the
// same idiom e2e/flight-direction-tilt.test.mjs already uses. The first
// drag is also navigation input (#1175's stopShopSpawnRotation), so it
// both ends the spawn orbit and turns the avatar to a new heading via the
// ordinary turn-ease. Two drags in clearly different directions (forward,
// then strafe-right — the same pair flight-direction-tilt.test.mjs uses)
// rather than comparing against the pre-drag spawn reading: that reading
// is random (see above), so a single before/after comparison could
// coincidentally land within any fixed tolerance of it by chance, while
// two independent, clearly-different manual headings can't.
async function dragMoveJoystick(dxPx, dyPx) {
  const box = await page.locator('#shop-move-joystick').boundingBox();
  const originX = box.x + box.width / 2;
  const originY = box.y + box.height / 2;
  await page.mouse.move(originX, originY);
  await page.mouse.down();
  await page.mouse.move(originX + dxPx, originY + dyPx, { steps: 5 });
  await page.waitForTimeout(500); // past SHOP_AVATAR_TURN_EASE_PER_S's own convergence window
  await page.mouse.up();
}

await dragMoveJoystick(0, -40); // forward
const shopRotationForward = await needleRotationDeg();
await dragMoveJoystick(40, 0); // strafe right — a clearly different heading
const shopRotationRight = await needleRotationDeg();
console.log('Shop-mode needle rotation facing forward (diagnostic only):', shopRotationForward);
console.log('Shop-mode needle rotation facing right (should differ meaningfully from facing forward):', shopRotationRight);

await page.click('button[data-mode="sell"]');
await page.waitForTimeout(500);
const compassHiddenInSell = await page.locator('#compass-panel').isHidden();
console.log('compass hidden in Sell mode (should be true):', compassHiddenInSell);

const near = (actual, expected, tolerance) => typeof actual === 'number' && Math.abs(actual - expected) < tolerance;
// Shortest signed angular distance in degrees — handles the wraparound a
// plain subtraction gets wrong (e.g. 179 vs -179 is 2 degrees apart, not
// 358), the same reasoning flight-direction-tilt.test.mjs's own
// shortestAngleDeltaRad applies in radians.
const angleDeltaDeg = (a, b) => Math.abs(((a - b + 180) % 360 + 360) % 360 - 180);

const pass =
  compassVisibleInBuild &&
  near(initialBuildRotation, -135, 0.1) &&
  typeof rotatedBuildRotation === 'number' &&
  Math.abs(rotatedBuildRotation - initialBuildRotation) > 5 &&
  compassVisibleInShop &&
  typeof initialShopRotation === 'number' &&
  typeof shopRotationForward === 'number' &&
  typeof shopRotationRight === 'number' &&
  angleDeltaDeg(shopRotationRight, shopRotationForward) > 30 &&
  compassHiddenInSell &&
  errors.length === 0;
await finish(browser, { pass, label: 'On-screen compass: Shop/Build visibility, Sell hidden, needle tracks facing (#1169)', errors });
