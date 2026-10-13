// Regression test for #1893: showAxisPreview awaits a model load
// (createMeshForInstance) before building its scene, and disposeAxisPreview()
// is the only thing that tears a live preview down -- but its other callers
// (closeSellerModal, a row collapsing, renderSellerList() rebuilding row DOM)
// never invalidated the in-flight load's own axisPreviewLoadToken, unlike
// showAxisPreview's own internal call to it. Closing the Seller modal (or
// collapsing the row) while a preview's model load was still in flight let
// that load resolve anyway and install a WebGLRenderer/OrbitControls bound to
// an already-detached canvas -- never disposed, since nothing else calls
// disposeAxisPreview() again until some future Preview click.
//
// The slow side of the race is simulated via window.__testAxisPreviewLoadDelayMs
// (showAxisPreview's own test-only hook, added alongside the fix), the same
// idiom window.__testUploadPreviewLoadDelayMs (#1465) and
// window.__testShopProductPreviewLoadDelayMs (#1876) use for this identical
// problem elsewhere in this file.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

const LABEL = 'Axis Preview Close Race Tester';
// Deliberately avoids containing "Preview" -- the row's own toggle button
// text includes the product name, so a name containing "Preview" would
// make the .filter({ hasText: 'Preview' }) locator below match both that
// toggle and the real Preview action button.
const PRODUCT_NAME = 'Axis Close Race Crate';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForTimeout(300);

await page.click('#upload-model-btn');
await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });
await page.fill('#upload-name', PRODUCT_NAME);
await page.fill('#upload-price', '5');
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

// Self-imposed and deterministic (a plain in-page setTimeout, not a real
// network operation), same reasoning as e2e/upload-preview-cancel-race-leak
// .test.mjs's own top comment.
const DELAY_MS = 2000;
await page.evaluate((ms) => { window.__testAxisPreviewLoadDelayMs = ms; }, DELAY_MS);

await productRow().locator('button', { hasText: 'Preview' }).click();
// Give showAxisPreview a moment to actually start and hit its artificial
// delay (mountPreviewInto already ran, so the canvas exists even mid-delay).
await page.waitForSelector('.seller-row-preview canvas.seller-preview-canvas', { timeout: 10000 });
await page.waitForTimeout(200);

// Close the Seller modal entirely while the preview's model load is still
// "in flight" -- closeSellerModal -> disposeAxisPreview(), which (with the
// fix) bumps axisPreviewLoadToken even though axisPreview is still null.
await page.click('#seller-close-btn');

// Waits out the artificial delay (plus margin) so showAxisPreview's own
// supersede check has definitely resolved by the time this test asserts on
// it, regardless of how long the steps above actually took.
await page.waitForTimeout(DELAY_MS + 1000);

const disposals = await page.evaluate(() => window.__supersededAxisPreviewDisposals);
console.log('supersededAxisPreviewDisposals after closing mid-load (should be 1 -- the canceled load\'s own built preview was disposed, not installed/leaked):', disposals);

const pass = disposals === 1 && errors.length === 0;
await finish(browser, {
  pass,
  label: "#1893: closing the Seller modal mid-load doesn't let a superseded axis-preview load install an orphaned WebGL context",
  errors,
});
