// Regression test for #2977: convertFbxToGlb's onProgress callback (called
// from handleUploadFileStep, src/catalog/upload.js) used to write straight
// to the status line with no uploadFlowToken check at all, unlike every
// other shared-UI write in that same function -- Cancel (resetUploadModalToFileStep)
// only invalidates the flow, it doesn't abort convertFbxToGlb's own
// still-running work, so a progress tick arriving after Cancel could
// silently clobber the status line with stale text from the abandoned
// attempt.
//
// The slow side of the race is simulated via window.__testFbxConvertDelayMs
// (convertFbxToGlb's own test-only hook, added alongside the fix), same
// reasoning as window.__testUploadPreviewLoadDelayMs (#1465) -- this is real
// synchronous client-side CPU work, so there's no in-flight network request
// to delay via page.route().
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FBX_FIXTURE_PATH = path.join(REPO_ROOT, 'e2e', 'fixtures', 'test-triangle.fbx');

const LABEL = 'Upload FBX Convert Cancel Race Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForTimeout(300);
await page.click('#upload-model-btn');
await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });
await page.fill('#upload-name', 'FBX Convert Cancel Race Triangle');
await page.setInputFiles('#upload-file-input', FBX_FIXTURE_PATH);

const DELAY_MS = 2000;
await page.evaluate((ms) => { window.__testFbxConvertDelayMs = ms; }, DELAY_MS);

await page.click('#upload-submit-btn'); // "Add Product" on the file step
// Confirms convertFbxToGlb has actually started and is sitting inside the
// artificial delay (set right before the delay, per its own placement in
// modelOptimizer.js), not a guess at timing.
await page.waitForFunction(() => document.getElementById('upload-status').textContent.includes('Reading file'), null, { timeout: 30000 });

await page.click('#upload-cancel-btn'); // Cancel while conversion is still "in flight"

const statusRightAfterCancel = await page.textContent('#upload-status');
// Waits out the artificial delay (plus margin) so the canceled flow's own
// "Converting from FBX…" progress tick (the one right after the delay)
// has definitely had its chance to fire by the time this test asserts.
await page.waitForTimeout(DELAY_MS + 1000);
const statusAfterDelay = await page.textContent('#upload-status');

const modalStillVisible = await page.evaluate(() => document.getElementById('upload-modal').classList.contains('visible'));
console.log('upload modal closed after cancel (should be true, i.e. NOT visible):', !modalStillVisible);
console.log('status text right after cancel:', statusRightAfterCancel);
console.log('status text after the canceled conversion\'s own progress tick would have fired (should be unchanged, not "Converting from FBX…"):', statusAfterDelay);

const pass = !modalStillVisible &&
  statusAfterDelay === statusRightAfterCancel &&
  !statusAfterDelay.includes('Converting from FBX') &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: 'A canceled FBX upload\'s own conversion progress tick does not clobber the status line afterward (#2977)',
  errors,
});
