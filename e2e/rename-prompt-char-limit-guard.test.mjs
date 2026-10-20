// Regression test for #2345 (plus its #2463 sibling): five native
// prompt()-based rename/create flows (builder/seller identity rename,
// product rename, bundle create, bundle rename, and landlet rename via the
// "My Lands" panel) all feed labelValue()'s MAX_LABEL_LENGTH = 100
// server-side cap with no client-side compensation -- unlike the 280-char
// sign-post/review/calendar-event text fields, which already established
// the "pre-submit length check + alert()" pattern (#1920/#2005/#2015) this
// test confirms got applied here too. #2345 covered the first four; #2463
// found the landlet-rename flow (added earlier, in #1150) had been missed
// from that original sweep. Each flow is exercised the same way: an
// over-100-char value triggers the client-side alert with no mutation
// reaching the server, then a valid value still works normally (not a
// regression to "nothing can ever be renamed").
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

const LABEL = 'Rename Char Limit Tester';
const OVERLONG = 'x'.repeat(101);

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

// Scripted, in-order answers to every dialog this test triggers -- a plain
// string accepts a prompt() with that value, `true` accepts a confirm()/
// alert() with no value. Each dialog's own message is logged first, so an
// unexpected extra/missing dialog shows up as a script/log length mismatch
// rather than silently answering the wrong one.
const dialogLog = [];
let dialogScript = [];
page.removeAllListeners('dialog');
page.on('dialog', (dialog) => {
  dialogLog.push(dialog.message());
  const action = dialogScript.shift();
  if (typeof action === 'string') return dialog.accept(action);
  return dialog.accept();
});

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

// --- 1. Builder identity rename (Settings > Build tab) ---
await openAccountMenu(page);
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
await page.click('.settings-tab-btn[data-section="build"]');
const builderIdentityField = page.locator('.settings-field').filter({ hasText: 'Builder Identity' });
await builderIdentityField.waitFor({ timeout: 10000 });
const builderRenameBtn = builderIdentityField.locator('button', { hasText: 'Rename' });

dialogScript = [OVERLONG];
await builderRenameBtn.click();
await page.waitForTimeout(300);
const builderLabelAfterOverlong = await builderIdentityField.locator('div').first().textContent();
console.log('builder identity label unchanged after an over-100-char rename attempt (should be true):', builderLabelAfterOverlong.trim() === LABEL);

const NEW_BUILDER_LABEL = 'Renamed Builder Identity';
dialogScript = [NEW_BUILDER_LABEL];
await builderRenameBtn.click();
await page.waitForFunction(
  (name) => document.querySelector('.settings-field')?.textContent.includes(name),
  NEW_BUILDER_LABEL,
  { timeout: 10000 },
);
const builderLabelAfterValidRename = await builderIdentityField.locator('div').first().textContent();
console.log('builder identity renamed normally with a valid value (should be true):', builderLabelAfterValidRename.trim() === NEW_BUILDER_LABEL);

await page.click('#settings-close-btn');
await page.waitForTimeout(300);

// --- 2. Landlet rename ("My Lands" panel, Build mode account menu) (#2463) ---
await openAccountMenu(page);
await page.click('#my-lands-btn');
await page.waitForSelector('#my-lands-modal.visible', { timeout: 5000 });
const myLandsRow = page.locator('#my-lands-list .version-row').first();
await myLandsRow.waitFor({ timeout: 10000 });
const ORIGINAL_LAND_NAME = (await myLandsRow.locator('.my-lands-open-link').textContent()).trim();
const myLandsRenameBtn = myLandsRow.locator('.version-action-btn', { hasText: 'Rename' });

dialogScript = [OVERLONG];
await myLandsRenameBtn.click();
await page.waitForTimeout(300);
const landNameAfterOverlong = await myLandsRow.locator('.my-lands-open-link').textContent();
console.log('landlet name unchanged after an over-100-char rename attempt (should be true):', landNameAfterOverlong.trim() === ORIGINAL_LAND_NAME);

const NEW_LAND_NAME = 'Renamed Valid Land';
dialogScript = [NEW_LAND_NAME];
await myLandsRenameBtn.click();
await page.waitForFunction(
  (name) => document.querySelector('#my-lands-list .my-lands-open-link')?.textContent === name,
  NEW_LAND_NAME,
  { timeout: 10000 },
);
const landNameAfterValidRename = await myLandsRow.locator('.my-lands-open-link').textContent();
console.log('landlet renamed normally with a valid value (should be true):', landNameAfterValidRename.trim() === NEW_LAND_NAME);

await page.click('#my-lands-close-btn');
await page.waitForTimeout(300);

// --- 3. Bundle create (Build mode, multiselect + Save Bundle) ---
await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
await page.waitForTimeout(300);
await page.mouse.click(210, 400);
await page.waitForTimeout(800);
await page.click('#toggle-multiselect');
await page.waitForTimeout(300);

dialogScript = [OVERLONG];
await page.click('#save-bundle-item');
await page.waitForTimeout(300);
const noBundleSavedAfterOverlong = await page.evaluate(() =>
  !document.getElementById('product-info')?.textContent.includes('Saved'));
console.log('no "Saved" confirmation after an over-100-char bundle name (should be true -- no confirm() even reached):', noBundleSavedAfterOverlong);

const NEW_BUNDLE_NAME = 'Valid Bundle Name';
dialogScript = [NEW_BUNDLE_NAME, true]; // name prompt, then the share confirm()
await page.click('#save-bundle-item');
await page.waitForFunction(() => document.getElementById('product-info').textContent.includes('Saved'), null, { timeout: 60000 });
console.log('bundle saved normally with a valid name (should reach here without timing out)');

// --- 4. Bundle rename (catalog picker's My Bundles tab) ---
await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.click('.bundle-tab-btn[data-bundle-tab="mine"]');
await page.waitForTimeout(300);
const bundleTileRenameBtn = page.locator('.bundle-tile', { hasText: NEW_BUNDLE_NAME }).locator('.bundle-tile-rename');

dialogScript = [OVERLONG];
await bundleTileRenameBtn.click();
await page.waitForTimeout(300);
const bundleNameAfterOverlong = await page.locator('.bundle-tile').first().textContent();
console.log('bundle tile name unchanged after an over-100-char rename attempt (should be true):', bundleNameAfterOverlong.includes(NEW_BUNDLE_NAME));

const RENAMED_BUNDLE_NAME = 'Renamed Valid Bundle';
dialogScript = [RENAMED_BUNDLE_NAME];
await bundleTileRenameBtn.click();
await page.waitForFunction(
  (name) => document.querySelector('.bundle-tile')?.textContent.includes(name),
  RENAMED_BUNDLE_NAME,
  { timeout: 10000 },
);
const bundleNameAfterValidRename = await page.locator('.bundle-tile').first().textContent();
console.log('bundle renamed normally with a valid value (should be true):', bundleNameAfterValidRename.includes(RENAMED_BUNDLE_NAME));

await page.click('#catalog-picker-close-btn');
await page.waitForTimeout(300);

// --- 5. Product rename (Sell mode, seller row "Rename") ---
await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForTimeout(300);
await page.click('#upload-model-btn');
await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });
const PRODUCT_NAME = 'Char Limit Guard Crate';
await page.fill('#upload-name', PRODUCT_NAME);
await page.fill('#upload-price', '10.00');
await page.setInputFiles('#upload-file-input', CRATE_MODEL_PATH);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-step-dimensions').hidden, null, { timeout: 30000 });
await page.waitForTimeout(300);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), null, { timeout: 30000 });
await page.waitForTimeout(500);

const productRow = () => page.locator('.seller-row').filter({ hasText: PRODUCT_NAME });
await productRow().locator('.seller-row-toggle').click();
await page.waitForTimeout(300);
const productRenameBtn = productRow().locator('button', { hasText: 'Rename' });

dialogScript = [OVERLONG];
await productRenameBtn.click();
await page.waitForTimeout(300);
const productNameAfterOverlong = await productRow().textContent();
console.log('product name unchanged after an over-100-char rename attempt (should be true):', productNameAfterOverlong.includes(PRODUCT_NAME));

const NEW_PRODUCT_NAME = 'Renamed Valid Crate';
dialogScript = [NEW_PRODUCT_NAME];
await productRenameBtn.click();
await page.waitForFunction(
  (name) => [...document.querySelectorAll('.seller-row')].some((el) => el.textContent.includes(name)),
  NEW_PRODUCT_NAME,
  { timeout: 10000 },
);
const productRowAfterValidRename = await page.locator('.seller-row').filter({ hasText: NEW_PRODUCT_NAME }).count();
console.log('product renamed normally with a valid value (should be 1):', productRowAfterValidRename);

const guardAlerts = dialogLog.filter((msg) => /100 characters/.test(msg));
console.log('total over-100-char guard alerts seen across all 5 flows (should be 5):', guardAlerts.length);

const pass = builderLabelAfterOverlong.trim() === LABEL &&
  builderLabelAfterValidRename.trim() === NEW_BUILDER_LABEL &&
  landNameAfterOverlong.trim() === ORIGINAL_LAND_NAME &&
  landNameAfterValidRename.trim() === NEW_LAND_NAME &&
  noBundleSavedAfterOverlong &&
  bundleNameAfterOverlong.includes(NEW_BUNDLE_NAME) &&
  bundleNameAfterValidRename.includes(RENAMED_BUNDLE_NAME) &&
  productNameAfterOverlong.includes(PRODUCT_NAME) &&
  productRowAfterValidRename === 1 &&
  guardAlerts.length === 5 &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: '#2345/#2463: builder identity/landlet/bundle create/bundle rename/product rename all enforce a 100-char client-side guard, matching #1920\'s established pattern',
  errors,
});
