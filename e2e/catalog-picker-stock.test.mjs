// The Add Item catalog picker surfaces #1948's stockQuantity so a builder
// can weigh risk before placing (#1951): a sold-out template reads "Sold
// out", a finite-but-available one reads "N left", and an unlimited
// (stockQuantity: null, the common/default case) template shows neither.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Catalog Picker Stock Tester';
const SOLD_OUT_NAME = 'Sold-Out Antique Lamp';
const LOW_STOCK_NAME = 'Finite Cottage Bricks';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

await page.evaluate(async ({ soldOutName, lowStockName }) => {
  const create = (name, stockQuantity) => fetch('/api/catalog', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      color: '#a0522d',
      dimensions: { width: 1, depth: 1, height: 1 },
      priceCents: 500,
      stockQuantity,
    }),
  });
  await create(soldOutName, 0);
  await create(lowStockName, 3);
}, { soldOutName: SOLD_OUT_NAME, lowStockName: LOW_STOCK_NAME });

// activeCatalog is only fetched at bootstrap — reload to pick up the two
// templates just created.
await page.reload();
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: false });

await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });

const soldOutTile = () => page.locator('#catalog-picker-grid .catalog-tile').filter({ hasText: SOLD_OUT_NAME });
const lowStockTile = () => page.locator('#catalog-picker-grid .catalog-tile').filter({ hasText: LOW_STOCK_NAME });
const unlimitedTile = () => page.locator('#catalog-picker-grid .catalog-tile').filter({ hasText: 'Tree' });

const soldOutStockText = await soldOutTile().locator('.catalog-tile-stock').textContent();
const soldOutHasDangerClass = await soldOutTile().locator('.catalog-tile-stock-sold-out').count();
const lowStockStockText = await lowStockTile().locator('.catalog-tile-stock').textContent();
const unlimitedStockCount = await unlimitedTile().locator('.catalog-tile-stock').count();

console.log('sold-out tile stock text (should be "Sold out"):', soldOutStockText);
console.log('sold-out tile has the sold-out styling class (should be 1):', soldOutHasDangerClass);
console.log('low-stock tile stock text (should be "3 left"):', lowStockStockText);
console.log('unlimited-stock tile has no stock indicator at all (should be 0):', unlimitedStockCount);

const pass = soldOutStockText === 'Sold out' &&
  soldOutHasDangerClass === 1 &&
  lowStockStockText === '3 left' &&
  unlimitedStockCount === 0 &&
  errors.length === 0;
await finish(browser, { pass, label: 'Add Item catalog picker shows stock/sold-out indicator (#1951)', errors });
