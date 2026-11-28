// #4681: one order's money, read everywhere a person reads it. A product priced $1,234.56 (large enough for a thousands
// separator, with cents) is bought once; the product's row in Sell, the seller's sale row for that order and the buyer's row in
// My purchases must all print the same figure. A sale row once showed $0.24 on a $24.00 sale because one place divided by 100
// twice; the formatters are now one function (shared/money.js, tested in src/money.test.js), and this reads the pages themselves
// so a surface that prints a different NUMBER would still be caught. (The product card in the world and the receipt email are
// not here: the card is covered by e2e/shipping-address-checkout.test.mjs reading its own price, and the basket email by
// worker/basket-checkout.test.js.)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, finish, emailForLabel, grantAdmin, openAddProductLeaf, openAccountMenu } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');
const LABEL = 'Money Everywhere Tester';
const PRODUCT = 'Pricey Crate';
const PRICE = '$1,234.56';
const ADDRESS = { name: 'E2E Buyer', line1: '1 Test Street', line2: '', city: 'Portland', region: 'OR', postalCode: '97201', country: 'US' };

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForTimeout(300);

await openAddProductLeaf(page);
await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });
await page.fill('#upload-name', PRODUCT);
await page.fill('#upload-price', '1234.56');
await page.setInputFiles('#upload-file-input', CRATE_MODEL_PATH);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-step-dimensions').hidden, null, { timeout: 30000 });
await page.waitForTimeout(300);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), null, { timeout: 20000 });
await page.waitForTimeout(500);

async function fetchJson(pathAndQuery, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [pathAndQuery, options]);
}
const json = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const template = (await fetchJson('/api/catalog?limit=100')).body.templates.find((t) => t.name === PRODUCT);
const { builder } = (await fetchJson('/api/builders/me')).body;
const landlet = (await fetchJson(`/api/landlets?status=claimed&ownerBuilderId=${builder.builderId}&limit=100`)).body.landlets[0];
const instanceId = 'money-everywhere-instance';
await fetchJson('/api/instances', json({ instanceId, landletId: landlet.landletId, templateId: template.templateId, x: 0, y: 0 }));
await grantAdmin(emailForLabel(LABEL));
const purchased = await fetchJson(`/api/instances/${instanceId}/purchase`, json({ shippingAddress: ADDRESS, buyerLabel: 'A Money Shopper' }));

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };
check(purchased.status === 201, `the purchase was made (status ${purchased.status})`);

// 1. The product's row in Sell, and 2. the seller's sale row for the order, inside it.
const row = () => page.locator('.seller-row').filter({ hasText: PRODUCT });
await row().locator('.seller-row-toggle').click();
await page.waitForTimeout(300);
const rowText = await row().textContent();
check(rowText.includes(PRICE), `the product's row in Sell reads ${PRICE} (got: ${rowText.slice(0, 160).replace(/\s+/g, ' ')})`);
await row().locator('.seller-sales-toggle').click();
await page.waitForTimeout(500);
const saleText = await row().locator('.product-sale-row').first().textContent();
check(saleText.includes(PRICE), `the seller's sale row reads ${PRICE} (got: ${saleText.replace(/\s+/g, ' ')})`);
// (A figure divided by 100 twice would read $12.35 here, not $1,234.56, so the line above is the check for it; the "You earned"
// amount in this row is the builder's own, smaller share and rightly differs.)

// 3. The buyer's own row in My purchases (this account is both).
await page.click('#seller-close-btn');
await page.waitForTimeout(300);
await openAccountMenu(page);
await page.click('#my-purchases-btn');
await page.waitForSelector('#my-purchases-modal.visible #my-purchases-list .my-purchase-row', { timeout: 10000 });
const mineText = await page.locator('#my-purchases-list .my-purchase-row').first().textContent();
check(mineText.includes(PRICE), `My purchases reads ${PRICE} (got: ${mineText.replace(/\s+/g, ' ')})`);

await finish(browser, { pass: pass && errors.length === 0, label: '#4681: one order reads the same in Sell, the sale row and My purchases', errors });
