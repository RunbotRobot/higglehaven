// Regression test for #457: metadataSaveBusy/metadataSaveButtons used to
// live entirely inside renderSellerList()'s per-call closure, reset to
// false every time openSellerModal() re-renders the row list. Closing the
// Seller modal while a metadata PATCH was still in flight and reopening it
// (openSellerModal always calls renderSellerList() fresh; closeSellerModal
// never cancels/awaits an in-flight save) produced a brand-new row whose
// fresh `busy` flag let a second panel's save start before the first had
// actually finished — recreating the exact overlapping-PATCH clobber PR
// #424 was written to prevent, since the server replaces metadata_json
// wholesale rather than merging it. Delays the first PATCH to get a
// deterministic window in which to close+reopen the modal, matching the
// exact repro in the issue.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

const LABEL = 'Seller Modal Reopen Race Tester';
const PRODUCT_NAME = 'Reopen Race Product';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

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
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), { timeout: 10000 });
await page.waitForTimeout(500);

async function fetchJson(pathAndQuery) {
  return page.evaluate(async (p) => (await fetch(p)).json(), pathAndQuery);
}

// Delay only the first PATCH to this template — the "Save Digital Good"
// click below — so there's a deterministic window in which to close and
// reopen the modal before it resolves.
let patchCount = 0;
await page.route('**/api/catalog/*', async (route) => {
  if (route.request().method() === 'PATCH') {
    patchCount++;
    if (patchCount === 1) await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  await route.continue();
});

const row = () => page.locator('.seller-row').filter({ hasText: PRODUCT_NAME });
await row().locator('.seller-row-toggle').click();
await page.waitForTimeout(300);
await row().locator('button', { hasText: 'Edit Digital Good' }).click();
await page.waitForTimeout(200);
await row().locator('.seller-digital-good-checkbox-label input').check();
await row().locator('.seller-digital-good-select').selectOption('gift-card');
await row().locator('button', { hasText: 'Save Digital Good' }).click(); // fires the slow PATCH #1, not awaited

// Close and reopen the whole modal (via the same "Sell" nav button the
// issue names) before PATCH #1 resolves — renderSellerList() rebuilds the
// row from scratch, so this is a brand-new row/closure for the same
// template.
await page.click('#seller-close-btn');
await page.waitForTimeout(200);
await page.click('.mode-nav-btn[data-mode="sell"]');
await page.waitForSelector('#seller-modal.visible', { timeout: 10000 });
await page.waitForTimeout(300);

await row().locator('.seller-row-toggle').click();
await page.waitForTimeout(300);
await row().locator('button', { hasText: 'Edit Shipping' }).click();
await page.waitForTimeout(200);
await row().locator('.seller-domestic-only-checkbox-label input').check();

const saveShippingBtn = () => row().locator('button', { hasText: 'Save Shipping' });
const shippingDisabledWhileDigitalGoodPending = await saveShippingBtn().isDisabled();
console.log('Save Shipping disabled on the freshly reopened row while the pre-reopen Save Digital Good PATCH is still in flight (should be true):', shippingDisabledWhileDigitalGoodPending);

// Wait for PATCH #1 to resolve, which should re-enable the buttons on
// THIS (the currently visible, post-reopen) row.
await page.waitForTimeout(1500);
const shippingEnabledAfterDigitalGoodResolves = await saveShippingBtn().isEnabled();
console.log('Save Shipping re-enabled on the reopened row once the earlier save resolves (should be true):', shippingEnabledAfterDigitalGoodResolves);

await saveShippingBtn().click();
await page.waitForFunction(
  () => Array.from(document.querySelectorAll('.seller-domestic-only-status')).some((el) => el.textContent === 'Saved.'),
  { timeout: 10000 },
);

const { templates } = await fetchJson('/api/catalog?limit=100');
const finalTemplate = templates.find((t) => t.name === PRODUCT_NAME);
console.log('after the reopen race, metadata.digitalGoodDisclaimer (should still be "gift-card", not clobbered):', finalTemplate?.metadata?.digitalGoodDisclaimer);
console.log('after the reopen race, metadata.domesticOnly (should be true):', finalTemplate?.metadata?.domesticOnly);
console.log('total PATCH requests observed (should be exactly 2 — no button ever allowed a redundant overlapping save):', patchCount);

const pass = shippingDisabledWhileDigitalGoodPending &&
  shippingEnabledAfterDigitalGoodResolves &&
  finalTemplate?.metadata?.digitalGoodDisclaimer === 'gift-card' &&
  finalTemplate?.metadata?.domesticOnly === true &&
  patchCount === 2 &&
  errors.length === 0;
await finish(browser, { pass, label: '#457: a modal close/reopen mid-save does not let an overlapping metadata save clobber it', errors });
