// #2073: viewRing() (public/admin-dashboard.html, World panel's "Land
// candidate rings" list) had no request-ordering guard of its own -- every
// row's "Details" button is simultaneously clickable, and clicking two
// different rings' Details buttons in quick succession let whichever
// response resolved last win, even if it wasn't the last one clicked. Same
// monotonic-token-guard fix shape as this panel's own loadRings (#1909,
// see admin-dashboard-rings-panel-race.test.mjs), applied to viewRing via a
// new, separate ringDetailLoadToken.
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

// Two distinct, genuinely adjacent (non-overlapping) rings, same setup
// admin-dashboard-rings-panel-race.test.mjs already uses.
const ringAId = `e2e-rings-detail-race-a-${Date.now()}`;
const ringBId = `e2e-rings-detail-race-b-${Date.now()}`;
await generateRing({ prefix: ringAId, count: 3 });
await generateRing({ prefix: ringBId, count: 3, adjacentToRingId: ringAId });
console.log('generated two distinct test rings:', ringAId, ringBId);

const page = await browser.newPage();
page.on('pageerror', (err) => errors.push(err.message));
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
await page.context().addCookies([{ name: 'hh_session', value: token, url: BASE_URL }]);

// Delay only ring A's own single-ring detail fetch, so clicking A's Details
// then B's Details in quick succession leaves A's (now-stale) response
// landing after B's.
let delayRingA = true;
await page.route('**/api/land-candidate-rings/*', async (route) => {
  if (delayRingA && route.request().url().includes(encodeURIComponent(ringAId))) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  await route.continue();
});

await page.goto(`${BASE_URL}/admin/dashboard`, { waitUntil: 'networkidle' });
await page.click('button[data-panel="world"]');
await page.waitForFunction(
  () => document.getElementById('ringsTableWrap').textContent.length > 0,
  { timeout: 10000 },
);

await page.click(`.ring-view-btn[data-ring-id="${ringAId}"]`); // fires the slow, delayed request
await page.waitForTimeout(300);
await page.click(`.ring-view-btn[data-ring-id="${ringBId}"]`); // fires a fresh, fast request that should win

await page.waitForFunction(
  (ringId) => document.getElementById('ringDetailId').textContent === ringId,
  ringBId,
  { timeout: 10000 },
);
const detailAfterFastClick = await page.textContent('#ringDetailId');
console.log('ring detail panel shows the last-clicked ring B right after its own fast response lands (should be true):', detailAfterFastClick === ringBId);

// Wait out ring A's delayed response too, and confirm it didn't land late
// and overwrite ring B's still-displayed detail.
await page.waitForTimeout(2200);
delayRingA = false;
const detailAfterStaleResponse = await page.textContent('#ringDetailId');
console.log('ring detail panel still shows ring B after the stale, delayed ring A response also lands (should be true):', detailAfterStaleResponse === ringBId);

const pass = detailAfterFastClick === ringBId &&
  detailAfterStaleResponse === ringBId &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: '#2073: a stale, delayed ring Details response does not overwrite a fresher one',
  errors,
});
