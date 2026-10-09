// #1552: the client-side model optimizer's SimplifyModifier (src/vendor/
// SimplifyModifierExtraUV.js) hardcodes an attribute whitelist that never
// included skinIndex/skinWeight -- decimating any SkinnedMesh over the
// 8000-triangle-per-mesh budget silently destroyed its skin binding, with
// the corrupted result sometimes failing to even reload (GLTFLoader's own
// SkinnedMesh.normalizeSkinWeights throwing on the now-missing
// skinWeight). The fix (src/modelOptimizer.js) skips decimation entirely
// for a mesh that has skin attributes, rather than risk the rig.
//
// e2e/fixtures/test-skinned-high-poly.glb is a generated fixture: a single
// SkinnedMesh (one bone, trivial skeleton) built from a 100x100-segment
// PlaneGeometry -- 20,000 triangles, comfortably over the per-mesh
// decimation threshold -- with skinIndex/skinWeight attributes attached
// the way a real rigged export would have them. No real-world counterpart,
// picked purely to land reliably over the threshold while staying small
// enough to commit (no texture/UV data).
//
// Before the fix: uploading this file causes the wizard's own
// measureModelDimensions step (src/main.js) to call loadModelInstance,
// which reloads the just-uploaded (now-corrupted) .glb via GLTFLoader --
// confirmed directly (outside this suite) that this throws on the exact
// fixture shape here, so the upload wizard would error out instead of
// reaching the dimensions step at all. After the fix, the mesh is left
// undecimated and the whole flow completes normally.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_PATH = path.join(REPO_ROOT, 'e2e', 'fixtures', 'test-skinned-high-poly.glb');

const LABEL = 'Skinned Mesh Upload Tester';
const PRODUCT_NAME = 'Suite Skinned High-Poly Mesh';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 10000 });
await page.waitForTimeout(300);

await page.click('#upload-model-btn');
await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });

await page.fill('#upload-name', PRODUCT_NAME);
await page.setInputFiles('#upload-file-input', FIXTURE_PATH);
await page.click('#upload-submit-btn');

// Decimation (skipped, per the fix) + re-encoding + upload + measurement
// + preview all run before this step becomes visible -- a real mesh this
// size needs a generous timeout, same reasoning as the high-poly-model
// warning path in modelOptimizer.js itself.
const reachedDimensionsStep = await page
  .waitForFunction(() => !document.getElementById('upload-step-dimensions').hidden, { timeout: 30000 })
  .then(() => true)
  .catch(() => false);
console.log('upload wizard reached the dimensions step without erroring (should be true):', reachedDimensionsStep);

const statusText = await page.textContent('#upload-status').catch(() => '');
console.log('upload status text at the dimensions step (diagnostic only):', statusText);

let productListed = false;
if (reachedDimensionsStep) {
  await page.waitForTimeout(300);
  await page.click('#upload-submit-btn');
  await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), { timeout: 10000 });
  await page.waitForTimeout(500);
  const sellerListText = await page.textContent('#seller-list');
  productListed = sellerListText.includes(PRODUCT_NAME);
}
console.log('skinned high-poly product listed after upload (should be true):', productListed);

const pass = reachedDimensionsStep && productListed && errors.length === 0;
await finish(browser, {
  pass,
  label: "Uploading a skinned mesh over the decimation threshold doesn't corrupt its skin binding (#1552)",
  errors,
});
