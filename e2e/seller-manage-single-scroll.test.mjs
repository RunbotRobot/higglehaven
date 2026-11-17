// #3583: in Sell > Manage a product's block used to scroll inside the My
// products modal (which scrolls too), so the block ended in a hard cut and
// "Edit Price"'s Save button sat under the fold. One scroll now: the product
// list grows to its content and only the modal scrolls. Checked at phone and
// desktop width.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, finish, openAddProductLeaf } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');
const LABEL = 'Seller Single Scroll Tester';
const NAME = 'Single Scroll Widget';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 800 } });
await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForTimeout(300);

await openAddProductLeaf(page);
await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });
await page.fill('#upload-name', NAME);
await page.fill('#upload-price', '5');
await page.setInputFiles('#upload-file-input', CRATE_MODEL_PATH);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-step-dimensions').hidden, null, { timeout: 30000 });
await page.waitForTimeout(300);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), null, { timeout: 30000 });
await page.waitForTimeout(500);

const row = page.locator('.seller-row').filter({ hasText: NAME });
await row.locator('.seller-row-toggle').click();
await page.waitForTimeout(300);
await row.locator('button', { hasText: 'Edit Price' }).click();
await page.waitForTimeout(300);

async function check() {
  // The list must not be a second scroll area: its own scroll height equals
  // its client height, and it computes overflow-y as visible.
  const list = await page.evaluate(() => {
    const el = document.getElementById('seller-list');
    return { overflowY: getComputedStyle(el).overflowY, scrollable: el.scrollHeight > el.clientHeight + 1 };
  });
  // Scrolling only the modal must be enough to bring Save fully into view.
  const save = row.locator('.seller-price-save-btn');
  await page.evaluate(() => { document.getElementById('seller-modal-content').scrollTop = 1e6; });
  await page.waitForTimeout(150);
  const reachable = await page.evaluate(() => {
    const modal = document.getElementById('seller-modal-content').getBoundingClientRect();
    const b = document.querySelector('.seller-row.expanded .seller-price-save-btn');
    if (!b || !b.offsetParent) return false;
    const r = b.getBoundingClientRect();
    return r.top >= modal.top - 1 && r.bottom <= modal.bottom + 1;
  });
  await save.waitFor({ state: 'visible' });
  return { listNotScrollArea: list.overflowY === 'visible' && !list.scrollable, saveReachableByModalScroll: reachable };
}

const phone = await check();
console.log('390px:', JSON.stringify(phone));
await page.setViewportSize({ width: 1280, height: 800 });
await page.waitForTimeout(300);
const desktop = await check();
console.log('desktop:', JSON.stringify(desktop));

const ok = (l) => Object.values(l).every(Boolean);
await finish(browser, {
  pass: ok(phone) && ok(desktop),
  label: '#3583: Sell > Manage has one scroll, and Edit Price\'s Save is reachable by scrolling only the modal',
  errors,
});
