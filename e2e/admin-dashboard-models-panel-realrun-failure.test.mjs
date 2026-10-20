// Regression test for #2525: runCleanup's `finally` block only ever
// *disabled* #modelsRealRunBtn (`if (lastDryRunMaxDeletes !== maxDeletes)
// realRunBtn.disabled = true;`) -- it never re-enabled it. A real-run
// request that throws (network blip, a 409, a transient 5xx) leaves
// lastDryRunMaxDeletes/maxDeletes still equal (nothing clears the arm on a
// thrown request), so the one-directional guard left "Delete now" stuck
// disabled forever even though its arming state was still genuinely valid.
// Aborts the real (non-dry-run) POST /api/models/cleanup request once via
// Playwright route interception to simulate exactly that transient
// failure, same idiom e2e/credit-orb-collect-offline-notice.test.mjs uses.
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

// Same unauthenticated direct-upload idiom as
// admin-dashboard-models-panel.test.mjs's own uploadModel -- never
// registered against a catalog template, so it stays genuinely unreferenced.
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
console.log('uploaded an unreferenced test model:', uploaded.modelUrl);

const sessionCookie = await ensureAdminSession(); // "hh_session=<token>"
const [, token] = sessionCookie.split('=');

const page = await browser.newPage();
page.on('pageerror', (err) => errors.push(err.message));
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
page.on('dialog', (dialog) => dialog.accept()); // window.confirm() before the real run
await page.context().addCookies([{ name: 'hh_session', value: token, url: BASE_URL }]);

await page.goto(`${BASE_URL}/admin/dashboard`, { waitUntil: 'networkidle' });
await page.click('button[data-panel="models"]');
await page.waitForFunction(
  () => !document.getElementById('modelsStorageCard').textContent.includes('Loading'),
  null,
  { timeout: 30000 },
);
await page.waitForFunction(
  (modelUrl) => document.getElementById('modelsTableWrap').textContent.includes(modelUrl),
  uploaded.modelUrl,
  { timeout: 10000 },
);

// Dry run first -- arms "Delete now" for maxDeletes=100.
await page.fill('#modelsCleanupMax', '100');
await page.click('#modelsDryRunBtn');
await page.waitForFunction(
  () => document.getElementById('modelsCleanupResult').textContent.includes('Would delete'),
  null,
  { timeout: 30000 },
);
const realRunEnabledAfterDryRun = await page.locator('#modelsRealRunBtn').isEnabled();
console.log('"Delete now" enabled after the dry run (should be true):', realRunEnabledAfterDryRun);

// Abort only the real (non-dry-run) cleanup request, exactly once --
// simulates a genuine transient network failure on the real run itself,
// distinct from the dry run just completed above.
let realRunAttempts = 0;
await page.route('**/api/models/cleanup', async (route) => {
  const body = route.request().postDataJSON();
  if (!body.dryRun) {
    realRunAttempts++;
    if (realRunAttempts === 1) {
      await route.abort('failed');
      return;
    }
  }
  await route.continue();
});

await page.click('#modelsRealRunBtn');
await page.waitForFunction(
  () => !document.getElementById('modelsCleanupErr').hidden,
  null,
  { timeout: 10000 },
);
console.log('real run attempt count after the aborted first attempt (should be 1):', realRunAttempts);

const realRunStillEnabledAfterFailure = await page.locator('#modelsRealRunBtn').isEnabled();
console.log('"Delete now" still enabled after the real run request failed (should be true -- the #2525 fix):', realRunStillEnabledAfterFailure);

const stillListedAfterFailedRealRun = (await page.locator('#modelsTableWrap').textContent()).includes(uploaded.modelUrl);
console.log('model still listed -- nothing was actually deleted by the failed attempt (should be true):', stillListedAfterFailedRealRun);

// Without re-running a dry run, clicking "Delete now" again should now
// succeed -- proving the arm state was never actually invalidated, just
// the button's own enabled/disabled reflection of it.
await page.unroute('**/api/models/cleanup');
await page.click('#modelsRealRunBtn');
await page.waitForFunction(
  () => document.getElementById('modelsCleanupResult').textContent.includes('Deleted'),
  null,
  { timeout: 30000 },
);
await page.waitForFunction(
  (modelUrl) => !document.getElementById('modelsTableWrap').textContent.includes(modelUrl),
  uploaded.modelUrl,
  { timeout: 10000 },
);
const goneFromListAfterRetry = !(await page.locator('#modelsTableWrap').textContent()).includes(uploaded.modelUrl);
console.log('model actually deleted on the retry, with no fresh dry run needed (should be true):', goneFromListAfterRetry);

// The aborted request above is a deliberate, real network-level failure --
// Chromium logs it to the console independent of anything this app's own
// code does, same expected fallout e2e/connectivity-indicator.test.mjs's
// own comment documents.
const unexpectedErrors = errors.filter((e) => !e.includes('net::ERR_FAILED') && !e.includes('Failed to fetch'));

const pass = realRunEnabledAfterDryRun &&
  realRunAttempts === 1 &&
  realRunStillEnabledAfterFailure &&
  stillListedAfterFailedRealRun &&
  goneFromListAfterRetry &&
  unexpectedErrors.length === 0;
await finish(browser, {
  pass,
  label: '#2525: "Delete now" stays enabled (not stuck disabled) after a failed real-run cleanup request',
  errors: unexpectedErrors,
});
