// Refunds + dáller-commission clawback (docs/SPEC.md §5, docs/API.md's
// "Simulated purchases" > "Refunds", migrations/0052_purchase_refunds.sql)
// — undoes a simulated purchase's commission credit, not real currency
// (nothing real moved in the first place). Refunding is seller-initiated
// through the Seller modal's own "Sales" panel (a product's full sale
// history, across every builder hosting an instance of it), standing in
// for a real customer-service-initiated refund — shoppers have no account
// here to authenticate a self-service "my purchases" view against. This
// covers the Sales panel's refund button and the separate "Edit Returns
// Policy" panel through the real UI; the no-returns-policy REJECTION path
// isn't covered here for the same reason prohibited-content rejection
// isn't in e2e/digital-goods.test.mjs — a real 400 trips the shared
// errors.length===0 check (see worker/index.test.js's own "Simulated
// purchases" describe block instead).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

const LABEL = 'Purchase Refunds Suite Tester';
const PRODUCT_NAME = 'Suite Refundable Product';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 10000 });
await page.waitForTimeout(300);
await page.click('#upload-model-btn');
await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });
await page.fill('#upload-name', PRODUCT_NAME);
await page.fill('#upload-price', '40');
await page.setInputFiles('#upload-file-input', CRATE_MODEL_PATH);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-step-dimensions').hidden, { timeout: 20000 });
await page.waitForTimeout(300);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), { timeout: 10000 });
await page.waitForTimeout(500);

async function fetchJson(pathAndQuery, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [pathAndQuery, options]);
}

const { templates } = (await fetchJson('/api/catalog?limit=100')).body;
const template = templates.find((t) => t.name === PRODUCT_NAME);
console.log('uploaded, priced product found in catalog:', !!template);

const { builders } = (await fetchJson('/api/builders')).body;
const builder = builders.find((b) => b.label === LABEL);
const { landlets } = (await fetchJson(`/api/landlets?status=claimed&ownerBuilderId=${builder.builderId}&limit=100`)).body;
const landlet = landlets[0];

const instanceId = 'suite-refundable-instance';
await fetchJson('/api/instances', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ instanceId, landletId: landlet.landletId, templateId: template.templateId, x: 0, y: 0 }),
});

// A real sale to refund, placed via the exact API the in-world "Simulate
// Purchase" hint calls.
const purchased = await fetchJson(`/api/instances/${instanceId}/purchase`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ buyerLabel: 'A Refund Shopper' }),
});
console.log('purchase created (status should be 201):', purchased.status);
const balanceAfterSale = (await fetchJson('/api/builders')).body.builders.find((b) => b.builderId === builder.builderId).dallersBalanceCents;

// Open the product's row and its Sales panel.
const row = () => page.locator('.seller-row').filter({ hasText: PRODUCT_NAME });
await row().locator('.seller-row-toggle').click();
await page.waitForTimeout(300);
await row().locator('.seller-sales-toggle').click();
await page.waitForTimeout(500);

const saleRowCount = await row().locator('.product-sale-row').count();
const saleRowText = await row().locator('.product-sale-row').first().textContent();
console.log('sale rows shown (should be 1):', saleRowCount);
console.log('sale row text (should mention "A Refund Shopper" and "You earned"):', saleRowText);

// Refund it via its own row button — the actual moderation path a seller
// (or, in the real product, customer service on their behalf) would use.
await row().locator('.product-sale-row-refund-btn').click();
await page.waitForFunction(
  () => Array.from(document.querySelectorAll('.product-sale-row-refunded')).some((el) => el.textContent === 'Refunded'),
  { timeout: 10000 },
);
const refundedLabelCount = await row().locator('.product-sale-row-refunded').count();
const refundBtnCountAfter = await row().locator('.product-sale-row-refund-btn').count();
console.log('rows showing "Refunded" after clicking refund (should be 1):', refundedLabelCount);
console.log('refund buttons remaining (should be 0 — nothing left to refund again):', refundBtnCountAfter);

const balanceAfterRefund = (await fetchJson('/api/builders')).body.builders.find((b) => b.builderId === builder.builderId).dallersBalanceCents;
console.log('builder balance before/after refund (should differ by exactly the commission clawed back):', balanceAfterSale, balanceAfterRefund);

const { purchases: serverPurchases } = (await fetchJson(`/api/purchases?templateId=${template.templateId}`)).body;
console.log('server-side refundedAt set (should be non-null):', serverPurchases[0]?.refundedAt);

// Separately, exercise the "Edit Returns Policy" panel (no refund attempt
// against this flag — see file header for why that path is worker-test-only).
const noReturnsTextBefore = await row().locator('.seller-row-no-returns').textContent();
console.log('returns policy row text before editing (should be "Returns: accepted"):', noReturnsTextBefore);
await row().locator('.seller-no-returns-toggle').click();
await page.waitForTimeout(300);
await row().locator('.seller-no-returns-checkbox-label input[type="checkbox"]').check();
await row().locator('button', { hasText: 'Save Returns Policy' }).click();
await page.waitForFunction(
  () => Array.from(document.querySelectorAll('.seller-no-returns-status')).some((el) => el.textContent === 'Saved.'),
  { timeout: 10000 },
);
const noReturnsTextAfter = await row().locator('.seller-row-no-returns').textContent();
console.log('returns policy row text after opting out (should be "Returns: not accepted"):', noReturnsTextAfter);
const { template: serverTemplate } = (await fetchJson(`/api/catalog/${template.templateId}`)).body;
console.log('server-side metadata.noReturns (should be true):', serverTemplate.metadata.noReturns);

const pass = !!template && purchased.status === 201 &&
  saleRowCount === 1 &&
  saleRowText.includes('A Refund Shopper') && saleRowText.includes('You earned') &&
  refundedLabelCount === 1 && refundBtnCountAfter === 0 &&
  balanceAfterSale - balanceAfterRefund === purchased.body.purchase.builderShareCents &&
  serverPurchases.length === 1 && !!serverPurchases[0].refundedAt &&
  noReturnsTextBefore.trim() === 'Returns: accepted' &&
  noReturnsTextAfter.trim() === 'Returns: not accepted' &&
  serverTemplate.metadata.noReturns === true &&
  errors.length === 0;
await finish(browser, { pass, label: 'Refunds: Sales panel refund + commission clawback, Edit Returns Policy panel', errors });
