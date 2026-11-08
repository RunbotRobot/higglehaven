// #3249: Sell > Manage "Delete" used to gate on window.confirm(). A browser
// that suppresses native dialogs (Chrome's "prevent this page from creating
// additional dialogs", some embedded/PWA contexts) returns false at once, so
// Delete did nothing and said nothing (reported on Android Chrome). Delete now
// confirms inline. This test makes the browser refuse every native dialog, on
// a phone-width viewport, and checks the whole flow still works: Never mind
// keeps the product, Yes, delete removes it, and no native dialog was raised.
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

// Delete -> the inline confirm appears, the Delete button steps aside.
await row.locator('.seller-row-action-btn.danger', { hasText: /^Delete$/ }).click();
const confirmShown = await row.locator('.seller-row-delete-confirm-btn').isVisible();
const deleteHiddenWhileConfirming = !(await row.locator('.seller-row-action-btn.danger', { hasText: /^Delete$/ }).isVisible());

// Never mind -> nothing deleted, Delete is back.
await row.locator('.seller-row-delete-cancel-btn').click();
await page.waitForTimeout(200);
const stillThereAfterCancel = (await page.locator('.seller-row').filter({ hasText: PRODUCT_NAME }).count()) === 1;
const deleteBackAfterCancel = await row.locator('.seller-row-action-btn.danger', { hasText: /^Delete$/ }).isVisible();

// Delete -> Yes, delete -> the product is gone.
await row.locator('.seller-row-action-btn.danger', { hasText: /^Delete$/ }).click();
await row.locator('.seller-row-delete-confirm-btn').click();
await page.waitForFunction(
  (name) => ![...document.querySelectorAll('.seller-row')].some((el) => el.textContent.includes(name)),
  PRODUCT_NAME,
  { timeout: 15000 },
);
const goneAfterConfirm = (await page.locator('.seller-row').filter({ hasText: PRODUCT_NAME }).count()) === 0;

console.log('confirm shown after Delete:', confirmShown);
console.log('Delete hidden while confirming:', deleteHiddenWhileConfirming);
console.log('product kept after Never mind:', stillThereAfterCancel);
console.log('Delete restored after Never mind:', deleteBackAfterCancel);
console.log('product gone after Yes, delete:', goneAfterConfirm);
console.log('native dialogs raised (should be 0):', nativeDialogs);

const pass = confirmShown && deleteHiddenWhileConfirming && stillThereAfterCancel && deleteBackAfterCancel
  && goneAfterConfirm && nativeDialogs === 0;
await finish(browser, { pass, label: 'Sell > Manage Delete confirms in-app and works with native dialogs suppressed (#3249)', errors });
