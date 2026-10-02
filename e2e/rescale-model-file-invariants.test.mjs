// #1254: seller-upload-and-resize.test.mjs already exercises the Edit
// Size panel's rescale path end-to-end (notification, thumbnail survives),
// but never checks that rescaleModelFile actually changed the real
// model's own geometry — only that a number got saved and a thumbnail
// still rendered. This test instead edits the upload wizard's own width
// field (the OTHER call site of rescaleModelFile, src/main.js's
// handleUploadDimensionsStep) to a known multiple of the measured size,
// then reads window.__lastInstanceExtent (added for this issue) once the
// resulting product is placed, confirming the live, rendered model is
// really that many times bigger on every axis — the "declared == rendered"
// invariant rescaleModelFile's own doc comment says this exists to
// guarantee, not just a persisted dimensions number.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

const LABEL = 'Rescale Invariants Suite Tester';
const PRODUCT_NAME = 'Rescale Invariants Crate';
const SCALE_FACTOR = 2;

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

const originalX = Number(await page.locator('.upload-dimension-input[data-axis="x"]').inputValue());
const originalY = Number(await page.locator('.upload-dimension-input[data-axis="y"]').inputValue());
const originalZ = Number(await page.locator('.upload-dimension-input[data-axis="z"]').inputValue());
console.log('measured original dimensions (all should be > 0):', { originalX, originalY, originalZ });

// Editing x alone rescales y/z in lockstep to hold proportions (the same
// live listener seller-upload-and-resize.test.mjs's own Edit Size panel
// relies on) — doubling x here is enough to prove rescaleModelFile acted
// on the whole model, not just the one axis a seller happened to type into.
const newX = Number((originalX * SCALE_FACTOR).toFixed(2));
await page.fill('.upload-dimension-input[data-axis="x"]', String(newX));
await page.waitForTimeout(200);
const newY = Number(await page.locator('.upload-dimension-input[data-axis="y"]').inputValue());
const newZ = Number(await page.locator('.upload-dimension-input[data-axis="z"]').inputValue());
console.log('y/z after editing x (should both be ~2x their originals):', { newY, newZ });

await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), { timeout: 15000 });
await page.waitForTimeout(500);

await page.click('#seller-close-btn');
await page.waitForTimeout(300);
await page.click('.mode-nav-btn[data-mode="build"]');
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
await page.waitForSelector('#add-item-btn', { timeout: 15000 });
await page.waitForTimeout(500);

await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').filter({ hasText: PRODUCT_NAME }).click();
await page.waitForTimeout(300);
await page.mouse.click(210, 400);
await page.waitForTimeout(1000);

const extent = await page.evaluate(() => window.__lastInstanceExtent);
console.log(`rendered extent of the placed, rescaled model (x/y/z should all be ~${SCALE_FACTOR}x their originals):`, extent);

const TOLERANCE_RATIO = 0.05; // the model's real own bounding-sphere-based render, not an exact box — a little slack is expected
const closeToRatio = (measured, original) => Math.abs(measured / original - SCALE_FACTOR) < TOLERANCE_RATIO;

const rescaledCorrectly = closeToRatio(extent.x, originalX) &&
  closeToRatio(extent.y, originalY) && closeToRatio(extent.z, originalZ);

const pass = originalX > 0 && originalY > 0 && originalZ > 0 &&
  Math.abs(newY / originalY - SCALE_FACTOR) < TOLERANCE_RATIO &&
  Math.abs(newZ / originalZ - SCALE_FACTOR) < TOLERANCE_RATIO &&
  rescaledCorrectly &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: "rescaleModelFile's uniform rescale actually resizes the real model file, not just the declared dimensions number (#1254)",
  errors,
});
