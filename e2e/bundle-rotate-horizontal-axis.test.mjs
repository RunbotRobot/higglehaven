// #3371: tilting a bundle about a horizontal axis follows the requested angle
// through the real gizmo path (every turn is applied, none dropped), stays
// inside the lándlet's level range, and the follow-up save is accepted (no
// failed request). Each gesture starts from the previous result, so three 20
// degree turns walk a bundle through 20/40/60 degrees on each horizontal axis.
// The re-seat geometry itself (lift onto the floor, slide in from an edge,
// refuse only when the bundle is bigger than the range) is covered by the unit
// tests in src/build/bundleRotation.test.js.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Bundle Tilt Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(500);

async function placeTreeAt(x, y) {
  await page.click('#add-item-btn');
  await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
  await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
  await page.waitForTimeout(300);
  await page.mouse.click(x, y);
  await page.waitForTimeout(800);
}
await placeTreeAt(160, 380);
await placeTreeAt(260, 380);
await page.mouse.click(60, 550);
await page.waitForTimeout(300);
const [posA, posB] = await page.evaluate(() => window.__testProductScreenPositions());
await page.click('#toggle-multiselect');
await page.waitForTimeout(200);
await page.mouse.click(posA.x, posA.y);
await page.waitForTimeout(150);
await page.mouse.click(posB.x, posB.y);
await page.waitForTimeout(300);
await page.click('#group-item');
await page.waitForTimeout(800);
await page.click('#mode-rotate');
await page.waitForTimeout(400);

let allOk = true;
for (const axis of ['x', 'y']) {
  for (const step of [1, 2, 3]) {
    const deg = 20;
    const rad = (deg * Math.PI) / 180;
    await page.evaluate(([a, r]) => window.__testRotateBundle(a, r), [axis, rad]);
    const r = await page.evaluate(() => window.__testBundleRotateResult());
    const ok = Math.abs(r.appliedRadians - rad) < 0.01 && r.lowestZ >= Math.max(r.floorZ, r.levelRange.minZ) - 1e-6 && r.highestZ <= r.levelRange.maxZ + 1e-6;
    console.log(`axis ${axis} turn ${step} (${deg} deg): applied ${r.appliedRadians.toFixed(3)} (want ${rad.toFixed(3)}), lowestZ ${r.lowestZ.toFixed(3)} >= floor ${r.floorZ}:`, ok);
    allOk = allOk && ok;
  }
}
await finish(browser, { pass: allOk && errors.length === 0, label: '#3371: horizontal-axis bundle tilt follows the requested angle and stays above the floor', errors });
