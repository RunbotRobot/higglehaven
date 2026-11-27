// #3704 (Sell in the bud, 6/6, slice 3): the Orders leaf lists every sale of the seller's products
// in one place. A fresh seller has none ("No orders yet."); with the list mocked, each row names its
// product and the leaf stays inside a 390x844 screen. (#4541) Orders past the first page come by "Show older orders".
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL = 'Orders Leaf Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });
await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#account-menu-toggle', { state: 'visible', timeout: 30000 });

async function openOrders() {
  const expanded = await page.evaluate(() => document.getElementById('account-menu-panel')?.classList.contains('expanded'));
  if (!expanded) await page.click('#account-menu-toggle');
  await page.click('#bud-petal-sell-orders');
  await page.waitForSelector('#bud-leaf-orders', { timeout: 5000 });
}

await openOrders();
await page.waitForSelector('#bud-leaf-orders .empty-state:has-text("No orders yet.")', { timeout: 15000 });
console.log('A seller with no sales sees "No orders yet." (should be reached)');
await page.click('#bud-leaf-orders .bud-leaf-close');
await page.waitForSelector('#bud-leaf-orders', { state: 'detached', timeout: 5000 });

await page.route('**/api/purchases?mine=seller', async (route) => {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      totalCount: 3,
      nextCursor: 'c1',
      purchases: [
        { purchaseId: 'p1', productName: 'Garden Gnome', buyerLabel: 'Ada', quantity: 1, totalCents: 1500, builderShareCents: 100, createdAt: '2026-11-18T12:00:00Z', refundedAt: null, paidOutAt: null, paymentIntentId: null, isDigitalGood: false },
        { purchaseId: 'p2', productName: 'Old Bench', buyerLabel: 'Grace', quantity: 2, totalCents: 4000, builderShareCents: 300, createdAt: '2026-11-17T12:00:00Z', refundedAt: '2026-11-18T01:00:00Z', paidOutAt: null, paymentIntentId: null, isDigitalGood: false },
      ],
    }),
  });
});
// #4541: the older order arrives by cursor, behind "Show older orders".
await page.route('**/api/purchases?mine=seller&cursor=c1', async (route) => {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      totalCount: 3,
      nextCursor: null,
      purchases: [
        { purchaseId: 'p3', productName: 'Ancient Lamp', buyerLabel: 'Linus', quantity: 1, totalCents: 900, builderShareCents: 50, createdAt: '2026-11-10T12:00:00Z', refundedAt: null, paidOutAt: null, paymentIntentId: null, isDigitalGood: false },
      ],
    }),
  });
});
await openOrders();
await page.waitForSelector('#bud-leaf-orders .product-sale-row', { timeout: 15000 });
const rows = await page.locator('#bud-leaf-orders .product-sale-row').count();
const names = await page.locator('#bud-leaf-orders .product-sale-row-product').allInnerTexts();
const refunded = await page.locator('#bud-leaf-orders .product-sale-row-refunded', { hasText: 'Refunded' }).count();
const fits = await page.locator('#bud-leaf-orders').evaluate((el) => {
  const r = el.getBoundingClientRect();
  return r.left >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight;
});
console.log('Rows (should be 2):', rows, '; product names:', names, '; refunded label (should be 1):', refunded, '; leaf fits the screen (should be true):', fits);

const summaryBefore = await page.locator('#bud-leaf-orders .orders-note').first().innerText();
await page.click('#bud-leaf-orders .orders-more');
await page.waitForFunction(() => document.querySelectorAll('#bud-leaf-orders .product-sale-row').length === 3, null, { timeout: 10000 });
const moreHidden = await page.locator('#bud-leaf-orders .orders-more').isHidden();
const summaryAfter = await page.locator('#bud-leaf-orders .orders-note').first().innerText();
console.log('Summary before/after:', summaryBefore, '/', summaryAfter, '; button hidden once none are left (should be true):', moreHidden);

const pass = /Showing newest 2 of 3/.test(summaryBefore) && /^3 orders/.test(summaryAfter) && moreHidden && rows === 2 && names.join('|') === 'Garden Gnome|Old Bench' && refunded === 1 && fits && errors.length === 0;
await finish(browser, { pass, label: '#3704: the Orders leaf lists every sale with its product and fits the phone screen', errors });
