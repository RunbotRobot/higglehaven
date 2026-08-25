// Product pricing (docs/API.md's "Catalog templates" — priceCents existed
// in the schema/API from the start, but was never actually surfaced in the
// frontend anywhere: not settable during upload, not editable afterward,
// not shown to a shopper). This covers the two seller-side surfaces this
// change adds: setting a price during the upload wizard, and editing it
// afterward via a product's own "Edit Price" panel (same collapsed-panel-
// with-a-Save-step idiom as "Edit Size", see e2e/seller-upload-and-
// resize.test.mjs). The Shop-mode "name — price" readout near a placed
// instance (#shop-product-info) isn't covered here for the same reason
// real camera movement never is in this suite — see docs/API.md's own
// testing note for this feature; that's verified manually instead.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

const LABEL = 'Pricing Suite Tester';
const PRICED_PRODUCT = 'Suite Priced Crate';
const UNPRICED_PRODUCT = 'Suite Unpriced Crate';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 10000 });
await page.waitForTimeout(300);

async function uploadProduct({ name, price }) {
  await page.click('#upload-model-btn');
  await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });
  await page.fill('#upload-name', name);
  if (price !== undefined) await page.fill('#upload-price', price);
  await page.setInputFiles('#upload-file-input', CRATE_MODEL_PATH);
  await page.click('#upload-submit-btn');
  await page.waitForFunction(() => !document.getElementById('upload-step-dimensions').hidden, { timeout: 20000 });
  await page.waitForTimeout(300);
  await page.click('#upload-submit-btn');
  await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), { timeout: 10000 });
  await page.waitForTimeout(500);
}

// A priced product at upload time.
await uploadProduct({ name: PRICED_PRODUCT, price: '12.5' });
const pricedRow = () => page.locator('.seller-row').filter({ hasText: PRICED_PRODUCT });
await pricedRow().locator('.seller-row-toggle').click();
await page.waitForTimeout(300);
const pricedRowPriceText = await pricedRow().locator('.seller-row-price').textContent();
console.log('priced product\'s row price text (should be "$12.50"):', pricedRowPriceText);
await pricedRow().locator('.seller-row-toggle').click();
await page.waitForTimeout(200);

// An unpriced product — blank price at upload time.
await uploadProduct({ name: UNPRICED_PRODUCT });
const unpricedRow = () => page.locator('.seller-row').filter({ hasText: UNPRICED_PRODUCT });
await unpricedRow().locator('.seller-row-toggle').click();
await page.waitForTimeout(300);
const unpricedRowPriceTextBefore = await unpricedRow().locator('.seller-row-price').textContent();
console.log('unpriced product\'s row price text before editing (should be "Not priced"):', unpricedRowPriceTextBefore);

// Give it a price after the fact via Edit Price.
await unpricedRow().locator('button', { hasText: 'Edit Price' }).click();
await page.waitForTimeout(300);
const priceInputBefore = await unpricedRow().locator('.seller-price-input').inputValue();
console.log('Edit Price input starts blank for a never-priced product (should be ""):', JSON.stringify(priceInputBefore));
await unpricedRow().locator('.seller-price-input').fill('7.99');
await unpricedRow().locator('button', { hasText: 'Save Price' }).click();
await page.waitForFunction(
  () => Array.from(document.querySelectorAll('.seller-price-status')).some((el) => el.textContent === 'Saved.'),
  { timeout: 10000 },
);
const unpricedRowPriceTextAfter = await unpricedRow().locator('.seller-row-price').textContent();
console.log('previously-unpriced product\'s row price text after editing (should be "$7.99"):', unpricedRowPriceTextAfter);

// Persisted server-side, not just in the DOM.
const { templates } = await page.evaluate(async () => {
  const res = await fetch('/api/catalog?limit=100');
  return res.json();
});
const priced = templates.find((t) => t.name === PRICED_PRODUCT);
const nowPriced = templates.find((t) => t.name === UNPRICED_PRODUCT);
console.log('server-side priceCents for the priced-at-upload product (should be 1250):', priced?.priceCents);
console.log('server-side priceCents for the edited-after-the-fact product (should be 799):', nowPriced?.priceCents);

// Clearing the price back to blank removes it (null), not zero.
await unpricedRow().locator('.seller-price-input').fill('');
await unpricedRow().locator('button', { hasText: 'Save Price' }).click();
await page.waitForFunction(
  () => Array.from(document.querySelectorAll('.seller-row-price')).some((el) => el.textContent === 'Not priced'),
  { timeout: 10000 },
);
const clearedRowPriceText = await unpricedRow().locator('.seller-row-price').textContent();
console.log('row price text after clearing it back to blank (should be "Not priced"):', clearedRowPriceText);

const pass = pricedRowPriceText.trim() === '$12.50' &&
  unpricedRowPriceTextBefore.trim() === 'Not priced' &&
  priceInputBefore === '' &&
  unpricedRowPriceTextAfter.trim() === '$7.99' &&
  priced?.priceCents === 1250 &&
  nowPriced?.priceCents === 799 &&
  clearedRowPriceText.trim() === 'Not priced' &&
  errors.length === 0;
await finish(browser, { pass, label: 'Product pricing: set at upload, edit afterward, clear back to unpriced', errors });
