// #3249: Sell's "Mark shipped", "Refund" and "Cash out" reported their outcome
// with window.alert(). A browser that suppresses native dialogs drops those
// without a trace, so a failed refund looked like nothing happened. The
// outcome now shows in the row (or beside the balance) as a live region. This
// test refuses every native dialog and mocks the server's answers, so a
// regression to alert() shows up as a missing message.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');
const LABEL = 'Sell Action Errors Tester';
const PRODUCT_NAME = 'Inline Errors Product';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });
let nativeDialogs = 0;
page.removeAllListeners('dialog');
page.on('dialog', async (dialog) => {
  nativeDialogs += 1;
  await dialog.dismiss(); // what a suppressed dialog does: nothing, at once
});

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForTimeout(300);
await page.click('#upload-model-btn');
await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });
await page.fill('#upload-name', PRODUCT_NAME);
await page.fill('#upload-price', '40');
await page.setInputFiles('#upload-file-input', CRATE_MODEL_PATH);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-step-dimensions').hidden, null, { timeout: 60000 });
await page.waitForTimeout(300);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), null, { timeout: 60000 });
await page.waitForTimeout(500);

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };
const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

// One real-money, physical, unshipped, unpaid-out sale: shows both buttons.
await page.route('**/api/purchases?*', (route) => {
  if (route.request().method() !== 'GET') return route.continue();
  return json(route, 200, {
    totalCount: 1,
    purchases: [{
      purchaseId: 'purchase-inline-1', buyerLabel: 'A Buyer', quantity: 1, totalCents: 4000, builderShareCents: 200,
      createdAt: '2026-11-01T00:00:00.000Z', paymentIntentId: 'pi_test', isDigitalGood: false,
      shippedAt: null, deliveryConfirmedAt: null, refundedAt: null, paidOutAt: null,
    }],
  });
});
await page.route('**/api/purchases/purchase-inline-1/mark-shipped', (route) => json(route, 500, { error: 'Shipping could not be recorded right now.' }));
await page.route('**/api/purchases/purchase-inline-1/refund', (route) => json(route, 409, { error: 'That sale has already been paid out.' }));

const row = () => page.locator('.seller-row').filter({ hasText: PRODUCT_NAME });
await row().locator('.seller-row-toggle').click();
await page.waitForTimeout(300);
await row().locator('.seller-sales-toggle').click();
await page.waitForSelector('.product-sale-row', { timeout: 10000 });

await row().locator('.product-sale-row-ship-btn').click();
await page.waitForSelector('.product-sale-row-shipping .inline-action-status:not([hidden])', { timeout: 5000 });
check(/Shipping could not be recorded/.test(await row().locator('.product-sale-row-shipping .inline-action-status').innerText()), 'mark-shipped failure shown in the row');
check(await row().locator('.product-sale-row-ship-btn').isEnabled(), 'Mark shipped usable again');

await row().locator('.product-sale-row-refund-btn').click();
await page.waitForSelector('.product-sale-row-body > .inline-action-status:not([hidden])', { timeout: 5000 });
check(/already been paid out/.test(await row().locator('.product-sale-row-body > .inline-action-status').innerText()), 'refund failure shown in the row');
check(await row().locator('.product-sale-row-refund-btn').isEnabled(), 'Refund usable again');
check(await row().locator('.product-sale-row-body > .inline-action-status').getAttribute('role') === 'status', 'message is a status live region');

check(nativeDialogs === 0, `no native dialog was opened (opened ${nativeDialogs})`);

const unexpectedErrors = errors.filter((e) => !/status of (409|500)/.test(e));
await finish(browser, { pass: pass && unexpectedErrors.length === 0, label: 'sell-action-errors-inline', errors: unexpectedErrors });
