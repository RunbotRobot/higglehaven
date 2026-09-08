// Regression test for #543: showAxisPreview(template, container, ...) mounts
// the one shared preview canvas into whatever container it's given, with no
// check that the container is still the currently-visible one. The Save Size
// button's success handler closes over its own row's previewContainer before
// awaiting a slow (fetch -> rescale -> upload -> PATCH) chain — if the Seller
// modal is closed and reopened while that's in flight, renderSellerList()
// rebuilds every row (and its previewContainer) from scratch, so the stale
// closure points at a now-detached node. Without the fix, the save's success
// handler re-shows the preview into that detached node, yanking the shared
// canvas out of whatever OTHER row (the reopened one) currently has it open.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

const LABEL = 'Size Save Preview Race Tester';
const PRODUCT_NAME = 'Size Race Crate';

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

const productRow = () => page.locator('.seller-row').filter({ hasText: PRODUCT_NAME });
await productRow().locator('.seller-row-toggle').click();
await page.waitForTimeout(300);

// Open this row's own preview before ever touching Save Size, matching the
// real sequence the bug needs: a preview already open on THIS template when
// the save resolves is exactly what makes the stale handler re-fire.
await productRow().locator('button', { hasText: 'Preview' }).click();
await page.waitForSelector('.seller-row-preview canvas.seller-preview-canvas', { timeout: 10000 });

await productRow().locator('.seller-size-toggle').click();
await page.waitForTimeout(200);
const widthInput = productRow().locator('.seller-size-input').nth(0);
const currentWidth = Number(await widthInput.inputValue());
await widthInput.fill(String((currentWidth * 1.5).toFixed(2)));
await widthInput.dispatchEvent('input');

// Delay only the final PATCH — the fetch/rescale/upload steps ahead of it
// proceed at normal speed, then this hold gives a reliable window to close,
// reopen, and re-open the preview on the reopened row before it resolves.
await page.route('**/api/catalog/*', async (route) => {
  if (route.request().method() === 'PATCH') await new Promise((resolve) => setTimeout(resolve, 3000));
  await route.continue();
});

await productRow().locator('.seller-size-save-btn').click();
await page.waitForFunction(
  () => Array.from(document.querySelectorAll('.seller-size-status')).some((el) => el.textContent === 'Saving…'),
  { timeout: 10000 },
);

// Real user behavior — nothing in-flight is canceled by this (closeSellerModal
// only toggles a CSS class), same as seller-modal-reopen-race.test.mjs.
await page.click('#seller-close-btn');
await page.waitForTimeout(200);
await page.click('.mode-nav-btn[data-mode="sell"]');
await page.waitForSelector('#seller-modal.visible', { timeout: 10000 });
await page.waitForTimeout(300);

// A brand-new row — renderSellerList() rebuilt it from scratch on reopen.
// Re-open its preview so the shared canvas is now live under THIS row's
// container when the stale pre-close save resolves.
await productRow().locator('.seller-row-toggle').click();
await page.waitForTimeout(200);
await productRow().locator('button', { hasText: 'Preview' }).click();
await page.waitForSelector('.seller-row-preview canvas.seller-preview-canvas', { timeout: 10000 });

// Wait past the delayed PATCH's own delay so the pre-close save's success
// handler runs.
await page.waitForTimeout(3500);
await page.unroute('**/api/catalog/*');

const canvasStillConnected = await page.evaluate(() => {
  const canvas = document.querySelector('.seller-preview-canvas');
  return !!canvas && canvas.isConnected;
});
console.log('the shared preview canvas is still attached to the (reopened) live row after the stale pre-close save resolved, not yanked into a detached node (should be true — the #543 fix):', canvasStillConnected);

const { templates } = await page.evaluate(async () => (await fetch('/api/catalog?limit=100')).json());
const template = templates.find((t) => t.name === PRODUCT_NAME);
console.log('the pre-close save still went through correctly server-side (width should be ~1.5x the original):', template?.dimensions);

const pass = canvasStillConnected &&
  template?.dimensions?.width > currentWidth * 1.4 &&
  errors.length === 0;
await finish(browser, { pass, label: "#543: a Save Size left in flight across a Seller-modal close/reopen doesn't hijack the reopened row's Preview panel", errors });
