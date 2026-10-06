// #1377: same truncation-notice gap #1331 fixed for the sibling Reviews
// panel -- handlePurchases (worker/index.js) already returns a real,
// uncapped totalCount distinct from the windowed (LIMIT 100) purchases
// array, but renderSales() (src/main.js) never compared them to show a
// "Showing newest N of M" notice the way Reviews/sign-posts/calendar-events
// already do. Mocking the GET response directly proves the frontend now
// shows that notice, without needing 100+ real purchases.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

const LABEL = 'Sales Truncation Tester';
const PRODUCT_NAME = 'Truncated Sales Product';
const FAKE_SALES_COUNT = 214;

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

await page.route('**/api/purchases*', async (route) => {
  if (route.request().method() !== 'GET') {
    await route.continue();
    return;
  }
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      purchases: [
        { purchaseId: 'fake-purchase-1', buyerLabel: LABEL, quantity: 1, totalCents: 1000, builderShareCents: 500, createdAt: new Date().toISOString() },
        { purchaseId: 'fake-purchase-2', buyerLabel: LABEL, quantity: 2, totalCents: 2000, builderShareCents: 1000, createdAt: new Date().toISOString() },
      ],
      totalCount: FAKE_SALES_COUNT,
    }),
  });
});

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 10000 });
await page.waitForTimeout(300);

await page.click('#upload-model-btn');
await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });
await page.fill('#upload-name', PRODUCT_NAME);
await page.fill('#upload-price', '10');
await page.setInputFiles('#upload-file-input', CRATE_MODEL_PATH);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-step-dimensions').hidden, { timeout: 20000 });
await page.waitForTimeout(300);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), { timeout: 10000 });
await page.waitForTimeout(500);

const row = () => page.locator('.seller-row').filter({ hasText: PRODUCT_NAME });
await row().locator('.seller-row-toggle').click();
await page.waitForTimeout(300);
await row().locator('.seller-sales-toggle').click();
await page.waitForFunction(
  () => document.querySelectorAll('.product-sale-row').length === 2,
  { timeout: 5000 },
);

const truncatedEl = row().locator('.seller-sales-truncated');
const truncatedHidden = await truncatedEl.evaluate((el) => el.hidden);
const truncatedText = await truncatedEl.textContent();
console.log('truncation notice hidden (should be false):', truncatedHidden);
console.log(`truncation notice text (should mention the real count ${FAKE_SALES_COUNT}, not the mocked array length 2):`, truncatedText);

const pass =
  truncatedHidden === false &&
  truncatedText.includes(String(FAKE_SALES_COUNT)) &&
  truncatedText.includes('2') &&
  errors.length === 0;
await finish(browser, { pass, label: 'Sales panel shows a truncation notice built from the real count, not the windowed array length (#1377)', errors });
