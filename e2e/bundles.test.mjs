// Bundles: a builder selects several placed items, saves them as a named
// group, sees it listed under Add Item's "My Bundles" section, places it
// again elsewhere (all items land together, preserving their relative
// layout — see relativeItemsForMeshes/placeClipboardItems), and can delete
// it.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Bundle Suite Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

// Place two trees at distinct screen positions so each can be individually
// tapped afterward.
async function placeTreeAt(x, y) {
  await page.click('#add-item-btn');
  await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
  await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
  await page.waitForTimeout(300);
  await page.mouse.click(x, y);
  await page.waitForTimeout(800);
}
await placeTreeAt(160, 400);
await placeTreeAt(260, 400);

// No bundle section yet — this builder hasn't saved one.
await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
const bundleSectionHiddenInitially = await page.locator('#bundle-picker-section').isHidden();
console.log('bundle section hidden before any bundle exists (should be true):', bundleSectionHiddenInitially);
await page.click('#catalog-picker-close-btn');
await page.waitForTimeout(300);

// Placing the second tree auto-selected it (handlePlacementClick's own
// selectOnly for a 'template' placement) — clear that first, on a patch of
// open ground away from both trees, so toggling Multi-Select on doesn't
// carry it into the selection (it would otherwise count as "already
// selected," and the very next tap on it below would toggle it back OFF
// instead of adding it).
await page.mouse.click(60, 550);
await page.waitForTimeout(300);

// A tree's own clickable footprint sits well above the ground point it was
// placed at — the trunk's base is where the placement raycast hit, but the
// foliage (and most of the collision geometry) renders higher up on screen
// once the camera's perspective is applied (see e2e/README.md's own note
// on this from the smoke test). Scan a vertical strip at each tree's X
// rather than reusing the exact placement Y, stopping as soon as the
// selection status text actually changes.
async function selectByScanningY(x, yStart, yEnd, yStep, textBefore) {
  for (let y = yStart; y <= yEnd; y += yStep) {
    await page.mouse.click(x, y);
    await page.waitForTimeout(250);
    const textAfter = await page.textContent('#product-info');
    if (textAfter !== textBefore) return textAfter;
  }
  return page.textContent('#product-info');
}

// Multi-select both trees by tapping each (a plain tap toggles selection in
// multi-select mode — no drag/swipe needed for two individually-tappable
// items).
await page.click('#toggle-multiselect');
await page.waitForTimeout(300);
let selectionText = await page.textContent('#product-info');
selectionText = await selectByScanningY(160, 320, 400, 10, selectionText);
selectionText = await selectByScanningY(260, 320, 400, 10, selectionText);
console.log('selection status before saving (should say 2 items selected):', selectionText);

await page.click('#save-bundle-item');
await page.waitForFunction(
  () => document.getElementById('product-info').textContent.includes('Saved'),
  { timeout: 10000 },
);
const savedStatus = await page.textContent('#product-info');
console.log('status right after Save Bundle (should mention Saved and 2 items):', savedStatus);

// Reopen Add Item — the bundle should now be listed.
await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
const bundleSectionVisible = await page.locator('#bundle-picker-section').isVisible();
const bundleTileText = await page.locator('.bundle-tile').first().textContent();
console.log('bundle section visible after saving (should be true):', bundleSectionVisible);
console.log('bundle tile text (should mention the name and 2 items):', bundleTileText);

// Place it elsewhere — both items should land together and end up selected.
await page.locator('.bundle-tile-place').first().click();
await page.waitForTimeout(300);
await page.mouse.click(210, 550);
await page.waitForTimeout(1000);
const infoAfterBundlePlacement = await page.textContent('#product-info');
console.log('selection after placing the bundle (should say 2 items selected):', infoAfterBundlePlacement);

// Delete it — confirm() is auto-accepted by launchPage's dialog handler —
// and the section goes back to hidden once nothing's left.
await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.click('.bundle-tile-delete');
await page.waitForTimeout(500);
const bundleSectionHiddenAfterDelete = await page.locator('#bundle-picker-section').isHidden();
console.log('bundle section hidden after deleting the only bundle (should be true):', bundleSectionHiddenAfterDelete);

const pass = bundleSectionHiddenInitially &&
  selectionText.includes('2 items selected') &&
  savedStatus.includes('Saved') && savedStatus.includes('2 item') &&
  bundleSectionVisible && bundleTileText.includes(LABEL) && bundleTileText.includes('2 items') &&
  infoAfterBundlePlacement.includes('2 items selected') &&
  bundleSectionHiddenAfterDelete &&
  errors.length === 0;
await finish(browser, { pass, label: 'save/place/delete a Bundle', errors });
