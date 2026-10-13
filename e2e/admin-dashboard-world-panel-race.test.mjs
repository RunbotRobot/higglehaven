// #1927: loadWorld (public/admin-dashboard.html, World panel's stats/settings
// loader) had no request-ordering guard -- an in-flight GET /api/world
// response captured BEFORE a real world-state change (e.g. a radius bump)
// could still arrive at the page AFTER a later, fresher GET /api/world
// response that already reflects the change, and its own unconditional
// renderWorld(body.world) would silently revert the UI back to the stale
// pre-change values. Same monotonic-token-guard fix shape as the sibling
// admin-dashboard-*-panel-race tests (#1878/#1909/etc), but here the
// staleness has to come from the underlying data actually changing between
// two requests (a single-object endpoint, not a paginated list) -- so this
// test captures the real server response for the first GET at the moment
// it's made (before the radius bump), and only delays *delivering* that
// already-captured response to the page via route.fulfill(), rather than
// delaying when the request is sent.
import { chromium } from 'playwright';
import { ensureAdminSession, finish } from './helpers.mjs';

const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH || null;
const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';

const browser = await chromium.launch(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {});
const errors = [];

const sessionCookie = await ensureAdminSession(); // "hh_session=<token>"
const [, token] = sessionCookie.split('=');

async function getWorld() {
  const response = await fetch(`${BASE_URL}/api/world`, { headers: { Cookie: `hh_session=${token}` } });
  const body = await response.json();
  if (response.status !== 200) throw new Error(`getWorld failed (${response.status}): ${JSON.stringify(body)}`);
  return body.world;
}

async function bumpWorldRadius(newRadiusM) {
  const response = await fetch(`${BASE_URL}/api/world`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: `hh_session=${token}` },
    body: JSON.stringify({ radiusM: newRadiusM }),
  });
  const body = await response.json();
  if (response.status !== 200) throw new Error(`bumpWorldRadius failed (${response.status}): ${JSON.stringify(body)}`);
  return body.world;
}

const initialWorld = await getWorld();
const bumpedRadiusM = initialWorld.radiusM + 100;
console.log('world radiusM before the race (should be the stale value the delayed response carries):', initialWorld.radiusM);
console.log('world radiusM the race bumps to (should be the one that wins):', bumpedRadiusM);

const page = await browser.newPage();
page.on('pageerror', (err) => errors.push(err.message));
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
await page.context().addCookies([{ name: 'hh_session', value: token, url: BASE_URL }]);

// Only the first GET /api/world (the page's own initial loadWorld() call) is
// captured-then-delayed; later ones (the Refresh click) pass straight
// through. PATCH requests to the same URL are left alone either way.
let firstGetIntercepted = false;
await page.route('**/api/world', async (route) => {
  if (route.request().method() !== 'GET' || firstGetIntercepted) {
    await route.continue();
    return;
  }
  firstGetIntercepted = true;
  // Captures the real response NOW (reflecting world state before the
  // radius bump below), then delays only handing it to the page -- so it
  // carries genuinely stale data by the time it lands.
  const response = await route.fetch();
  await new Promise((resolve) => setTimeout(resolve, 2000));
  await route.fulfill({ response });
});

// Not 'networkidle' -- that would block this call until the delayed,
// captured-but-not-yet-fulfilled initial GET /api/world finishes, which
// defeats the whole race (nothing would still be in flight afterward).
await page.goto(`${BASE_URL}/admin/dashboard`, { waitUntil: 'load' });
await page.click('button[data-panel="world"]');

await bumpWorldRadius(bumpedRadiusM);
await page.click('#worldRefreshBtn'); // fresh GET /api/world, reflects the bump, should win
await page.waitForFunction(
  (radiusM) => document.getElementById('worldRadiusInput').value === String(radiusM),
  bumpedRadiusM,
  { timeout: 10000 },
);
const radiusAfterRefresh = await page.locator('#worldRadiusInput').inputValue();
console.log('radiusM input right after Refresh (should be the bumped value):', radiusAfterRefresh);

// Wait out the delayed, stale initial-load response too, and confirm it
// didn't land late and revert the UI back to the pre-bump radius.
await page.waitForTimeout(2200);
const finalRadius = await page.locator('#worldRadiusInput').inputValue();
console.log('radiusM input after the stale initial-load response also lands (should stay the bumped value, not revert):', finalRadius);

const pass = radiusAfterRefresh === String(bumpedRadiusM) &&
  finalRadius === String(bumpedRadiusM) &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: '#1927: a stale, delayed initial-load world response does not revert a fresher Refresh\'s radius',
  errors,
});
