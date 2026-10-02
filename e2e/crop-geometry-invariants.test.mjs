// #1254: extensibility-trim.test.mjs already confirms a Trim crop
// persists server-side, but never checks the actual rendered geometry —
// only the input field's own saved value. This test instead reads
// window.__lastInstanceExtent (src/main.js's createMeshForInstance, added
// for this issue) to confirm meshCrop.js's cropGeometryFromEnd really did
// shrink the cropped axis's rendered bounding box down to the entered
// length, while leaving the other two axes' real geometry untouched —
// the actual invariant this module exists to guarantee (see its own doc
// comment: "crop, not scale" and "never touched at all" for the other
// axes).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

const LABEL = 'Crop Invariants Suite Tester';
const PRODUCT_NAME = 'Crop Invariants Crate';

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

const originalX = Number(await page.locator('.upload-dimension-input[data-axis="x"]').inputValue());
const originalY = Number(await page.locator('.upload-dimension-input[data-axis="y"]').inputValue());
const originalZ = Number(await page.locator('.upload-dimension-input[data-axis="z"]').inputValue());
console.log('measured original dimensions (all should be > 0):', { originalX, originalY, originalZ });

// No dimension edit here — this test is about Trim's crop, not
// rescaleModelFile's upload-time rescale (see rescale-model-file-invariants.test.mjs).
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), { timeout: 10000 });
await page.waitForTimeout(500);

// Mark extensible on x with a tiny minimum — this test only cares that
// *some* crop is possible, not the specific floor a real seller would pick.
const row = () => page.locator('.seller-row').filter({ hasText: PRODUCT_NAME });
await row().locator('.seller-row-toggle').click();
await page.waitForTimeout(300);
await row().locator('button', { hasText: 'Extensibility' }).click();
await page.waitForTimeout(300);
const xAxisRow = row().locator('.seller-axis-row').nth(0);
await xAxisRow.locator('input[type=checkbox]').check();
await xAxisRow.locator('.seller-min-input').fill('0.05');
await row().locator('button', { hasText: 'Save' }).and(page.locator('.seller-save-btn')).click();
await page.waitForTimeout(800);

await page.click('#seller-close-btn');
await page.waitForTimeout(300);
await page.click('.mode-nav-btn[data-mode="build"]');
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
await page.waitForSelector('#add-item-btn', { timeout: 15000 });
await page.waitForTimeout(500);

await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').filter({ hasText: PRODUCT_NAME }).click();
await page.waitForTimeout(300);
await page.mouse.click(210, 400);
await page.waitForTimeout(1000);

const extentBeforeCrop = await page.evaluate(() => window.__lastInstanceExtent);
console.log('rendered extent right after placing, uncropped (x/y/z should match measured originals):', extentBeforeCrop);

await page.click('#mode-trim');
await page.waitForTimeout(500);
const cropLength = Number((originalX / 2).toFixed(2));
await page.fill('.trim-axis-field[data-trim-axis="x"] .trim-length-input', String(cropLength));
await page.locator('.trim-axis-field[data-trim-axis="x"] .trim-length-input').dispatchEvent('change');
await page.waitForTimeout(800);

const extentAfterCrop = await page.evaluate(() => window.__lastInstanceExtent);
console.log(`rendered extent after cropping x to ${cropLength} (x should now be ~${cropLength}, y/z unchanged):`, extentAfterCrop);

await page.click('#seller-close-btn').catch(() => {}); // no-op if already closed; keeps teardown tidy

const TOLERANCE = 0.03;
const closeTo = (a, b) => Math.abs(a - b) < TOLERANCE;

const uncroppedMatchesMeasured = closeTo(extentBeforeCrop.x, originalX) &&
  closeTo(extentBeforeCrop.y, originalY) && closeTo(extentBeforeCrop.z, originalZ);
const croppedAxisShrunk = closeTo(extentAfterCrop.x, cropLength);
const otherAxesUntouched = closeTo(extentAfterCrop.y, originalY) && closeTo(extentAfterCrop.z, originalZ);

const pass = originalX > 0 && originalY > 0 && originalZ > 0 &&
  uncroppedMatchesMeasured && croppedAxisShrunk && otherAxesUntouched &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: "cropGeometryFromEnd's rendered bounding box shrinks exactly on the cropped axis, untouched on the others (#1254)",
  errors,
});
