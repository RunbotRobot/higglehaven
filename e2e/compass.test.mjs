// #1169 (owner request via Control Room): a small on-screen compass in
// Shop and Build modes, hidden in Sell (no free-look camera/avatar facing
// there to orient by — see SELL_HIDDEN_BUILDER_UI_IDS's own comment).
//
// Shop mode's needle is driven by shopAvatarFacing; Build mode has no
// avatar, so it's driven directly off the free OrbitControls camera's own
// current look direction instead. Real
// joystick-driven turning in Shop mode isn't exercised here — raw Shop-mode
// movement/camera simulation isn't automated anywhere in this suite (see
// e2e/community-signs.test.mjs's own comment on why) — but Build mode's
// camera responds to an ordinary pointer drag on the main canvas, which
// *is* reliably testable, so that's used to confirm the needle actually
// tracks a real camera rotation, not just its own static initial value.
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
// #1175: every Shop-mode entry now spawns at a random world location
// facing the world center, rather than always resetting shopAvatarFacing
// to a fixed 0/North — so the exact bearing varies run to run (confirmed
// non-deterministic: two separate local runs read -135.16 and -244.185
// here). The needle-tracks-facing behavior itself is already demonstrated
// by the Build-mode drag-and-compare above; this just confirms the needle
// renders a real numeric bearing in Shop mode too.
const initialShopRotation = await needleRotationDeg();
console.log('initial Shop-mode needle rotation (should be a real number, exact bearing is spawn-random since #1175):', initialShopRotation);

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
  typeof initialShopRotation === 'number' &&
  compassHiddenInSell &&
  errors.length === 0;
await finish(browser, { pass, label: 'On-screen compass: Shop/Build visibility, Sell hidden, needle tracks facing (#1169)', errors });
