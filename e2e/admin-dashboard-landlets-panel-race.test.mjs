// #2062: the Admin Dashboard's Landlets override panel lookupLandlet()
// (public/admin-dashboard.html) had no stale-response guard -- unlike every
// sibling panel in this same file (loadRoster/#1877, worldLoadToken/#1927,
// ringsLoadToken/#1909, candidatesLoadToken/#1910, taxFormsLoadToken/#1918,
// purchasesLoadToken/#1928, modelsLoadToken/#1878). A slow lookup for
// landlet A, still in flight when the admin looks up landlet B instead,
// could resolve after B's and silently flip currentLandlet (and the visible
// stat grid) back to A -- with Force Complete/Reassign Owner then acting on
// the wrong landlet. GET /api/landlets/:id (unlike the Purchases panel's own
// #1928 race) carries the landlet id right in its URL, so this delays only
// A's own request by matching on that id specifically, same technique
// e2e/admin-dashboard-rings-panel-race.test.mjs/world-panel-race.test.mjs
// already use for their own per-id GETs.
import { chromium } from 'playwright';
import { createGreenbeltLandletAsAdmin, ensureAdminSession, finish } from './helpers.mjs';

const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH || null;
const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';

const browser = await chromium.launch(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {});
const errors = [];

const suffix = Date.now().toString(36);
const LANDLET_A = `e2e-landlets-race-a-${suffix}`;
const LANDLET_B = `e2e-landlets-race-b-${suffix}`;

await createGreenbeltLandletAsAdmin(LANDLET_A);
await createGreenbeltLandletAsAdmin(LANDLET_B);

const sessionCookie = await ensureAdminSession(); // "hh_session=<token>"
const [, token] = sessionCookie.split('=');

const page = await browser.newPage();
page.on('pageerror', (err) => errors.push(err.message));
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
await page.context().addCookies([{ name: 'hh_session', value: token, url: BASE_URL }]);

// Delay only the response to A's own GET -- dispatches the real request
// immediately (so it reflects real data, not a mocked snapshot) and only
// withholds *delivering* it, so B's lookup (fired while A's is still
// pending) can resolve first.
await page.route(`**/api/landlets/${LANDLET_A}`, async (route) => {
  const response = await route.fetch();
  await new Promise((resolve) => setTimeout(resolve, 1800));
  await route.fulfill({ response });
});

await page.goto(`${BASE_URL}/admin/dashboard`, { waitUntil: 'networkidle' });
await page.click('button[data-panel="landlets"]');

await page.fill('#landletLookupInput', LANDLET_A);
await page.click('#landletLookupBtn'); // delayed, in flight for 1800ms

await page.waitForTimeout(300);

await page.fill('#landletLookupInput', LANDLET_B);
await page.click('#landletLookupBtn'); // undelayed -- resolves well before A's

await page.waitForFunction(
  (id) => document.getElementById('landletStatGrid')?.textContent.includes(id),
  LANDLET_B,
  { timeout: 10000 },
);
const statGridAfterB = await page.locator('#landletStatGrid').textContent();
console.log('stat grid right after B\'s own (fast) lookup resolves (should mention B, not A):', statGridAfterB.includes(LANDLET_B), statGridAfterB.includes(LANDLET_A));

// Wait out A's stale, delayed response too.
await page.waitForTimeout(2200);
const statGridFinal = await page.locator('#landletStatGrid').textContent();
console.log('stat grid after A\'s stale, delayed response also lands (should still mention B, not reverted to A):', statGridFinal);

const pass =
  statGridAfterB.includes(LANDLET_B) && !statGridAfterB.includes(LANDLET_A) &&
  statGridFinal.includes(LANDLET_B) && !statGridFinal.includes(LANDLET_A) &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: '#2062: a stale, delayed landlet lookup does not revert a fresher lookup\'s result',
  errors,
});
