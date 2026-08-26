// A seller marks an uploaded product extensible on one axis (see docs/API.md's
// "Extensible products (crop)"), a builder places it and crops it shorter
// with Trim, and reloading confirms the crop persisted server-side.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, clickUntilSelected, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

const LABEL = 'Trim Suite Tester';
const PRODUCT_NAME = 'Trim Suite Crate';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 10000 });
await page.waitForTimeout(300);
await page.click('#upload-model-btn');
await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });
await page.fill('#upload-name', PRODUCT_NAME);
await page.setInputFiles('#upload-file-input', CRATE_MODEL_PATH);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-step-dimensions').hidden, { timeout: 20000 });
await page.waitForTimeout(300);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), { timeout: 10000 });
await page.waitForTimeout(500);

// Mark it extensible on x with a 0.2m minimum.
const row = () => page.locator('.seller-row').filter({ hasText: PRODUCT_NAME });
await row().locator('.seller-row-toggle').click();
await page.waitForTimeout(300);
await row().locator('button', { hasText: 'Extensibility' }).click();
await page.waitForTimeout(300);
const xAxisRow = row().locator('.seller-axis-row').nth(0);
await xAxisRow.locator('input[type=checkbox]').check();
await xAxisRow.locator('.seller-min-input').fill('0.2');
await row().locator('button', { hasText: 'Save' }).and(page.locator('.seller-save-btn')).click();
await page.waitForTimeout(800);
const saveStatus = await row().locator('.seller-row-status').textContent();
console.log('extensibility save status (should say Saved):', saveStatus);

await page.click('#seller-close-btn');
await page.waitForTimeout(300);

// Place it, select it, and confirm the X trim field is the only one active.
await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').filter({ hasText: PRODUCT_NAME }).click();
await page.waitForTimeout(300);
await page.mouse.click(210, 400);
await page.waitForTimeout(1000);
const productInfo = await page.textContent('#product-info');
console.log('selected product right after placing (should be product name):', productInfo);

await page.click('#mode-trim');
await page.waitForTimeout(500);
const xActive = await page.locator('.trim-axis-field[data-trim-axis="x"]').evaluate((el) => el.classList.contains('active'));
const yActive = await page.locator('.trim-axis-field[data-trim-axis="y"]').evaluate((el) => el.classList.contains('active'));
console.log('X trim field active (should be true):', xActive);
console.log('Y trim field active (should be false, not declared extensible):', yActive);

// Crop it down to 0.5m via the text field (not the drag handle — simpler
// and just as real a write path, see docs/API.md's "Dragging the Trim
// gizmo" for the handle itself).
await page.fill('.trim-axis-field[data-trim-axis="x"] .trim-length-input', '0.5');
await page.locator('.trim-axis-field[data-trim-axis="x"] .trim-length-input').dispatchEvent('change');
await page.waitForTimeout(800);

// Reload — a fresh session, same builder — and confirm the crop persisted.
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: false });
await page.waitForSelector('#account-menu-toggle', { timeout: 10000 });
await page.waitForTimeout(2000);

const infoAfterReload = await clickUntilSelected(page, {
  x: 210, yStart: 330, yEnd: 400, expectedText: PRODUCT_NAME,
});
const reselected = infoAfterReload.includes(PRODUCT_NAME);
console.log('reselected after reload (should be true):', reselected, infoAfterReload);

await page.click('#mode-trim');
await page.waitForTimeout(500);
const xAfterReload = await page.locator('.trim-axis-field[data-trim-axis="x"] .trim-length-input').inputValue();
console.log('persisted X length after reload (should be 0.50):', xAfterReload);

const pass = saveStatus.includes('Saved') && productInfo.includes(PRODUCT_NAME) &&
  xActive === true && yActive === false &&
  reselected && Math.abs(Number(xAfterReload) - 0.5) < 0.01 &&
  errors.length === 0;
await finish(browser, { pass, label: 'extensibility + Trim crop persists across reload', errors });
