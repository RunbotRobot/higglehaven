// Regression/feature test for #1600: a seller's own catalog previously had
// no signal at all when a new or renamed product name exactly matched
// another of their own live listings -- a likely honest mistake (a stalled
// rename, a re-upload) rather than something to silently allow. Fixed with
// a soft confirm() warning (not a hard block) in both the Upload Model
// creation flow and the per-product Rename flow, scoped to the seller's own
// catalog only -- a different seller using the same name is fine and
// should never trigger it.
//
// Verified here the same way as delete-builder-balance-warning.test.mjs: a
// second `page.on('dialog', ...)` listener alongside launchPage's own
// auto-accepting one (see helpers.mjs) captures each dialog's message, so
// accepting it (continuing anyway) still lets the rest of the flow
// complete -- this is a warning, not a block.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

const LABEL = 'Dup Name Warning Tester';
const FIRST_NAME = 'Widget';
const SECOND_UNIQUE_NAME = 'Gadget';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

const dialogMessages = [];
page.on('dialog', (dialog) => { dialogMessages.push(dialog.message()); });

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForTimeout(300);

let uploadInlineWarning = null;
async function uploadProduct(name, { expectInlineWarning = false } = {}) {
  await page.click('#upload-model-btn');
  await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });
  await page.fill('#upload-name', name);
  await page.fill('#upload-price', '5');
  await page.setInputFiles('#upload-file-input', CRATE_MODEL_PATH);
  await page.click('#upload-submit-btn');
  if (expectInlineWarning) {
    // #3249: an in-app confirm beside the button, not a native dialog.
    await page.waitForSelector('#upload-modal-actions .inline-confirm', { timeout: 5000 });
    uploadInlineWarning = await page.textContent('#upload-modal-actions .inline-confirm');
    await page.click('#upload-modal-actions .inline-confirm-yes-btn');
  }
  await page.waitForFunction(() => !document.getElementById('upload-step-dimensions').hidden, null, { timeout: 45000 });
  await page.waitForTimeout(300);
  await page.click('#upload-submit-btn');
  await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), null, { timeout: 45000 });
  await page.waitForTimeout(500);
}

// First upload, unique name so far -- should create with no dialog at all
// beyond the identity-picker prompt() already consumed above.
await uploadProduct(FIRST_NAME);
const dialogsAfterFirstUpload = dialogMessages.length;
console.log('dialogs after first (unique-name) upload (should be 0):', dialogsAfterFirstUpload);

// Second upload, a genuinely different name -- still no duplicate warning.
await uploadProduct(SECOND_UNIQUE_NAME);
const dialogsAfterUniqueSecondUpload = dialogMessages.length;
console.log('dialogs after second unique-name upload (should still be 0):', dialogsAfterUniqueSecondUpload);

// Third upload, same name as the very first product -- should warn, then
// (since launchPage's own handler accepts every dialog) still go through,
// since this is a soft warning, not a hard block.
await uploadProduct(FIRST_NAME, { expectInlineWarning: true });
const dupUploadWarning = uploadInlineWarning;
const nativeDialogsDuringDup = dialogMessages.length;
console.log('duplicate-name warning on create (should mention the name):', dupUploadWarning);

const sellerListText = await page.textContent('#seller-list');
const bothWidgetsListed = (sellerListText.match(new RegExp(FIRST_NAME, 'g')) ?? []).length >= 2;
console.log('both same-named products still created despite the warning (should be true):', bothWidgetsListed);

// Rename flow: renaming SECOND_UNIQUE_NAME to also collide with FIRST_NAME
// should warn too, scoped the same way. Rename now uses the in-app name modal
// (#3249) and an inline confirm for the warning, so there is no native dialog
// to capture -- fill the modal and read the inline confirm's text.
await page.waitForTimeout(300);
const rows = page.locator('.seller-row');
const rowCount = await rows.count();
let renamed = false;
let dupRenameWarning = null;
for (let i = 0; i < rowCount; i++) {
  const row = rows.nth(i);
  const text = await row.textContent();
  if (text.includes(SECOND_UNIQUE_NAME)) {
    await row.locator('.seller-row-toggle').click();
    await row.locator('.seller-row-action-btn:has-text("Rename")').click();
    await page.fill('#bundle-name-input', FIRST_NAME);
    await page.click('#bundle-name-save-btn');
    await row.locator('.inline-confirm').waitFor({ timeout: 5000 });
    dupRenameWarning = await row.locator('.inline-confirm').textContent();
    renamed = true;
    break;
  }
}
console.log('duplicate-name warning on rename (should mention the name):', dupRenameWarning);

const pass = dialogsAfterFirstUpload === 0 &&
  dialogsAfterUniqueSecondUpload === 0 &&
  dupUploadWarning !== null && dupUploadWarning.includes(FIRST_NAME) &&
  bothWidgetsListed &&
  nativeDialogsDuringDup === 0 &&
  renamed &&
  dupRenameWarning !== null && dupRenameWarning.includes(FIRST_NAME) &&
  dupRenameWarning !== dupUploadWarning &&
  errors.length === 0;
await finish(browser, { pass, label: 'duplicate product-name soft warning on create and rename', errors });
