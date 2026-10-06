// #1342: Duplicate and Delete (Seller modal, Manage view) used to call
// renderSellerList() directly on success instead of the shared
// renderActiveSellerView() dispatcher every other mutation path in this
// file already uses. Both are await-based network calls, so switching to
// List view while one is still in flight renders List view fresh (showing
// the pre-mutation state) -- then, without the fix, the mutation's own
// success handler never touches that now-visible List view at all once it
// resolves, leaving a deleted product's card still showing (and tappable)
// and a duplicated product's new card simply missing.
//
// Delaying the DELETE/POST response via page.route (rather than racing a
// real round trip against a fixed sleep) is the same idiom
// e2e/seller-size-price-save-race.test.mjs already uses for this exact
// class of "still in flight" window -- it guarantees the window is
// actually observable regardless of real backend speed.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

const LABEL = 'Seller List Refresh Tester';
const DELETE_PRODUCT_NAME = 'List Refresh Delete Target';
const DUPLICATE_PRODUCT_NAME = 'List Refresh Duplicate Source';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 10000 });
await page.waitForTimeout(300);

async function uploadProduct(name) {
  await page.click('#upload-model-btn');
  await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });
  await page.fill('#upload-name', name);
  await page.setInputFiles('#upload-file-input', CRATE_MODEL_PATH);
  await page.click('#upload-submit-btn');
  await page.waitForFunction(() => !document.getElementById('upload-step-dimensions').hidden, { timeout: 20000 });
  await page.waitForTimeout(300);
  await page.click('#upload-submit-btn');
  await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), { timeout: 10000 });
  await page.waitForTimeout(500);
}

await uploadProduct(DELETE_PRODUCT_NAME);
await uploadProduct(DUPLICATE_PRODUCT_NAME);

// --- Delete while List view is active at the moment it resolves ---
const deleteRow = page.locator('.seller-row').filter({ hasText: DELETE_PRODUCT_NAME });
await deleteRow.locator('.seller-row-toggle').click();
await page.waitForTimeout(300);

await page.route('**/api/catalog/*', async (route) => {
  if (route.request().method() === 'DELETE') await new Promise((resolve) => setTimeout(resolve, 2000));
  await route.continue();
});

await deleteRow.locator('.seller-row-action-btn.danger', { hasText: 'Delete' }).click();
await page.waitForTimeout(300); // DELETE is now in flight, delayed by the route above

// Switch to List view *while the delete is still in flight* -- renders List
// view fresh, showing the still-undeleted product (server hasn't processed
// the delete yet).
await page.click('.seller-view-btn[data-view="list"]');
await page.waitForTimeout(300);
const cardPresentBeforeDeleteResolves = await page.locator('.seller-card').filter({ hasText: DELETE_PRODUCT_NAME }).isVisible();
console.log('deleted product\'s card visible in List view before the delete resolves (should be true -- sanity check):', cardPresentBeforeDeleteResolves);

// Let the delayed DELETE actually land.
await page.waitForTimeout(2200);

const deletedCardStillInListView = await page.locator('.seller-card').filter({ hasText: DELETE_PRODUCT_NAME }).count();
console.log('deleted product\'s card gone from List view once the delete actually completes (should be 0):', deletedCardStillInListView);

// --- Duplicate while List view is active at the moment it resolves ---
// Switch back to Manage to reach the Duplicate button (List view's own
// cards don't have one).
await page.click('.seller-view-btn[data-view="manage"]');
await page.waitForTimeout(300);
const duplicateRow = page.locator('.seller-row').filter({ hasText: DUPLICATE_PRODUCT_NAME });
await duplicateRow.locator('.seller-row-toggle').click();
await page.waitForTimeout(300);

await page.route('**/api/catalog', async (route) => {
  if (route.request().method() === 'POST') await new Promise((resolve) => setTimeout(resolve, 2000));
  await route.continue();
});

await duplicateRow.locator('.seller-row-action-btn', { hasText: 'Duplicate' }).click();
await page.waitForTimeout(300); // POST is now in flight, delayed by the route above

await page.click('.seller-view-btn[data-view="list"]');
await page.waitForTimeout(300);
const copyPresentBeforeDuplicateResolves = await page.locator('.seller-card').filter({ hasText: `${DUPLICATE_PRODUCT_NAME} (copy)` }).count();
console.log('duplicate copy not yet in List view before the duplicate resolves (should be 0 -- sanity check):', copyPresentBeforeDuplicateResolves);

await page.waitForTimeout(2200);

const copyCardInListView = await page.locator('.seller-card').filter({ hasText: `${DUPLICATE_PRODUCT_NAME} (copy)` }).isVisible();
console.log('duplicate copy\'s card now showing in List view once the duplicate actually completes (should be true):', copyCardInListView);

const pass =
  cardPresentBeforeDeleteResolves &&
  deletedCardStillInListView === 0 &&
  copyPresentBeforeDuplicateResolves === 0 &&
  copyCardInListView &&
  errors.length === 0;
await finish(browser, { pass, label: 'Duplicate/Delete refresh List view too, not just Manage, once they complete (#1342)', errors });
