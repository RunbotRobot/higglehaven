// #3588 (interface week, #3539): Sell > My products stacked five rows of
// controls above the first product, and offered a search box, a category
// filter and a sort order to a seller with two products. Now those three
// controls only appear once the list is longer than eight products, with
// sort beside the category filter instead of on a row of its own. And when
// a delete brings the list back to eight, they go again and their values
// are reset, so a search typed while the list was long cannot keep hiding
// products behind controls nobody can reach to clear it. Phone width.
import { launchPage, chooseIdentity, acceptConfirmModal, finish } from './helpers.mjs';

const LABEL = 'Filter Controls Long List Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 800 } });

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
  await page.waitForTimeout(400);
}

const controlsShown = () => page.locator('#seller-filter-controls').isVisible();
const rowCount = () => page.locator('.seller-row').count();

// Two products: nothing to search, filter or sort yet.
await uploadProduct('Product 1', 5);
await uploadProduct('Product 2', 6);
const shownWithTwo = await controlsShown();
console.log('search/category/sort hidden with two products (should be false):', shownWithTwo);

// Eight is still not "more than eight".
for (let i = 3; i <= 8; i += 1) await uploadProduct(`Product ${i}`, 5 + i);
const shownWithEight = await controlsShown();
console.log('still hidden with eight products (should be false):', shownWithEight, 'rows:', await rowCount());

// The ninth brings them in.
await uploadProduct('Product 9', 14);
const shownWithNine = await controlsShown();
console.log('shown with nine products (should be true):', shownWithNine, 'rows:', await rowCount());

const box = async (selector) => page.locator(selector).boundingBox();
const search = await box('#seller-search-input');
const category = await box('#seller-category-filter');
const sort = await box('#seller-sort-select');
const sortBesideCategory = Math.abs(sort.y - category.y) < 4 && sort.x > category.x + category.width - 2;
const searchAbove = search.y + search.height <= category.y + 1;
const insideModal = sort.x + sort.width <= 390 && category.x >= 0;
console.log('sort sits beside the category filter on the same row, search above (should be true, true, true):', sortBesideCategory, searchAbove, insideModal);

// A search typed now, then a delete that brings the list back to eight.
await page.fill('#seller-search-input', 'Product 9');
await page.waitForTimeout(200);
const rowsFiltered = await rowCount();
console.log('search narrows the nine to one (should be 1):', rowsFiltered);

const row = page.locator('.seller-row').filter({ hasText: 'Product 9' });
await row.locator('.seller-row-toggle').click();
await page.waitForTimeout(300);
await row.locator('.seller-row-action-btn.danger', { hasText: /^Delete$/ }).click();
await acceptConfirmModal(page);
await page.waitForFunction(() => !document.getElementById('confirm-modal').classList.contains('visible'), null, { timeout: 10000 });
await page.waitForFunction(() => document.querySelectorAll('.seller-row').length === 8, null, { timeout: 15000 });
await page.waitForTimeout(300);

const shownAfterDelete = await controlsShown();
const searchValueAfterDelete = await page.inputValue('#seller-search-input');
const rowsAfterDelete = await rowCount();
console.log('after the delete the controls are gone (should be false):', shownAfterDelete);
console.log('and the old search is cleared, all eight products show (should be "" and 8):', JSON.stringify(searchValueAfterDelete), rowsAfterDelete);

const pass =
  shownWithTwo === false &&
  shownWithEight === false &&
  shownWithNine === true &&
  sortBesideCategory && searchAbove && insideModal &&
  rowsFiltered === 1 &&
  shownAfterDelete === false &&
  searchValueAfterDelete === '' &&
  rowsAfterDelete === 8 &&
  errors.length === 0;
await finish(browser, { pass, label: 'seller filter controls wait for a long list (#3588)', errors });
