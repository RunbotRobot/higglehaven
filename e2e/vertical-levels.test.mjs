// Vertical construction — Build-mode UI (issue #169, sub-issue of #167's
// tracking issue). The data model/API (#168) and the cap-cost math itself
// are covered by worker/land.test.js's own "Landlet levels" tests; this
// covers only the real frontend flow this issue adds: digging down/
// building up a level through #level-controls, navigating between
// already-built levels, the cap-cost preview shown before committing, and
// that a level (and an item placed on it) survives a reload.
import { launchPage, chooseIdentity, claimLandlet, grantLandCapHeadroomAsAdmin, finish } from './helpers.mjs';

const LABEL = 'Vertical Levels Suite Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(500);

// #489: land cap now gates adding a level, and a freshly-claimed builder's
// owned area already equals their default cap exactly — this suite is
// about the level-controls UI, not the cap gate itself, so grant real
// headroom first (see grantLandCapHeadroomAsAdmin's own comment).
const builderId = await page.evaluate(() => fetch('/api/builders/me').then((r) => r.json()).then((body) => body.builder.builderId));
await grantLandCapHeadroomAsAdmin(builderId);

const levelLabel = () => page.textContent('#level-label');
const removeHidden = () => page.isHidden('#level-remove-btn');

const initialLabel = await levelLabel();
const removeHiddenAtGround = await removeHidden();
const buildBtnAtGround = await page.textContent('#level-build-btn');
console.log('initial level label (should be Ground):', initialLabel);
console.log('Remove button hidden at ground (should be true):', removeHiddenAtGround);
console.log('Build button shows a cost preview at ground (should mention "m²"):', buildBtnAtGround);

// Build a level up.
await page.click('#level-build-btn');
// Concurrent-click guard (issue #403): Dig/Remove (not just Build itself)
// must also be disabled while the Build request is still in flight —
// otherwise a second click before this one resolves could race on
// currentLevelIndex/currentLandletLevels, each independently overwriting
// the other's result depending on which server round-trip finishes last.
const digDisabledMidFlight = await page.isDisabled('#level-dig-btn');
console.log('Dig button disabled while Build request is in flight (should be true):', digDisabledMidFlight);
await page.waitForTimeout(800);
const digEnabledAfterBuild = !(await page.isDisabled('#level-dig-btn'));
console.log('Dig button re-enabled after Build settles (should be true):', digEnabledAfterBuild);
const labelAfterBuild = await levelLabel();
const removeVisibleAfterBuild = !(await removeHidden());
console.log('level label after building up (should be Level +1):', labelAfterBuild);
console.log('Remove button visible after building (should be true):', removeVisibleAfterBuild);

// Navigate down to ground and back up — pure client-side view, no network
// write — then place an item while looking at Level +1.
await page.click('#level-down-btn');
await page.waitForTimeout(300);
const labelAfterNavDown = await levelLabel();
await page.click('#level-up-btn');
await page.waitForTimeout(300);
const labelAfterNavUp = await levelLabel();
console.log('level label after nav down (should be Ground):', labelAfterNavDown);
console.log('level label after nav back up (should be Level +1):', labelAfterNavUp);

await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').first().click();
await page.waitForTimeout(300);
await page.mouse.click(210, 400);
await page.waitForTimeout(800);
const productInfoAfterPlace = await page.textContent('#product-info');
console.log('product-info after placing on Level +1 (should be non-empty, not still "Tap a spot..."):', productInfoAfterPlace);

// Reload — a fresh session, same builder — and confirm the level itself
// (not just the placed item) persisted server-side.
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: false });
await page.waitForSelector('#account-menu-toggle', { timeout: 10000 });
await page.waitForTimeout(1500);

const labelAfterReload = await levelLabel();
console.log('level label right after reload (should be Ground — always starts there):', labelAfterReload);
await page.click('#level-up-btn');
await page.waitForTimeout(300);
const labelAfterReloadNavUp = await levelLabel();
const removeVisibleAfterReload = !(await removeHidden());
console.log('level label after nav up post-reload (should be Level +1 — level persisted):', labelAfterReloadNavUp);
console.log('Remove button visible post-reload (should be true):', removeVisibleAfterReload);

// Remove the level (it's outermost, so this should succeed), then dig one
// down from ground instead.
await page.click('#level-remove-btn');
await page.waitForTimeout(800);
const labelAfterRemove = await levelLabel();
const removeHiddenAfterRemove = await removeHidden();
console.log('level label after removing Level +1 (should be Ground):', labelAfterRemove);
console.log('Remove button hidden again after removing (should be true):', removeHiddenAfterRemove);

await page.click('#level-dig-btn');
await page.waitForTimeout(800);
const labelAfterDig = await levelLabel();
console.log('level label after digging down (should be Level -1):', labelAfterDig);

const pass =
  initialLabel === 'Ground' &&
  removeHiddenAtGround &&
  buildBtnAtGround.includes('m²') &&
  labelAfterBuild === 'Level +1' &&
  digDisabledMidFlight &&
  digEnabledAfterBuild &&
  removeVisibleAfterBuild &&
  labelAfterNavDown === 'Ground' &&
  labelAfterNavUp === 'Level +1' &&
  !productInfoAfterPlace.toLowerCase().includes('tap a spot') &&
  labelAfterReload === 'Ground' &&
  labelAfterReloadNavUp === 'Level +1' &&
  removeVisibleAfterReload &&
  labelAfterRemove === 'Ground' &&
  removeHiddenAfterRemove &&
  labelAfterDig === 'Level -1' &&
  errors.length === 0;
await finish(browser, { pass, label: 'Vertical construction: Build-mode level controls', errors });
