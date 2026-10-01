// #1169 (owner request via Control Room): a small on-screen compass in
// Shop and Build modes, hidden in Sell (no free-look camera/avatar facing
// there to orient by — see SELL_HIDDEN_BUILDER_UI_IDS's own comment).
//
// Shop mode's needle is driven by shopAvatarFacing; Build mode has no
// avatar, so it's driven directly off the free OrbitControls camera's own
// current look direction instead. Real joystick-driven turning in Shop
// mode isn't exercised here — raw Shop-mode movement/camera simulation
// isn't automated anywhere in this suite (see e2e/community-signs.test.mjs's
// own comment on why) — but Build mode's camera responds to an ordinary
// pointer drag on the main canvas, which *is* reliably testable, so that's
// used to confirm the needle actually tracks a real camera rotation, not
// just its own static initial value.
//
// #1175 (landed after this file did, same spawn-flow tracking issue as
// #1176): every Shop-mode spawn now picks a random location and faces the
// world center from there, rather than always resetting shopAvatarFacing
// to a fixed 0/North — so the needle's own initial Shop-mode bearing is no
// longer a fixed, predictable value either. Checked for "is a real finite
// bearing at all" (confirms the needle is actually reading shopAvatarFacing
// in Shop mode, the actual thing #1169 asked for) rather than a specific
// angle.
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
console.log('initial Shop-mode needle rotation is a real finite bearing (#1175: spawn facing is now random, not a fixed 0):', initialShopRotation);

await page.click('button[data-mode="sell"]');
await page.waitForTimeout(500);
const compassHiddenInSell = await page.locator('#compass-panel').isHidden();
console.log('compass hidden in Sell mode (should be true):', compassHiddenInSell);

const near = (actual, expected, tolerance) => typeof actual === 'number' && Math.abs(actual - expected) < tolerance;

const pass =
  compassVisibleInBuild &&
  near(initialBuildRotation, -135, 0.1) &&
  typeof rotatedBuildRotation === 'number' &&
  Math.abs(rotatedBuildRotation - initialBuildRotation) > 5 &&
  compassVisibleInShop &&
  typeof initialShopRotation === 'number' && Number.isFinite(initialShopRotation) &&
  compassHiddenInSell &&
  errors.length === 0;
await finish(browser, { pass, label: 'On-screen compass: Shop/Build visibility, Sell hidden, needle tracks facing (#1169)', errors });
