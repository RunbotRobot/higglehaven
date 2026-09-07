// Regression test for #423: canceling the upload wizard's "Confirm
// Dimensions" step used to not actually stop the in-flight product
// creation — the background POST /api/catalog call ran to completion
// anyway, silently creating the product the seller believed they'd
// canceled. Delays that request via page.route so there's a real,
// deterministic window to click Cancel while it's still in flight.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

const LABEL = 'Upload Cancel Race Tester';
const PRODUCT_NAME = 'Cancel Race Crate';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

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

// Delay the actual product-creation request so there's a real window to
// click Cancel while it's still in flight.
await page.route('**/api/catalog', async (route) => {
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await route.continue();
});

await page.click('#upload-submit-btn'); // "Create Product"
await page.waitForTimeout(200); // let the request actually start
await page.click('#upload-cancel-btn'); // Cancel while the create is still in flight
await page.waitForTimeout(2500); // let the delayed request resolve either way

const modalStillVisible = await page.evaluate(() => document.getElementById('upload-modal').classList.contains('visible'));
console.log('upload modal closed after cancel (should be true, i.e. NOT visible):', !modalStillVisible);

const catalogHasProduct = await page.evaluate((name) => {
  const rows = [...document.querySelectorAll('.seller-row')];
  return rows.some((row) => row.textContent.includes(name));
}, PRODUCT_NAME);
console.log('canceled product does NOT appear in seller list (should be true):', !catalogHasProduct);

const pass = !modalStillVisible && !catalogHasProduct && errors.length === 0;
await finish(browser, { pass, label: '#423: canceling Confirm Dimensions stops the in-flight product creation from taking effect', errors });
