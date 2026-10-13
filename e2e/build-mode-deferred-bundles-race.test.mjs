// Regression test for #1831: Build mode's own entry no longer blocks the
// scene on fetchBundles()/fetchSharedBundles() -- that pair is deferred to
// run in the background instead. Without sharing bundlePickerLoadToken with
// Save Bundle (which mutates myBundles/communityBundles locally, with no
// refetch of its own), a builder who creates a bundle before that deferred
// fetch resolves could have it silently wiped from the picker once the
// fetch's own stale (pre-creation) snapshot landed and overwrote it.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Deferred Bundles Race Tester';
const BUNDLE_NAME = 'Race Bundle';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

// Delay only the FIRST GET /api/bundles* request pair (Build mode's own
// deferred initial load, fired right after the scene starts rendering) --
// long enough that the test can place an item and save a bundle (which
// never itself calls GET /api/bundles -- Save Bundle mutates myBundles/
// communityBundles locally) before that delayed response lands.
let getBundlesCalls = 0;
await page.route('**/api/bundles?*', async (route) => {
  if (route.request().method() !== 'GET') {
    await route.continue();
    return;
  }
  getBundlesCalls += 1;
  const response = await route.fetch();
  if (getBundlesCalls <= 2) await new Promise((resolve) => setTimeout(resolve, 8000));
  await route.fulfill({ response });
});

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

// Place an item and save it as a bundle while Build mode's own deferred
// bundles fetch (delayed above) is still in flight.
await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
await page.waitForTimeout(300);
await page.mouse.click(210, 400);
await page.waitForFunction(() => document.getElementById('product-info').textContent.includes('Tree'), { timeout: 10000 });
await page.click('#toggle-multiselect');
await page.waitForTimeout(300);
await page.evaluate((n) => { window.prompt = () => n; }, BUNDLE_NAME);
await page.click('#save-bundle-item');
await page.waitForFunction(() => document.getElementById('product-info').textContent.includes('Saved'), { timeout: 10000 });

// Reopen the picker right away -- the bundle should already show, from
// Save Bundle's own local update, well before the deferred fetch resolves.
// isVisible(), not count() -- renderBundlePicker() hides the whole
// #bundle-picker-section (via its own `hidden` property, which only
// affects CSS display) without ever clearing its grid's child nodes when
// it thinks there are no bundles, so a stale empty render can leave the
// section invisible while the DOM node Playwright's count() would see
// stays right there, silently defeating a count()-based check.
await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
const bundleVisibleRightAfterSave = await page.locator('.bundle-tile').filter({ hasText: BUNDLE_NAME }).isVisible();
console.log('bundle tile visible right after Save Bundle, before the deferred fetch lands (should be true):', bundleVisibleRightAfterSave);
await page.click('#catalog-picker-close-btn');
await page.waitForTimeout(300);

// Now wait out the deferred fetch's own delay, and confirm it didn't wipe
// the bundle back out once its stale (pre-creation) snapshot landed.
await page.waitForTimeout(8500);
await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
const bundleStillVisibleAfterDeferredFetch = await page.locator('.bundle-tile').filter({ hasText: BUNDLE_NAME }).isVisible();
console.log('bundle tile still visible after the deferred initial-load fetch also lands (should be true, not wiped):', bundleStillVisibleAfterDeferredFetch);

const pass = bundleVisibleRightAfterSave && bundleStillVisibleAfterDeferredFetch && errors.length === 0;
await finish(browser, {
  pass,
  label: "#1831: a bundle saved while Build mode's own deferred initial bundles fetch is in flight survives once that fetch lands",
  errors,
});
