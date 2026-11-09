// #3249/#3278: Sell > Manage "Delete" used to gate on window.confirm(). A
// browser that suppresses native dialogs (Chrome's "prevent this page from
// creating additional dialogs", some embedded/PWA contexts) returns false at
// once, so Delete did nothing and said nothing (reported on Android Chrome).
// The inline confirm that replaced it was almost missed on the same form, so
// Delete now confirms in its own in-app modal (the owner's #3278 decision).
// This test makes the browser refuse every native dialog, on a phone-width
// viewport, and checks the whole flow: the modal names the product, a refused
// delete (a 409) is shown inside the modal, Never mind keeps the product, and
// Delete removes it, with no native dialog raised.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

const LABEL = 'Seller Delete Confirm Tester';
const PRODUCT_NAME = 'Delete Confirm Target';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 800 } });

// Replace launchPage's accept-everything handler with one that refuses, the
// way a suppressed dialog behaves, and records that one was raised at all.
let nativeDialogs = 0;
page.removeAllListeners('dialog');
page.on('dialog', async (dialog) => {
  nativeDialogs += 1;
  await dialog.dismiss();
});

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForTimeout(300);

await page.click('#upload-model-btn');
await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });
await page.fill('#upload-name', PRODUCT_NAME);
await page.fill('#upload-price', '5');
await page.setInputFiles('#upload-file-input', CRATE_MODEL_PATH);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-step-dimensions').hidden, null, { timeout: 30000 });
await page.waitForTimeout(300);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), null, { timeout: 30000 });
await page.waitForTimeout(500);

const row = page.locator('.seller-row').filter({ hasText: PRODUCT_NAME });
await row.locator('.seller-row-toggle').click();
await page.waitForTimeout(300);
const deleteBtn = row.locator('.seller-row-action-btn.danger', { hasText: /^Delete$/ });

// Delete -> a separate modal opens, names the product, and focuses the safe
// choice (Never mind), not the destructive one.
await deleteBtn.click();
await page.waitForSelector('#confirm-modal.visible', { timeout: 5000 });
const modalMessage = await page.textContent('#confirm-modal-message');
const messageNamesProduct = modalMessage.includes(PRODUCT_NAME);
const focusOnSafeChoice = await page.evaluate(() => document.activeElement?.id === 'confirm-modal-cancel-btn');
const rowStillHasDelete = await deleteBtn.isVisible();

// Never mind -> modal closes, nothing deleted, focus returns to Delete.
await page.click('#confirm-modal-cancel-btn');
await page.waitForFunction(() => !document.getElementById('confirm-modal').classList.contains('visible'), null, { timeout: 5000 });
const stillThereAfterCancel = (await page.locator('.seller-row').filter({ hasText: PRODUCT_NAME }).count()) === 1;
const focusBackOnDelete = await page.evaluate(() => document.activeElement?.textContent === 'Delete');
// The Seller modal underneath is still armed: Escape closes it, which only
// works if the confirm modal handed its focus trap back.
const sellerStillOpen = (await page.locator('#seller-modal.visible').count()) === 1;

// A refused delete is shown inside the modal, which stays open.
await page.route('**/api/catalog/*', async (route) => {
  if (route.request().method() === 'DELETE') {
    await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Template is still in use by a placed instance.' }) });
  } else {
    await route.continue();
  }
});
await deleteBtn.click();
await page.waitForSelector('#confirm-modal.visible', { timeout: 5000 });
await page.click('#confirm-modal-confirm-btn');
await page.waitForFunction(() => document.getElementById('confirm-modal-status').textContent.length > 0, null, { timeout: 10000 });
const refusalShownInModal = (await page.textContent('#confirm-modal-status')).includes('Still placed somewhere');
const modalStayedOpen = (await page.locator('#confirm-modal.visible').count()) === 1;
await page.unroute('**/api/catalog/*');

// Confirm for real -> modal closes and the product is gone.
await page.click('#confirm-modal-confirm-btn');
await page.waitForFunction(
  (name) => ![...document.querySelectorAll('.seller-row')].some((el) => el.textContent.includes(name)),
  PRODUCT_NAME,
  { timeout: 15000 },
);
const goneAfterConfirm = (await page.locator('.seller-row').filter({ hasText: PRODUCT_NAME }).count()) === 0;
const modalClosedAfterConfirm = (await page.locator('#confirm-modal.visible').count()) === 0;

console.log('confirm modal names the product:', messageNamesProduct);
console.log('focus lands on Never mind (the safe choice):', focusOnSafeChoice);
console.log('product kept after Never mind:', stillThereAfterCancel);
console.log('focus back on Delete after Never mind:', focusBackOnDelete);
console.log('Seller modal still open behind it:', sellerStillOpen);
console.log('refusal shown inside the modal:', refusalShownInModal);
console.log('modal stayed open after a refusal:', modalStayedOpen);
console.log('product gone after confirming:', goneAfterConfirm);
console.log('modal closed after confirming:', modalClosedAfterConfirm);
console.log('native dialogs raised (should be 0):', nativeDialogs);

const pass = messageNamesProduct && focusOnSafeChoice && rowStillHasDelete && stillThereAfterCancel && focusBackOnDelete
  && sellerStillOpen && refusalShownInModal && modalStayedOpen && goneAfterConfirm && modalClosedAfterConfirm && nativeDialogs === 0;
await finish(browser, { pass, label: 'Sell > Manage Delete confirms in its own in-app modal, shows a refusal inside it, works with native dialogs suppressed (#3249, #3278)', errors });
