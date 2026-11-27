// #4548: a seller deleting a review in their product's Reviews panel is a moderation action with a removal
// category. When the server refused it the panel only re-enabled the button, so the refusal looked like a tap that
// did nothing (the sign-post and calendar panels already say why, #3889 shape b). This forces the refusal, checks
// the panel says the server's reason, keeps the review, and that a later successful delete clears the line.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, finish, emailForLabel, grantAdmin, openAddProductLeaf } from './helpers.mjs';
const E2E_SHIPPING_ADDRESS = { name: 'E2E Buyer', line1: '1 Test Street', line2: '', city: 'Portland', region: 'OR', postalCode: '97201', country: 'US' };

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

const LABEL = 'Review Delete Refusal Tester';
const PRODUCT_NAME = 'Refusal Reviewable Product';
const REFUSAL = 'That review cannot be removed right now (test).';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForTimeout(300);
await openAddProductLeaf(page);
await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });
await page.fill('#upload-name', PRODUCT_NAME);
await page.fill('#upload-price', '10');
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

const { templates } = (await fetchJson('/api/catalog?limit=100')).body;
const template = templates.find((t) => t.name === PRODUCT_NAME);
const { builders } = (await fetchJson('/api/builders')).body;
const me = builders.find((b) => b.label === LABEL);
const { landlets } = (await fetchJson(`/api/landlets?status=claimed&ownerBuilderId=${me.builderId}&limit=100`)).body;
const instanceId = 'refusal-reviewable-instance';
await fetchJson('/api/instances', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ instanceId, landletId: landlets[0].landletId, templateId: template.templateId, x: 0, y: 0 }),
});
await grantAdmin(emailForLabel(LABEL));
await fetchJson(`/api/instances/${instanceId}/purchase`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ shippingAddress: E2E_SHIPPING_ADDRESS }) });
await fetchJson(`/api/catalog/${template.templateId}/reviews`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ rating: 4, text: 'Worth keeping' }),
});

const row = () => page.locator('.seller-row').filter({ hasText: PRODUCT_NAME });
await row().locator('.seller-row-toggle').click();
await page.waitForTimeout(300);
await row().locator('.seller-review-toggle').click();
await page.waitForSelector('.product-review-row', { timeout: 10000 });

// Refuse the first delete, as the server would for a review that cannot be removed.
let refuseDeletes = true;
await page.route('**/api/catalog/*/reviews/*', async (route) => {
  if (refuseDeletes && route.request().method() === 'DELETE') {
    await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: REFUSAL }) });
  } else {
    await route.continue();
  }
});

async function deleteTheReview() {
  await row().locator('.product-review-row-delete').first().click();
  await page.waitForSelector('#moderation-category-modal.visible', { timeout: 5000 });
  await page.locator('input[name="moderation-category"][value="other"]').check();
  await page.locator('#moderation-category-delete-btn').click();
}

await deleteTheReview();
await page.waitForFunction(
  (text) => [...document.querySelectorAll('.inline-action-status')].some((el) => !el.hidden && el.textContent.includes(text)),
  REFUSAL,
  { timeout: 10000 },
);
const statusText = await row().locator('.inline-action-status').first().textContent();
const rowsAfterRefusal = await row().locator('.product-review-row').count();
console.log('refusal line in the panel (should be the server reason):', statusText);
console.log('the review is still listed (should be 1):', rowsAfterRefusal);

// The refusal passes: the same delete now goes through, and the old line goes away.
refuseDeletes = false;
await deleteTheReview();
await page.waitForFunction(() => document.querySelectorAll('.product-review-row').length === 0, null, { timeout: 15000 });
const lineAfterSuccess = await row().locator('.inline-action-status').evaluateAll(
  (els) => els.filter((el) => !el.hidden && el.textContent.trim()).map((el) => el.textContent),
);
console.log('no refusal line after a successful delete (should be none):', lineAfterSuccess);

const expectedErrors = errors.filter((e) => !String(e).includes('403'));
const pass = statusText.includes(REFUSAL) && rowsAfterRefusal === 1 && lineAfterSuccess.length === 0 && expectedErrors.length === 0;
await finish(browser, { pass, label: 'Seller review delete: a refusal is said in the panel (#4548)', errors: expectedErrors });
