// #542: Sell mode's own search/filter/sort controls over a seller's product
// list. Two products with prices chosen so name-order and price-order
// disagree (Alpha Widget $20, Zeta Gadget $5) — proving a sort actually
// re-orders rather than just happening to already read correctly.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL = 'Search Filter Sort Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForTimeout(300);

async function uploadProduct(name, price) {
  await page.click('#upload-model-btn');
  await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });
  await page.fill('#upload-name', name);
  await page.fill('#upload-price', String(price));
  await page.setInputFiles('#upload-file-input', 'public/models/crate.glb');
  await page.click('#upload-submit-btn');
  await page.waitForFunction(() => !document.getElementById('upload-step-dimensions').hidden, null, { timeout: 30000 });
  await page.waitForTimeout(300);
  await page.click('#upload-submit-btn');
  await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), null, { timeout: 30000 });
  await page.waitForTimeout(300);
}

await uploadProduct('Alpha Widget', 20);
await uploadProduct('Zeta Gadget', 5);

async function visibleRowLabels() {
  return page.$$eval('.seller-row-label', (els) => els.map((el) => el.textContent));
}

const labelsDefault = await visibleRowLabels();
console.log('default sort is name A-Z (should be [Alpha Widget, Zeta Gadget]):', labelsDefault);

// Category filter: neither product was given a category in the upload
// wizard (no such field exists there yet), so both fall back to the
// server's own 'placeholder' default — confirms the dropdown is populated
// from real data and that filtering by it doesn't wrongly hide anything.
const categoryOptions = await page.$$eval('#seller-category-filter option', (els) => els.map((el) => el.value));
console.log('category filter options (should include "" and "placeholder"):', categoryOptions);
await page.selectOption('#seller-category-filter', 'placeholder');
await page.waitForTimeout(200);
const labelsAfterCategoryFilter = await visibleRowLabels();
console.log('both products still visible under their real category (should be 2):', labelsAfterCategoryFilter.length);
await page.selectOption('#seller-category-filter', '');

await page.selectOption('#seller-sort-select', 'price-asc');
await page.waitForTimeout(200);
const labelsPriceAsc = await visibleRowLabels();
console.log('price-asc sort re-orders by price, not name (should be [Zeta Gadget, Alpha Widget]):', labelsPriceAsc);

await page.selectOption('#seller-sort-select', 'price-desc');
await page.waitForTimeout(200);
const labelsPriceDesc = await visibleRowLabels();
console.log('price-desc sort reverses that (should be [Alpha Widget, Zeta Gadget]):', labelsPriceDesc);

await page.selectOption('#seller-sort-select', 'name-asc');
await page.fill('#seller-search-input', 'zeta');
await page.waitForTimeout(200);
const labelsSearched = await visibleRowLabels();
console.log('search matches by name, case-insensitively (should be [Zeta Gadget]):', labelsSearched);

await page.fill('#seller-search-input', 'no-such-product-xyz');
await page.waitForTimeout(200);
const labelsNoMatch = await visibleRowLabels();
const statusTextNoMatch = await page.textContent('#seller-status');
console.log('no-match search shows an explicit empty state, not a blank/broken list (rows should be 0):', labelsNoMatch.length, statusTextNoMatch);

await page.fill('#seller-search-input', '');
await page.waitForTimeout(200);
const labelsCleared = await visibleRowLabels();
console.log('clearing the search restores both products (should be 2):', labelsCleared.length);

// #2325: GET /api/catalog?category= matches case-insensitively, but no
// free-text category input exists in this upload wizard -- set one
// product's category to a differently-cased variant of 'placeholder'
// directly against the seller's own session, same idiom as other e2e
// tests reaching a state the shipped UI has no field for yet.
const zetaTemplateId = await page.evaluate(async () => {
  const res = await fetch('/api/catalog?limit=100');
  const { templates } = await res.json();
  return templates.find((t) => t.name === 'Zeta Gadget')?.templateId;
});
console.log('found Zeta Gadget\'s own templateId (should be non-empty):', zetaTemplateId);
const recasePatch = await page.evaluate(async (id) => {
  const res = await fetch(`/api/catalog/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ category: 'PLACEHOLDER' }),
  });
  return { status: res.status, category: (await res.json()).template?.category };
}, zetaTemplateId);
console.log('recased Zeta Gadget to PLACEHOLDER (should be 200, "PLACEHOLDER"):', recasePatch.status, recasePatch.category);
await page.reload({ waitUntil: 'networkidle' });
await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: false });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForTimeout(300);

const categoryOptionsAfterRecase = await page.$$eval('#seller-category-filter option', (els) => els.map((el) => el.value));
console.log('still just one "placeholder"-family option despite mixed casing, not two (should be ["", "placeholder"] in some casing):', categoryOptionsAfterRecase);
await page.selectOption('#seller-category-filter', { index: 1 });
await page.waitForTimeout(200);
const labelsAfterRecasedFilter = await visibleRowLabels();
console.log('both products (one "placeholder", one "PLACEHOLDER") still show under the one merged option (should be 2):', labelsAfterRecasedFilter.length);

const pass =
  labelsDefault.length === 2 && labelsDefault[0] === 'Alpha Widget' && labelsDefault[1] === 'Zeta Gadget' &&
  categoryOptions.includes('') && categoryOptions.includes('placeholder') &&
  labelsAfterCategoryFilter.length === 2 &&
  labelsPriceAsc.length === 2 && labelsPriceAsc[0] === 'Zeta Gadget' && labelsPriceAsc[1] === 'Alpha Widget' &&
  labelsPriceDesc.length === 2 && labelsPriceDesc[0] === 'Alpha Widget' && labelsPriceDesc[1] === 'Zeta Gadget' &&
  labelsSearched.length === 1 && labelsSearched[0] === 'Zeta Gadget' &&
  labelsNoMatch.length === 0 && statusTextNoMatch.toLowerCase().includes('no products match') &&
  labelsCleared.length === 2 &&
  recasePatch.status === 200 &&
  categoryOptionsAfterRecase.length === 2 &&
  labelsAfterRecasedFilter.length === 2 &&
  errors.length === 0;
await finish(browser, { pass, label: 'seller product list search/filter/sort (#542)', errors });
