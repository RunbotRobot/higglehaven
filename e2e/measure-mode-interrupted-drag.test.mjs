// #1894: exitMeasureMode's own defensive mid-drag cleanup used to reset
// controls.enabled -- a stale leftover from the pre-#1593 approach -- instead
// of controls.enableRotate, the flag a measure-marker drag actually disables
// (see endMeasureMarkerDrag's own restore). Reachable on a touch device: one
// finger mid-drag on a marker (pointerup never fires) while a second finger
// starts a placement flow, which calls exitMeasureMode while
// draggingMeasureMarker is still set. Simulated here via
// window.__testStartMeasureMarkerDrag (see its own comment in src/main.js)
// rather than raycasting a real hit on the marker's 3D hitbox, which isn't a
// practical target from a test.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Measure Drag Interrupt Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(500);

await page.click('#toggle-measure');
await page.waitForFunction(() => document.getElementById('toggle-measure').classList.contains('active'));

await page.evaluate(() => window.__testStartMeasureMarkerDrag());
const enableRotateMidDrag = await page.evaluate(() => window.__testControlsEnableRotate());
console.log('controls.enableRotate while mid-drag (should be false):', enableRotateMidDrag);

// A placement flow starting mid-drag is what calls exitMeasureMode's own
// defensive cleanup branch -- the pointerup that would normally restore
// enableRotate via endMeasureMarkerDrag never fires in this scenario.
// Matches measure-mode.test.mjs's own "direction 1": picking a catalog item
// is what actually calls enterPlacementMode -> exitMeasureMode, not just
// opening the picker.
await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').first().click();
await page.waitForTimeout(300);
const measureActiveAfterInterrupt = await page.locator('#toggle-measure').evaluate((el) => el.classList.contains('active'));
const enableRotateAfterInterrupt = await page.evaluate(() => window.__testControlsEnableRotate());
console.log('Measure mode exited by the interrupting placement flow (should be false):', measureActiveAfterInterrupt);
console.log('controls.enableRotate restored after the interrupted drag (should be true):', enableRotateAfterInterrupt);

const pass =
  enableRotateMidDrag === false &&
  measureActiveAfterInterrupt === false &&
  enableRotateAfterInterrupt === true &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: 'exitMeasureMode restores controls.enableRotate (not controls.enabled) when it interrupts a mid-drag (#1894)',
  errors,
});
