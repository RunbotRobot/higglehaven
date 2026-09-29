// #1045: the Seller modal's "Duplicate" button silently dropped
// category/subcategory, so duplicating an avatar-category product produced
// a 'placeholder'-category copy — a buyer of that copy would pay and get no
// equippable avatar at all, with nothing visibly wrong. Confirms the fix by
// duplicating a real avatar-category upload through the actual Duplicate
// button and checking the resulting copy's category via the API.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

const LABEL = 'Duplicate Category Tester';
const PRODUCT_NAME = 'Duplicate Category Avatar';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 10000 });
await page.waitForTimeout(300);

await page.click('#upload-model-btn');
await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });
await page.fill('#upload-name', PRODUCT_NAME);
await page.setInputFiles('#upload-file-input', CRATE_MODEL_PATH);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-step-dimensions').hidden, { timeout: 20000 });
await page.waitForTimeout(300);
// #712's "List as an equippable avatar" checkbox — sets category: 'avatar'
// server-side, which is the field the Duplicate button used to drop.
await page.check('#upload-avatar-category-checkbox');
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), { timeout: 10000 });
await page.waitForTimeout(500);

async function fetchJson(pathAndQuery, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [pathAndQuery, options]);
}

const { templates: templatesBefore } = (await fetchJson('/api/catalog?limit=100')).body;
const original = templatesBefore.find((t) => t.name === PRODUCT_NAME);
console.log('uploaded product has avatar category (should be true):', original?.category === 'avatar');

const row = page.locator('.seller-row').filter({ hasText: PRODUCT_NAME });
await row.locator('.seller-row-toggle').click();
await page.waitForTimeout(300);
await row.locator('.seller-row-action-btn', { hasText: 'Duplicate' }).click();
await page.waitForTimeout(500);

const { templates: templatesAfter } = (await fetchJson('/api/catalog?limit=100')).body;
const copy = templatesAfter.find((t) => t.name === `${PRODUCT_NAME} (copy)`);
console.log('duplicate exists (should be true):', Boolean(copy));
console.log('duplicate kept avatar category (should be true, was the #1045 bug):', copy?.category === 'avatar');
console.log('duplicate category value:', copy?.category);

const pass = original?.category === 'avatar' && Boolean(copy) && copy?.category === 'avatar' && errors.length === 0;
await finish(browser, { pass, label: 'Duplicate button preserves avatar category (#1045)', errors });
