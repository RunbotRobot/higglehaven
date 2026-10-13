// #1909: loadRings (public/admin-dashboard.html, World panel's "Land
// candidate rings" list) had no request-ordering guard -- an in-flight
// "Load more" (page 2) could resolve after a newer "Refresh" and splice its
// stale page-2 data onto the freshly-reloaded page-1 rows via its own
// `rings.concat(...)`. Same monotonic-token-guard fix shape as
// admin-dashboard-models-panel-race.test.mjs's own loadModelsPage (#1878)
// regression test, mirrored here almost exactly.
//
// Forcing a real two-ring listing would otherwise need no extra setup --
// generate-ring's own count floor is 3, so two real generate-ring calls
// already produce two distinct ring rows -- but the panel hardcodes
// limit=100, so every /api/land-candidate-rings request's limit is rewritten
// down to 1 via route interception to force a genuine page 1 / page 2 split.
import { chromium } from 'playwright';
import { ensureAdminSession, finish } from './helpers.mjs';

const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH || null;
const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';

const browser = await chromium.launch(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {});
const errors = [];

const sessionCookie = await ensureAdminSession(); // "hh_session=<token>"
const [, token] = sessionCookie.split('=');

async function generateRing(body) {
  const response = await fetch(`${BASE_URL}/api/land-candidates/generate-ring`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `hh_session=${token}` },
    body: JSON.stringify(body),
  });
  const responseBody = await response.json();
  if (response.status !== 201) {
    throw new Error(`generateRing(${JSON.stringify(body)}) failed (${response.status}): ${JSON.stringify(responseBody)}`);
  }
  return responseBody;
}

// Two distinct, genuinely adjacent (non-overlapping) rings -- ringB is
// derived from ringA's own outer radius via adjacentToRingId, so there's no
// radial-overlap conflict to work around.
const ringAId = `e2e-rings-race-a-${Date.now()}`;
const ringBId = `e2e-rings-race-b-${Date.now()}`;
await generateRing({ prefix: ringAId, count: 3 });
await generateRing({ prefix: ringBId, count: 3, adjacentToRingId: ringAId });
console.log('generated two distinct test rings:', ringAId, ringBId);

const page = await browser.newPage();
page.on('pageerror', (err) => errors.push(err.message));
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
await page.context().addCookies([{ name: 'hh_session', value: token, url: BASE_URL }]);

// Rewrite every GET /api/land-candidate-rings(?...) request's limit down to
// 1 and delay only the page-2 ("Load more") request -- identified by its own
// cursor param -- so it's still in flight when Refresh is clicked and
// resolves first. The '*' in this pattern can't cross a '/', so this never
// matches /api/land-candidate-rings/<ringId>.
let delayPage2Request = true;
await page.route('**/api/land-candidate-rings*', async (route) => {
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
  () => !document.getElementById('ringsLoadMoreBtn').hidden,
  { timeout: 10000 },
);
const rowsAfterFirstPage = await page.locator('#ringsTableWrap tbody tr').count();
console.log('rows shown after the first (limit=1) page loads (should be 1):', rowsAfterFirstPage);

// Whichever of the two rings happens to be listed first is deterministic
// here (ORDER BY created_at, ring_id -- ringA was created first), but read
// it from the real response rather than assuming.
const firstPageText = await page.textContent('#ringsTableWrap');
const page1RingId = firstPageText.includes(ringAId) ? ringAId : ringBId;
const page2RingId = page1RingId === ringAId ? ringBId : ringAId;

await page.click('#ringsLoadMoreBtn'); // fires the slow, delayed page-2 request
await page.waitForTimeout(300);
await page.click('#ringsRefreshBtn'); // fires a fresh, fast page-1 request that should win
await page.waitForFunction(
  (ringId) => document.getElementById('ringsTableWrap').textContent.includes(ringId),
  page1RingId,
  { timeout: 10000 },
);

// Wait out the delayed page-2 response too, and confirm it didn't land late
// and concat its stale data onto the fresh, refreshed page-1 rows.
await page.waitForTimeout(2200);
delayPage2Request = false;
const finalRowCount = await page.locator('#ringsTableWrap tbody tr').count();
const finalTableText = await page.textContent('#ringsTableWrap');
const onlyPage1RingShown = finalTableText.includes(page1RingId) && !finalTableText.includes(page2RingId);
console.log('row count after the stale page-2 response also lands (should stay 1, not grow from the stale concat):', finalRowCount);
console.log('table shows only the refreshed page-1 ring, not the stale page-2 one (should be true):', onlyPage1RingShown);

const pass = rowsAfterFirstPage === 1 &&
  finalRowCount === 1 &&
  onlyPage1RingShown &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: '#1909: a stale, delayed "Load more" response does not corrupt a fresher Refresh\'s rows',
  errors,
});
