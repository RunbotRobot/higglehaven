// Regression test for #1787: the delete handler never bumped
// bundlePickerLoadToken the way the rename/share-toggle handlers do (#1349)
// -- so a slower, concurrent rename/share-toggle on a *different* bundle
// could resolve after a delete and overwrite myBundles/communityBundles
// with a stale refetched snapshot that still contains the already-deleted
// bundle, resurrecting it in the UI.
import { launchPage, chooseIdentity, claimLandlet, finish, saveBundleAs, fillBundleNameModal } from './helpers.mjs';

const LABEL = 'Bundle Delete Race Tester';
const BUNDLE_A = 'Delete Race Bundle A';
const BUNDLE_B = 'Delete Race Bundle B';
const BUNDLE_A_RENAMED = 'Delete Race Bundle A Renamed';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

async function placeAndSaveBundle(name, x, y) {
  await page.click('#add-item-btn');
  await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
  await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
  await page.waitForTimeout(300);
  await page.mouse.click(x, y);
  // #2142 (sub-issue of #2138): waitForFunction's signature is (pageFunction,
  // arg, options) -- a bare (fn, { timeout }) call puts the options object
  // in the `arg` slot instead, so `options` stayed undefined and the real
  // applied timeout was always Playwright's actual default (30000ms), never
  // the smaller number written here. The explicit `null` arg reaches the
  // options slot, and the timeout itself is widened to 60000ms for real
  // headroom under CI load, same as e2e/helpers.mjs's own account-menu-modal
  // wait.
  await page.waitForFunction(() => document.getElementById('product-info').textContent.includes('Tree'), null, { timeout: 60000 });
  await page.click('#toggle-multiselect');
  await page.waitForTimeout(300);
  await saveBundleAs(page, name);
  await page.waitForFunction(() => document.getElementById('product-info').textContent.includes('Saved'), null, { timeout: 60000 });
  await page.click('#toggle-multiselect');
  await page.waitForTimeout(300);
}

await placeAndSaveBundle(BUNDLE_A, 150, 400);
await placeAndSaveBundle(BUNDLE_B, 270, 400);

await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.waitForSelector('.bundle-tile', { timeout: 10000 });

// Delay only the first two GET /api/bundles* requests -- Bundle A's own
// refetch pair (fetchBundles + fetchSharedBundles), fired right after its
// rename's PATCH resolves below -- so they're still in flight when Bundle
// B's delete (its own DELETE call isn't matched by this GET-only route, so
// it runs undelayed) completes and removes B first. Without #1787's fix,
// Bundle A's delayed refetch would then land last, redraw from a snapshot
// captured before B's delete committed, and resurrect B's tile.
let getBundlesCalls = 0;
await page.route('**/api/bundles?*', async (route) => {
  if (route.request().method() !== 'GET') {
    await route.continue();
    return;
  }
  getBundlesCalls += 1;
  const response = await route.fetch();
  if (getBundlesCalls <= 2) await new Promise((resolve) => setTimeout(resolve, 3000));
  await route.fulfill({ response });
});

const tile = (name) => page.locator('.bundle-tile').filter({ hasText: name });

await tile(BUNDLE_A).locator('.bundle-tile-rename').click();
await fillBundleNameModal(page, BUNDLE_A_RENAMED);
// Don't wait for A's rename to settle -- fire B's delete right away, while
// A's own (delayed) refetch is still in flight. launchPage's own dialog
// handler already auto-accepts the delete confirm().
await page.waitForTimeout(200);
await tile(BUNDLE_B).locator('.bundle-tile-delete').click();

// B's delete (its own DELETE call + local filter, undelayed) should land
// first -- its tile disappears immediately.
await page.waitForFunction(
  (name) => !Array.from(document.querySelectorAll('.bundle-tile')).some((t) => t.textContent.includes(name)),
  BUNDLE_B,
  { timeout: 10000 },
);
const bGoneRightAfterDelete = (await tile(BUNDLE_B).count()) === 0;
console.log('Bundle B tile gone right after its own delete (should be true):', bGoneRightAfterDelete);

// Now wait out A's delayed refetch too, and confirm it didn't resurrect B.
await page.waitForTimeout(3500);
const bStillGone = (await tile(BUNDLE_B).count()) === 0;
console.log('Bundle B tile still gone after A\'s delayed refetch also settles (should be true, not resurrected):', bStillGone);
const aShowsRenamed = (await tile(BUNDLE_A_RENAMED).count()) === 1;
console.log('Bundle A shows its renamed name (should be true):', aShowsRenamed);

const pass = bGoneRightAfterDelete && bStillGone && aShowsRenamed && errors.length === 0;
await finish(browser, {
  pass,
  label: "#1787: a different bundle's rename refetch doesn't resurrect an already-deleted bundle",
  errors,
});
