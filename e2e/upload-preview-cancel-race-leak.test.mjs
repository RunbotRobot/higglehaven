// Regression test for #1465: showUploadDimensionPreview (src/main.js)
// builds a real previewObject (loadModelInstance -- a clone of the uploaded
// model with its own cloned materials) before ever checking whether the
// upload flow it belongs to has been superseded. On the superseded branch
// it used to just `return`, dropping previewObject's cloned geometry/
// materials/textures without ever disposing them -- the exact same leak
// shape already fixed at showAxisPreview (#1426/#1427), refreshEquippedShopAvatar
// (#1426), and loadSellerShowcasePage (#1427/#1432), just missed here.
//
// The slow side of the race is simulated via
// window.__testUploadPreviewLoadDelayMs (showUploadDimensionPreview's own
// test-only hook, added alongside the fix), not a network-level delay --
// modelUrl is already cached by the time showUploadDimensionPreview runs
// (handleUploadFileStep's own earlier "Measuring model…" step already fully
// loaded it through this same loadModelInstance pipeline), so there's no
// real in-flight request left to delay via page.route(). This mirrors
// window.__testAvatarLoadDelayMs's own reasoning (#982) for the identical
// problem.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

const LABEL = 'Upload Preview Race Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 10000 });
await page.waitForTimeout(300);
await page.click('#upload-model-btn');
await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });
await page.fill('#upload-name', 'Preview Race Crate');
await page.setInputFiles('#upload-file-input', CRATE_MODEL_PATH);

// Self-imposed and deterministic (a plain in-page setTimeout, not a real
// network operation) -- see this file's own top comment for why a
// page.route()-based delay can't construct this race at all here.
const DELAY_MS = 2000;
await page.evaluate((ms) => { window.__testUploadPreviewLoadDelayMs = ms; }, DELAY_MS);

await page.click('#upload-submit-btn'); // "Create Product" on the file step
// Confirms showUploadDimensionPreview has actually started (status text
// updates to "Loading preview…" right before it's called) and is therefore
// sitting inside its artificial delay, not a guess at timing.
await page.waitForFunction(() => document.getElementById('upload-status').textContent.includes('Loading preview'), { timeout: 10000 });

await page.click('#upload-cancel-btn'); // Cancel while the preview load is still "in flight"

// Waits out the artificial delay (plus margin) so showUploadDimensionPreview's
// own supersede check has definitely resolved by the time this test asserts
// on it, regardless of how long the steps above actually took.
await page.waitForTimeout(DELAY_MS + 1000);

const modalStillVisible = await page.evaluate(() => document.getElementById('upload-modal').classList.contains('visible'));
console.log('upload modal closed after cancel (should be true, i.e. NOT visible):', !modalStillVisible);

const disposals = await page.evaluate(() => window.__supersededUploadPreviewDisposals);
console.log('supersededUploadPreviewDisposals after the race (should be 1 -- the canceled flow\'s own preview build was disposed, not leaked):', disposals);

const pass = !modalStillVisible && disposals === 1 && errors.length === 0;
await finish(browser, {
  pass,
  label: 'A canceled upload does not leak the superseded dimension-preview model\'s cloned materials (#1465)',
  errors,
});
