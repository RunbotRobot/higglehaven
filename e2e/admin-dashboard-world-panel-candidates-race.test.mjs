// #1910: loadCandidates (public/admin-dashboard.html, World panel's land
// candidates table) had no request-ordering guard -- an in-flight "Load
// more" (page 2) could resolve after a newer "Refresh" and splice its
// stale page-2 data onto the freshly-reloaded page-1 rows via its own
// `candidatesRows.concat(...)`. Same monotonic-token-guard fix shape, and
// same Playwright route-interception test shape, as the sibling fix for
// the R2 model-storage panel's loadModelsPage (#1878,
// e2e/admin-dashboard-models-panel-race.test.mjs).
//
// Forcing a real two-page listing would otherwise need 100+ real land
// candidates (the panel sends no explicit limit, so the server's default
// of 100 applies) -- instead, every /api/land-candidates request is
// rewritten down to limit=1 via route interception (the server's own real
// cursor pagination still decides truncation), so two real candidates are
// enough to produce a genuine page 1 / page 2 split.
import { chromium } from 'playwright';
import { ensureAdminSession, finish } from './helpers.mjs';

const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH || null;
const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';

const browser = await chromium.launch(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {});
const errors = [];

const sessionCookie = await ensureAdminSession(); // "hh_session=<token>"
const [, token] = sessionCookie.split('=');

// Two distinct, standalone pending candidates far from the world origin so
// neither materializes and neither overlaps the other -- same batch-create
// idiom e2e/admin-dashboard-world-panel.test.mjs already uses.
const nameA = `E2E Race Candidate A ${crypto.randomUUID().slice(0, 8)}`;
const nameB = `E2E Race Candidate B ${crypto.randomUUID().slice(0, 8)}`;
const batchResponse = await fetch(`${BASE_URL}/api/land-candidates/batch`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie: sessionCookie },
  body: JSON.stringify({
    candidates: [
      { name: nameA, areaM2: 1000, center: { x: 50000, y: 0 } },
      { name: nameB, areaM2: 1000, center: { x: -50000, y: 0 } },
    ],
  }),
});
const batchBody = await batchResponse.json();
if (batchResponse.status !== 201) {
  throw new Error(`batch-create failed (${batchResponse.status}): ${JSON.stringify(batchBody)}`);
}
console.log('created two distinct pending candidates:', nameA, nameB);

const page = await browser.newPage();
page.on('pageerror', (err) => errors.push(err.message));
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
await page.context().addCookies([{ name: 'hh_session', value: token, url: BASE_URL }]);

// Rewrite every GET /api/land-candidates request's limit down to 1 (real
// cursor pagination still decides truncation server-side) and delay only
// the page-2 ("Load more") request -- identified by its own cursor param
// -- so it's still in flight when Refresh is clicked and resolves first.
let delayPage2Request = true;
await page.route('**/api/land-candidates*', async (route) => {
  const url = new URL(route.request().url());
  url.searchParams.set('limit', '1');
  if (delayPage2Request && url.searchParams.get('cursor')) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  await route.continue({ url: url.toString() });
});

await page.goto(`${BASE_URL}/admin/dashboard`, { waitUntil: 'networkidle' });
await page.click('button[data-panel="world"]');

await page.waitForFunction(
  () => !document.getElementById('candidatesLoadMoreBtn').hidden,
  { timeout: 10000 },
);
const rowsAfterFirstPage = await page.locator('#candidatesTableWrap tbody tr').count();
console.log('rows shown after the first (limit=1) page loads (should be 1):', rowsAfterFirstPage);

// Whichever candidate sorts first (by created_at, landlet_id) lands on
// page 1 -- determine it from the real response rather than assuming.
const firstPageText = await page.textContent('#candidatesTableWrap');
const page1Name = firstPageText.includes(nameA) ? nameA : nameB;
const page2Name = page1Name === nameA ? nameB : nameA;

await page.click('#candidatesLoadMoreBtn'); // fires the slow, delayed page-2 request
await page.waitForTimeout(300);
await page.click('#candidatesRefreshBtn'); // fires a fresh, fast page-1 request that should win
await page.waitForFunction(
  (name) => document.getElementById('candidatesTableWrap').textContent.includes(name),
  page1Name,
  { timeout: 10000 },
);

// Wait out the delayed page-2 response too, and confirm it didn't land
// late and concat its stale data onto the fresh, refreshed page-1 row.
await page.waitForTimeout(2200);
delayPage2Request = false;
const finalRowCount = await page.locator('#candidatesTableWrap tbody tr').count();
const finalTableText = await page.textContent('#candidatesTableWrap');
const onlyPage1CandidateShown = finalTableText.includes(page1Name) && !finalTableText.includes(page2Name);
console.log('row count after the stale page-2 response also lands (should stay 1, not grow from the stale concat):', finalRowCount);
console.log('table shows only the refreshed page-1 candidate, not the stale page-2 one (should be true):', onlyPage1CandidateShown);

const pass = rowsAfterFirstPage === 1 &&
  finalRowCount === 1 &&
  onlyPage1CandidateShown &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: '#1910: a stale, delayed "Load more" response does not corrupt a fresher Refresh\'s land-candidates rows',
  errors,
});
