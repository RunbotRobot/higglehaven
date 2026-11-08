// #3249: Sell > Manage "Rename" used window.prompt() and, for a duplicate
// name, window.confirm(). A browser that suppresses native dialogs made both
// silently do nothing. Rename now uses the in-app name modal and an inline
// confirm. Every native dialog is refused here, on a phone-width viewport.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

const LABEL = 'Seller Rename In App Tester';
const FIRST = 'Rename Source Widget';
const SECOND = 'Rename Other Widget';
const UNIQUE_NEW = 'Brand New Widget Name';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 800 } });
let nativeDialogs = 0;
page.removeAllListeners('dialog');
page.on('dialog', async (dialog) => {
  nativeDialogs += 1;
  await dialog.dismiss();
});

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForTimeout(300);

async function uploadProduct(name) {
  await page.click('#upload-model-btn');
  await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });
  await page.fill('#upload-name', name);
  await page.fill('#upload-price', '5');
  await page.setInputFiles('#upload-file-input', CRATE_MODEL_PATH);
  await page.click('#upload-submit-btn');
  await page.waitForFunction(() => !document.getElementById('upload-step-dimensions').hidden, null, { timeout: 30000 });
  await page.waitForTimeout(300);
  await page.click('#upload-submit-btn');
  await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), null, { timeout: 30000 });
  await page.waitForTimeout(500);
}
await uploadProduct(FIRST);
await uploadProduct(SECOND);

const rowFor = (name) => page.locator('.seller-row').filter({ hasText: name });
const hasRow = async (name) => (await rowFor(name).count()) > 0;

// Unique new name: the modal saves it straight away.
await rowFor(FIRST).locator('.seller-row-toggle').click();
await rowFor(FIRST).locator('.seller-row-action-btn', { hasText: /^Rename$/ }).click();
await page.waitForSelector('#bundle-name-modal.visible', { timeout: 5000 });
await page.fill('#bundle-name-input', UNIQUE_NEW);
await page.click('#bundle-name-save-btn');
await page.waitForFunction((n) => [...document.querySelectorAll('.seller-row')].some((el) => el.textContent.includes(n)), UNIQUE_NEW, { timeout: 10000 });
const renamedToUnique = await hasRow(UNIQUE_NEW) && !(await hasRow(FIRST));

// Duplicate name: inline confirm; Never mind keeps the old name.
await rowFor(UNIQUE_NEW).locator('.seller-row-action-btn', { hasText: /^Rename$/ }).click();
await page.waitForSelector('#bundle-name-modal.visible', { timeout: 5000 });
await page.fill('#bundle-name-input', SECOND);
await page.click('#bundle-name-save-btn');
await rowFor(UNIQUE_NEW).locator('.inline-confirm').waitFor({ timeout: 5000 });
const warningNamesIt = (await rowFor(UNIQUE_NEW).locator('.inline-confirm').textContent()).includes(SECOND);
await rowFor(UNIQUE_NEW).locator('.inline-confirm-no-btn').click();
await page.waitForTimeout(300);
const keptAfterNeverMind = await hasRow(UNIQUE_NEW) && (await rowFor(SECOND).count()) === 1;

// Duplicate name again: Rename anyway goes through.
await rowFor(UNIQUE_NEW).locator('.seller-row-action-btn', { hasText: /^Rename$/ }).click();
await page.waitForSelector('#bundle-name-modal.visible', { timeout: 5000 });
await page.fill('#bundle-name-input', SECOND);
await page.click('#bundle-name-save-btn');
await rowFor(UNIQUE_NEW).locator('.inline-confirm-yes-btn').click();
await page.waitForFunction((n) => [...document.querySelectorAll('.seller-row')].filter((el) => el.textContent.includes(n)).length === 2, SECOND, { timeout: 10000 });
const renamedToDuplicate = (await rowFor(SECOND).count()) === 2 && !(await hasRow(UNIQUE_NEW));

console.log('renamed to a unique name via the modal:', renamedToUnique);
console.log('duplicate warning names the product:', warningNamesIt);
console.log('Never mind keeps the old name:', keptAfterNeverMind);
console.log('Rename anyway applies the duplicate name:', renamedToDuplicate);
console.log('native dialogs raised (should be 0):', nativeDialogs);

const pass = renamedToUnique && warningNamesIt && keptAfterNeverMind && renamedToDuplicate && nativeDialogs === 0;
await finish(browser, { pass, label: 'Sell > Manage Rename and its duplicate-name warning work in-app with native dialogs suppressed (#3249)', errors });
