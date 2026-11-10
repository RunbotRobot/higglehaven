// #3378 (owner, 2026-11-10): in Sell > Manage the buttons that act on a whole
// product (Preview, Rename, Duplicate, Delete) sit directly under its name,
// above the dimensions and every settings toggle, with the status line beside
// them. Checked at phone width and at desktop width.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');
const LABEL = 'Seller Actions On Top Tester';
const NAME = 'Actions On Top Widget';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 800 } });
await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForTimeout(300);

await page.click('#upload-model-btn');
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

async function layout() {
  return row.evaluate((el) => {
    const top = (sel) => el.querySelector(sel)?.getBoundingClientRect();
    const toggle = top('.seller-row-toggle');
    const actions = top('.seller-row-actions');
    const dims = top('.seller-row-dims');
    const firstSetting = [...el.querySelectorAll('.seller-row-details button')].find((b) => !b.closest('.seller-row-actions'));
    const status = top('.seller-row-status');
    const rename = [...el.querySelectorAll('.seller-row-actions button')].find((b) => b.textContent.trim() === 'Rename')?.getBoundingClientRect();
    return {
      actionsBelowName: actions.top >= toggle.bottom - 1,
      actionsAboveDims: actions.bottom <= dims.top + 1,
      actionsAboveSettings: !firstSetting || actions.bottom <= firstSetting.getBoundingClientRect().top + 1,
      statusRightAfterActions: status.top >= actions.bottom - 1 && status.top - actions.bottom < 60,
      renameWithinFirstScreen: rename.bottom <= window.innerHeight,
    };
  });
}

const phone = await layout();
console.log('390px layout:', JSON.stringify(phone));
await page.setViewportSize({ width: 1280, height: 800 });
await page.waitForTimeout(300);
const desktop = await layout();
console.log('desktop layout:', JSON.stringify(desktop));

// The status line (rename/duplicate/delete errors) follows the buttons directly,
// so a result appears next to the button that caused it.
const statusIsNextSibling = await row.evaluate((el) => el.querySelector('.seller-row-actions').nextElementSibling?.classList.contains('seller-row-status'));
console.log('status line sits right after the buttons:', statusIsNextSibling);

const ok = (l) => Object.values(l).every(Boolean);
await finish(browser, {
  pass: ok(phone) && ok(desktop) && statusIsNextSibling,
  label: '#3378: Sell > Manage action buttons sit under the product name, above every setting',
  errors,
});
