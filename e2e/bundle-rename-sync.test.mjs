// Regression test for #435: renaming a bundle only patched whichever tab
// (My Bundles vs Community) the rename was triggered from — a shared
// bundle exists as two separate JS objects (one per tab's own fetch), so
// the other tab's tile kept showing the stale name until some unrelated
// action happened to refetch both lists.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Bundle Rename Sync Tester';
const ORIGINAL_NAME = LABEL; // launchPage's dialog handler answers every prompt() with promptAnswer
const NEW_NAME = 'Renamed Shared Bundle';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
await page.waitForTimeout(300);
await page.mouse.click(210, 400);
await page.waitForTimeout(800);

await page.click('#toggle-multiselect');
await page.waitForTimeout(300);
await page.click('#save-bundle-item');
// launchPage's dialog handler auto-accepts confirm() too — the Save Bundle
// handler's own confirm() asks whether to share, so this bundle lands in
// both My Bundles and Community from the start.
await page.waitForFunction(() => document.getElementById('product-info').textContent.includes('Saved'), { timeout: 10000 });

// Save Bundle's own handler pushes the exact same object reference into
// both myBundles and communityBundles (see its own code), so renaming
// right after saving wouldn't actually exercise the bug — both tabs would
// already be looking at the same in-memory object. A reload forces
// bootstrap's real fetchBundles()/fetchSharedBundles() to independently
// populate each list, the same way returning to the app in a fresh
// session would, giving each tab its own separate object for this
// bundle — the actual precondition the bug needs.
// A raw reload lands in Shop mode by default (see START_MODE_KEY's own
// comment) unless this is set first, the same way every one of the app's
// own reload-triggering paths (mode-nav, logout) already does.
await page.evaluate(() => sessionStorage.setItem('higglehaven.startMode', 'build'));
await page.reload();
await page.waitForSelector('#account-menu-toggle', { timeout: 15000 });
await page.waitForTimeout(500);

await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });

// Confirm it's present in Community before renaming, same as
// bundle-sharing.test.mjs already establishes for the sharer's own bundle.
await page.click('.bundle-tab-btn[data-bundle-tab="community"]');
await page.waitForTimeout(300);
const beforeRenameCommunityCount = await page.locator('.bundle-tile').filter({ hasText: ORIGINAL_NAME }).count();
console.log('bundle visible in Community before rename (should be 1):', beforeRenameCommunityCount);

// Rename it from the My Bundles tab.
await page.click('.bundle-tab-btn[data-bundle-tab="mine"]');
await page.waitForTimeout(300);
await page.evaluate((name) => { window.prompt = () => name; }, NEW_NAME);
await page.click('.bundle-tile-rename');
await page.waitForFunction(
  (name) => document.querySelector('.bundle-tile')?.textContent.includes(name),
  NEW_NAME,
  { timeout: 10000 },
);
const myBundlesTileText = await page.locator('.bundle-tile').first().textContent();
console.log('My Bundles tile shows the new name right after renaming (should be true):', myBundlesTileText.includes(NEW_NAME));

// The Community tab's own copy of the same bundle should show the new
// name too, without any other action forcing a refetch in between.
await page.click('.bundle-tab-btn[data-bundle-tab="community"]');
await page.waitForTimeout(300);
const communityTileText = await page.locator('.bundle-tile').first().textContent();
console.log('Community tab tile shows the new name too (should be true, not the stale original):', communityTileText.includes(NEW_NAME));
console.log('Community tab tile no longer shows the stale original name (should be true):', !communityTileText.includes(ORIGINAL_NAME));

const pass = beforeRenameCommunityCount === 1 &&
  myBundlesTileText.includes(NEW_NAME) &&
  communityTileText.includes(NEW_NAME) &&
  !communityTileText.includes(ORIGINAL_NAME) &&
  errors.length === 0;
await finish(browser, { pass, label: '#435: renaming a shared bundle syncs its counterpart in the other tab', errors });
