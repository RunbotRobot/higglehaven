// #1878: loadModelsPage (public/admin-dashboard.html, R2 model storage
// panel) had no request-ordering guard -- an in-flight "Load more" (page
// 2) could resolve after a newer "Refresh" and splice its stale page-2
// data onto the freshly-reloaded page-1 rows via its own
// `rows.concat(...)`. Same monotonic-token-guard fix shape as
// admin-action-log.html's load() (#1857), exercised here the same way
// that regression test does: Playwright route interception for a
// deterministic reordering.
//
// Forcing a real two-page listing would otherwise need 100+ real uploads
// (the panel hardcodes limit=100) -- instead, every /api/models request
// is rewritten down to limit=1 via route interception (R2's own real
// cursor pagination still runs server-side), so two real uploads are
// enough to produce a genuine page 1 / page 2 split.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { ensureAdminSession, finish } from './helpers.mjs';

const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH || null;
const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const browser = await chromium.launch(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {});
const errors = [];

// Same unauthenticated direct-upload idiom as admin-dashboard-models-
// panel.test.mjs's own uploadModel -- never registered against a catalog
// template, so both stay genuinely unreferenced.
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

const modelA = await uploadModel(path.join(REPO_ROOT, 'public', 'models', 'crate.glb'));
const modelB = await uploadModel(path.join(REPO_ROOT, 'public', 'models', 'chair.glb'));
console.log('uploaded two distinct unreferenced test models:', modelA.modelUrl, modelB.modelUrl);

const sessionCookie = await ensureAdminSession(); // "hh_session=<token>"
const [, token] = sessionCookie.split('=');

const page = await browser.newPage();
page.on('pageerror', (err) => errors.push(err.message));
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
await page.context().addCookies([{ name: 'hh_session', value: token, url: BASE_URL }]);

// Rewrite every GET /api/models(?...) request's limit down to 1 (real R2
// cursor pagination still decides truncation server-side) and delay only
// the page-2 ("Load more") request -- identified by its own cursor param
// -- so it's still in flight when Refresh is clicked and resolves first.
// The '*' in this pattern can't cross a '/', so this never matches
// /api/models/storage or /api/models/cleanup.
let delayPage2Request = true;
await page.route('**/api/models*', async (route) => {
  const url = new URL(route.request().url());
  url.searchParams.set('limit', '1');
  if (delayPage2Request && url.searchParams.get('cursor')) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  await route.continue({ url: url.toString() });
});

await page.goto(`${BASE_URL}/admin/dashboard`, { waitUntil: 'networkidle' });
await page.click('button[data-panel="models"]');

// #2636 (sub-issue of #2635): waitForFunction's signature is (pageFunction,
// arg, options) -- a bare (fn, { timeout }) call puts the options object in
// the `arg` slot instead, so `options` stayed undefined and the real applied
// timeout was always Playwright's actual default (30000ms), never the
// smaller number written here. The explicit `null` arg reaches the options
// slot, and the timeout itself is widened to 60000ms for real headroom under
// CI load, same as this suite's other admin-dashboard-panel waits.
await page.waitForFunction(
  () => !document.getElementById('modelsLoadMoreWrap').hidden,
  null,
  { timeout: 60000 },
);
const rowsAfterFirstPage = await page.locator('#modelsTableWrap tbody tr').count();
console.log('rows shown after the first (limit=1) page loads (should be 1):', rowsAfterFirstPage);

// Whichever of the two uploads R2 happens to list first -- order isn't
// guaranteed, so determine it from the real response rather than assuming.
const firstPageText = await page.textContent('#modelsTableWrap');
const page1ModelUrl = firstPageText.includes(modelA.modelUrl) ? modelA.modelUrl : modelB.modelUrl;
const page2ModelUrl = page1ModelUrl === modelA.modelUrl ? modelB.modelUrl : modelA.modelUrl;

await page.click('#modelsLoadMoreBtn'); // fires the slow, delayed page-2 request
await page.waitForTimeout(300);
await page.click('#modelsRefreshBtn'); // fires a fresh, fast page-1 request that should win
await page.waitForFunction(
  (modelUrl) => document.getElementById('modelsTableWrap').textContent.includes(modelUrl),
  page1ModelUrl,
  { timeout: 10000 },
);

// Wait out the delayed page-2 response too, and confirm it didn't land
// late and concat its stale data onto the fresh, refreshed page-1 rows.
await page.waitForTimeout(2200);
delayPage2Request = false;
const finalRowCount = await page.locator('#modelsTableWrap tbody tr').count();
const finalTableText = await page.textContent('#modelsTableWrap');
const onlyPage1ModelShown = finalTableText.includes(page1ModelUrl) && !finalTableText.includes(page2ModelUrl);
console.log('row count after the stale page-2 response also lands (should stay 1, not grow from the stale concat):', finalRowCount);
console.log('table shows only the refreshed page-1 model, not the stale page-2 one (should be true):', onlyPage1ModelShown);

const pass = rowsAfterFirstPage === 1 &&
  finalRowCount === 1 &&
  onlyPage1ModelShown &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: '#1878: a stale, delayed "Load more" response does not corrupt a fresher Refresh\'s rows',
  errors,
});
