// #1166: the upload wizard's file step now accepts a plain .fbx (e.g. a
// Mixamo character) alongside .glb, converting it to .glb entirely
// client-side (FBXLoader -> GLTFExporter, src/modelOptimizer.js's
// convertFbxToGlb) before anything is ever uploaded, so a seller doesn't
// need a manual Blender export step first.
//
// e2e/fixtures/test-triangle.fbx is a minimal, hand-written ASCII FBX (a
// single tetrahedron with 100cm of spread on every axis, no skeleton/
// animation, no real-world counterpart) — picked specifically because it's
// small and dependency-free enough to hand-author and verify directly
// against this exact FBXLoader/GLTFExporter pipeline (confirmed via a
// standalone Playwright check before adding it here), unlike the real
// catalog .glb fixtures (crate.glb etc.) other upload tests reuse. Non-
// planar on purpose — an earlier flat-triangle version measured 0 on one
// axis, which the app's own dimension-confirmation step doesn't handle as
// a generic case, an unrelated degenerate-fixture issue rather than
// anything to do with #1166's own conversion feature.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, openAccountMenu, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FBX_FIXTURE_PATH = path.join(REPO_ROOT, 'e2e', 'fixtures', 'test-triangle.fbx');

const LABEL = 'FBX Upload Suite Tester';
const PRODUCT_NAME = 'Suite FBX Triangle';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 10000 });
await page.waitForTimeout(300);

await page.click('#upload-model-btn');
await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });

const fileLabelText = await page.textContent('#upload-file-label');
console.log('file step label mentions .fbx (should be true):', fileLabelText.includes('.fbx'));

await page.fill('#upload-name', PRODUCT_NAME);
await page.setInputFiles('#upload-file-input', FBX_FIXTURE_PATH);
await page.click('#upload-submit-btn');

// Converting + re-encoding both run before this, so give the status text a
// moment to show the conversion step actually happened rather than just
// racing straight to the dimensions step.
const statusDuringConversion = await page.textContent('#upload-status').catch(() => '');
console.log('status text sampled during the upload (informational, may already have moved on):', statusDuringConversion);

await page.waitForFunction(() => !document.getElementById('upload-step-dimensions').hidden, { timeout: 20000 });
await page.waitForTimeout(300);

const measuredX = Number(await page.locator('.upload-dimension-input[data-axis="x"]').inputValue());
const measuredY = Number(await page.locator('.upload-dimension-input[data-axis="y"]').inputValue());
const measuredZ = Number(await page.locator('.upload-dimension-input[data-axis="z"]').inputValue());
console.log('measured dimensions from the converted .glb (should all be > 0):', { measuredX, measuredY, measuredZ });

await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), { timeout: 10000 });
await page.waitForTimeout(500);

const sellerListText = await page.textContent('#seller-list');
const productListed = sellerListText.includes(PRODUCT_NAME);
console.log('converted-from-FBX product listed in seller list (should be true):', productListed);

await page.click('#seller-close-btn');

const pass = fileLabelText.includes('.fbx') &&
  measuredX > 0 && measuredY > 0 && measuredZ > 0 &&
  productListed &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: 'Upload wizard converts a picked .fbx file to .glb client-side before uploading (#1166)',
  errors,
});
