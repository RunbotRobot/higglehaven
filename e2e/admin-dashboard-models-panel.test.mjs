// #1820 (sub-issue of #1817): the R2 model storage panel on the Admin
// Dashboard shell (#1818) -- list every uploaded model/thumbnail with its
// reference status, live storage usage vs. the shared cap, and the
// dry-run-then-confirm cleanup flow for bulk-deleting unreferenced uploads.
// Same "a real e2e check, not a unit test" reasoning as the shell's own
// e2e/admin-dashboard-page.test.mjs -- worker/commerce.test.js and friends
// already cover the underlying GET /api/models(/storage)/POST /api/models/
// cleanup endpoints themselves; this exercises the real static page driving
// them end to end, including the dry-run safety rail (#1820's own body:
// "not optional UX polish, it's the main safety rail").
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { ensureAdminSession, finish } from './helpers.mjs';

const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH || null;
const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

const browser = await chromium.launch(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {});
const errors = [];

// Upload a model directly (POST /api/models is unauthenticated, same as
// the normal Upload Model wizard's own first step) WITHOUT ever creating a
// catalog template for it, so it's genuinely unreferenced -- exactly the
// shape handleModelListing's own "deletable" flag and cleanupUnreferencedModels
// target.
async function uploadModel(localPath) {
  const bytes = await fs.readFile(localPath);
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'model/gltf-binary' }), path.basename(localPath));
  const response = await fetch(`${BASE_URL}/api/models`, { method: 'POST', body: form });
  const body = await response.json();
  if (response.status !== 200 && response.status !== 201) {
    throw new Error(`uploadModel(${localPath}) failed (${response.status}): ${JSON.stringify(body)}`);
  }
  return body; // { modelUrl, sizeBytes, deduplicated }
}

const uploaded = await uploadModel(CRATE_MODEL_PATH);
console.log('uploaded an unreferenced test model (should not be deduplicated against a prior run):', uploaded);

const sessionCookie = await ensureAdminSession(); // "hh_session=<token>"
const [, token] = sessionCookie.split('=');

const page = await browser.newPage();
page.on('pageerror', (err) => errors.push(err.message));
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
// window.confirm() blocks until handled -- auto-accept, same as launchPage's
// own dialog handler does for window.prompt() elsewhere in this suite.
page.on('dialog', (dialog) => dialog.accept());
await page.context().addCookies([{ name: 'hh_session', value: token, url: BASE_URL }]);

await page.goto(`${BASE_URL}/admin/dashboard`, { waitUntil: 'networkidle' });
await page.click('button[data-panel="models"]');

// #2139 (sub-issue of #2138): waitForFunction's real signature is
// (pageFunction, arg, options) -- a 2-arg call with a parameterless
// pageFunction binds {timeout} to arg, not options, so every bare call
// like this one always silently ran at Playwright's true default
// (30000ms) regardless of what was written here. Passing `null` for arg
// now actually honors the option -- set to 30000 explicitly (the value
// already secretly in effect) rather than the originally-written 10000,
// since that number was never real and these are all "wait for this to
// eventually become true" patterns where more margin is safer.
await page.waitForFunction(
  () => !document.getElementById('modelsStorageCard').textContent.includes('Loading'),
  null,
  { timeout: 30000 },
);
const storageCardText = await page.textContent('#modelsStorageCard');
console.log('storage usage card after loading (should mention "used of" and show a storage bar):', storageCardText.trim());
const storageBarVisible = await page.locator('.models-storage-bar-fill').count() === 1;

await page.waitForFunction(
  (modelUrl) => document.getElementById('modelsTableWrap').textContent.includes(modelUrl),
  uploaded.modelUrl,
  { timeout: 10000 },
);
const rowText = await page.locator('#modelsTableWrap tr', { hasText: uploaded.modelUrl }).textContent();
console.log('uploaded model\'s own row (should be tagged "unreferenced"):', rowText.trim());
const rowTaggedUnreferenced = rowText.includes('unreferenced');

const realRunDisabledBeforeAnyDryRun = await page.locator('#modelsRealRunBtn').isDisabled();
console.log('"Delete now" starts disabled before any dry run has ever run (should be true):', realRunDisabledBeforeAnyDryRun);

// --- Cleanup: dry run first, which only previews -- the model must still
// be listed afterward and "Delete now" only now becomes enabled. ---
await page.fill('#modelsCleanupMax', '100');
await page.click('#modelsDryRunBtn');
await page.waitForFunction(
  () => document.getElementById('modelsCleanupResult').textContent.includes('Would delete'),
  null,
  { timeout: 30000 },
);
const dryRunResultText = await page.textContent('#modelsCleanupResult');
console.log('dry run result (should mention the uploaded model\'s own URL):', dryRunResultText.trim());
const dryRunMentionsUpload = dryRunResultText.includes(uploaded.modelUrl);
const realRunEnabledAfterDryRun = await page.locator('#modelsRealRunBtn').isEnabled();
console.log('"Delete now" enabled only after a dry run (should be true):', realRunEnabledAfterDryRun);

const stillListedAfterDryRun = await page.locator('#modelsTableWrap').textContent();
const dryRunDidNotActuallyDelete = stillListedAfterDryRun.includes(uploaded.modelUrl);
console.log('model still listed after a dry run, i.e. nothing was actually deleted yet (should be true):', dryRunDidNotActuallyDelete);

// Changing the input disarms the real-run button until a fresh dry run.
await page.fill('#modelsCleanupMax', '99');
const disarmedAfterInputChange = await page.locator('#modelsRealRunBtn').isDisabled();
console.log('"Delete now" disarmed after changing maxDeletes without a fresh dry run (should be true):', disarmedAfterInputChange);
await page.fill('#modelsCleanupMax', '100');
await page.click('#modelsDryRunBtn');
await page.waitForFunction(
  () => document.getElementById('modelsCleanupResult').textContent.includes('Would delete'),
  null,
  { timeout: 30000 },
);

// --- Real run: actually deletes, confirm() auto-accepted above. ---
await page.click('#modelsRealRunBtn');
await page.waitForFunction(
  () => document.getElementById('modelsCleanupResult').textContent.includes('Deleted'),
  null,
  { timeout: 30000 },
);
const realRunResultText = await page.textContent('#modelsCleanupResult');
console.log('real run result (should mention Deleted and the uploaded model\'s own URL):', realRunResultText.trim());
const realRunMentionsUpload = realRunResultText.includes(uploaded.modelUrl);

await page.waitForFunction(
  (modelUrl) => !document.getElementById('modelsTableWrap').textContent.includes(modelUrl),
  uploaded.modelUrl,
  { timeout: 10000 },
);
const goneFromListAfterRealRun = !(await page.locator('#modelsTableWrap').textContent()).includes(uploaded.modelUrl);
console.log('model gone from the list after the real run (should be true):', goneFromListAfterRealRun);

const pass = storageCardText.includes('used of') &&
  storageBarVisible &&
  rowTaggedUnreferenced &&
  realRunDisabledBeforeAnyDryRun &&
  dryRunMentionsUpload &&
  realRunEnabledAfterDryRun &&
  dryRunDidNotActuallyDelete &&
  disarmedAfterInputChange &&
  realRunMentionsUpload &&
  goneFromListAfterRealRun &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: 'Admin Dashboard R2 model storage panel (#1820): usage, listing with reference status, dry-run-gated cleanup',
  errors,
});
