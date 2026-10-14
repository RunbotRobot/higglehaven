// Product pricing (docs/API.md's "Catalog templates" — priceCents existed
// in the schema/API from the start, but was never actually surfaced in the
// frontend anywhere: not settable during upload, not editable afterward,
// not shown to a shopper). This covers the two seller-side surfaces this
// change adds: setting a price during the upload wizard, and editing it
// afterward via a product's own "Edit Price" panel (same collapsed-panel-
// with-a-Save-step idiom as "Edit Size", see e2e/seller-upload-and-
// resize.test.mjs). The Shop-mode "name — price" readout in the tapped-
// product preview modal (#shop-product-preview-info) isn't covered here
// for the same reason real camera movement never is in this suite — see
// docs/API.md's own testing note for this feature; that's verified
// manually instead.
//
// #1601: the upload wizard's own price field is required (owner wants an
// explicit $0 for a free product, not a blank field) — only the separate
// "Edit Price" panel keeps the older null-means-unset convention, for a
// product that predates this requirement. The server itself now enforces
// the same requirement on any direct POST with a sellerId, so this suite's
// "unpriced" fixture (below) has to go through a POST-with-a-price followed
// by a direct PATCH clearing it back to null — the same clear-to-null path
// "Edit Price" itself uses — rather than a single priceCents-less POST, to
// land in that pre-#1601/legacy null-price state and keep exercising the
// panel's own give-it-a-price-after-the-fact path.
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
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
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

// N50: the price fields are plain text inputs (no more native-number
// spinner/placeholder) that reformat whatever the seller typed to
// "$X,XXX.XX" once they leave the field — checked directly here, since
// uploadProduct() below fills-and-submits in one go and never blurs.
await page.click('#upload-model-btn');
await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });
await page.fill('#upload-price', '1234.5');
await page.locator('#upload-price').blur();
const uploadPriceAfterBlur = await page.locator('#upload-price').inputValue();
console.log('upload price field after blur (should be "$1,234.50"):', uploadPriceAfterBlur);
await page.click('#upload-cancel-btn');
await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), { timeout: 10000 });

// #1601: blank price at upload time is now rejected, not treated as "no
// price set" — the wizard stays open on an error instead of creating the
// product.
await page.click('#upload-model-btn');
await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });
await page.fill('#upload-name', 'Suite Blank-Price Rejection Crate');
await page.setInputFiles('#upload-file-input', CRATE_MODEL_PATH);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-step-dimensions').hidden, { timeout: 20000 });
await page.waitForTimeout(300);
await page.click('#upload-submit-btn');
await page.waitForTimeout(500);
const blankPriceStatus = await page.locator('#upload-status').textContent();
const blankPriceModalStillOpen = await page.locator('#upload-modal').evaluate((el) => el.classList.contains('visible'));
console.log('status text after submitting with a blank price (should mention price):', blankPriceStatus);
console.log('upload modal stays open after a rejected blank-price submit (should be true):', blankPriceModalStillOpen);
await page.click('#upload-cancel-btn');
await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), { timeout: 10000 });

// A priced product at upload time.
await uploadProduct({ name: PRICED_PRODUCT, price: '12.5' });
const pricedRow = () => page.locator('.seller-row').filter({ hasText: PRICED_PRODUCT });
await pricedRow().locator('.seller-row-toggle').click();
await page.waitForTimeout(300);
const pricedRowPriceText = await pricedRow().locator('.seller-row-price').textContent();
console.log('priced product\'s row price text (should be "$12.50"):', pricedRowPriceText);
await pricedRow().locator('.seller-row-toggle').click();
await page.waitForTimeout(200);

// Same blur-reformat check, now against the Seller "Edit Price" panel —
// reopen the row, type a raw value into its price input, and confirm it
// reformats the same way (without saving, so it doesn't disturb this
// product's price for the rest of the suite).
await pricedRow().locator('.seller-row-toggle').click();
await page.waitForTimeout(300);
await pricedRow().locator('button', { hasText: 'Edit Price' }).click();
await page.waitForTimeout(300);
await pricedRow().locator('.seller-price-input').fill('1234.5');
await pricedRow().locator('.seller-price-input').blur();
const editPriceAfterBlur = await pricedRow().locator('.seller-price-input').inputValue();
console.log('Edit Price input after blur (should be "$1,234.50"):', editPriceAfterBlur);
await pricedRow().locator('button', { hasText: 'Edit Price' }).click();
await page.waitForTimeout(200);
await pricedRow().locator('.seller-row-toggle').click();
await page.waitForTimeout(200);

// An unpriced product — created directly via the API (as a product
// created before #1601, or by a non-wizard caller, would be), since the
// upload wizard itself no longer allows a blank price. Reuses
// PRICED_PRODUCT's own already-uploaded model/dimensions/color so this
// direct POST doesn't need a fresh file upload of its own. The server
// itself now also requires a price on this same create path (#1601), so
// this creates with a throwaway price and then PATCHes it straight back
// to null — landing in the identical legacy/pre-#1601 null-price state
// without ever going through the wizard.
await page.evaluate(async ({ name, referenceName }) => {
  const { seller } = await (await fetch('/api/sellers/me')).json();
  const { templates } = await (await fetch('/api/catalog?limit=100')).json();
  const reference = templates.find((t) => t.name === referenceName);
  const created = await (await fetch('/api/catalog', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      color: reference.color,
      dimensions: reference.dimensions,
      modelUrl: reference.modelUrl,
      sellerId: seller.sellerId,
      priceCents: 1,
    }),
  })).json();
  await fetch(`/api/catalog/${created.template.templateId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ priceCents: null }),
  });
}, { name: UNPRICED_PRODUCT, referenceName: PRICED_PRODUCT });
await page.reload();
await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: false });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForTimeout(300);
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

const pass = uploadPriceAfterBlur === '$1,234.50' &&
  blankPriceStatus.toLowerCase().includes('price') &&
  blankPriceModalStillOpen === true &&
  editPriceAfterBlur === '$1,234.50' &&
  pricedRowPriceText.trim() === '$12.50' &&
  unpricedRowPriceTextBefore.trim() === 'Not priced' &&
  priceInputBefore === '' &&
  unpricedRowPriceTextAfter.trim() === '$7.99' &&
  priced?.priceCents === 1250 &&
  nowPriced?.priceCents === 799 &&
  clearedRowPriceText.trim() === 'Not priced' &&
  errors.length === 0;
await finish(browser, { pass, label: 'Product pricing: set at upload, edit afterward, clear back to unpriced', errors });
