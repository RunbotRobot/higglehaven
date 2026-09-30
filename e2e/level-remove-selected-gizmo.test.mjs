// #1078: removing a level via #level-remove-btn prunes any swept instances
// directly (`deleteInstance`), but never detaches the Move/Rotate/Trim
// gizmo first — if the swept instance happens to be the one currently
// selected (the normal state right after placing it, see selectOnly() in
// handlePlacementClick), TransformControls is left attached to a mesh no
// longer in the scene graph and logs a console error on its next internal
// update. Confirmed via e2e/vertical-levels.test.mjs's own console-error
// check, which reproduces this exact shape.
import { launchPage, chooseIdentity, claimLandlet, grantLandCapHeadroomAsAdmin, finish } from './helpers.mjs';

const LABEL = 'Level Remove Selected Gizmo Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(500);

const builderId = await page.evaluate(() => fetch('/api/builders/me').then((r) => r.json()).then((body) => body.builder.builderId));
await grantLandCapHeadroomAsAdmin(builderId);

await page.click('#level-build-btn');
await page.waitForTimeout(800);
const labelAfterBuild = await page.textContent('#level-label');
console.log('level label after building up (should be Level +1):', labelAfterBuild);

// Place an item and leave it selected — the normal post-placement state
// (selectOnly() is called immediately after spawning), not a special setup.
await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').first().click();
await page.waitForTimeout(300);
await page.mouse.click(210, 400);
await page.waitForTimeout(800);

const modeControlsVisibleBeforeRemove = await page.locator('#gizmo-mode-controls').evaluate((el) => el.classList.contains('visible'));
console.log('gizmo mode controls visible after placing (should be true — item is selected):', modeControlsVisibleBeforeRemove);

// Remove the level the selected item is on — this is what swept-instance
// pruning used to leave the gizmo attached to a removed mesh for.
await page.click('#level-remove-btn');
await page.waitForTimeout(800);

const labelAfterRemove = await page.textContent('#level-label');
const modeControlsVisibleAfterRemove = await page.locator('#gizmo-mode-controls').evaluate((el) => el.classList.contains('visible'));
console.log('level label after removing Level +1 (should be Ground):', labelAfterRemove);
console.log('gizmo mode controls hidden after remove (should be false — selection cleared):', modeControlsVisibleAfterRemove);
console.log('page errors (should be none — TransformControls must not log against a detached mesh):', errors);

const pass =
  labelAfterBuild === 'Level +1' &&
  modeControlsVisibleBeforeRemove &&
  labelAfterRemove === 'Ground' &&
  !modeControlsVisibleAfterRemove &&
  errors.length === 0;
await finish(browser, { pass, label: 'Removing a level detaches the gizmo from a swept, selected instance (#1078)', errors });
