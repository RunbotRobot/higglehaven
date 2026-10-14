// #2072: the Admin Dashboard's Landlets override panel got a stale-response
// guard for lookupLandlet() itself (#2062/PR #2065), but forceComplete() and
// reassign() -- the two POST actions that also call renderLandlet() (which
// reassigns currentLandlet) on success -- never checked that same token.
// A slow Force Complete/Reassign for landlet A, still in flight after the
// admin has since looked up landlet B instead, could silently rebind the
// panel back to A once A's POST response landed. This delays only A's own
// generation-complete POST (same per-id route-matching technique as
// e2e/admin-dashboard-landlets-panel-race.test.mjs's own #2062 test) and
// races it against a lookup of B.
import { chromium } from 'playwright';
import { createGeneratingLandletAsAdmin, createGreenbeltLandletAsAdmin, ensureAdminSession, finish } from './helpers.mjs';

const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH || null;
const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';

const browser = await chromium.launch(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {});
const errors = [];

const suffix = Date.now().toString(36);
const LANDLET_A = `e2e-landlets-action-race-a-${suffix}`;
const LANDLET_B = `e2e-landlets-action-race-b-${suffix}`;

// Centered at the origin -- always enclosed, so force-complete promotes it
// straight to greenbelt (a clear, distinct post-action state to check for).
await createGeneratingLandletAsAdmin(LANDLET_A, { center: { x: 0, y: 0 } });
await createGreenbeltLandletAsAdmin(LANDLET_B);

const sessionCookie = await ensureAdminSession(); // "hh_session=<token>"
const [, token] = sessionCookie.split('=');

const page = await browser.newPage();
page.on('pageerror', (err) => errors.push(err.message));
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
await page.context().addCookies([{ name: 'hh_session', value: token, url: BASE_URL }]);

// Delay only A's own generation-complete response -- dispatches the real
// request immediately (so the completion genuinely happens server-side,
// not just a mocked reply) and only withholds *delivering* it back.
await page.route(`**/api/landlets/${LANDLET_A}/generation-complete`, async (route) => {
  const response = await route.fetch();
  await new Promise((resolve) => setTimeout(resolve, 1800));
  await route.fulfill({ response });
});

await page.goto(`${BASE_URL}/admin/dashboard`, { waitUntil: 'networkidle' });
await page.click('button[data-panel="landlets"]');

async function lookup(landletId) {
  await page.fill('#landletLookupInput', landletId);
  await page.click('#landletLookupBtn');
  await page.waitForFunction(
    (id) => document.getElementById('landletStatGrid')?.textContent.includes(id),
    landletId,
    { timeout: 10000 },
  );
}

await lookup(LANDLET_A);
await page.click('#landletForceCompleteBtn'); // delayed POST, in flight for 1800ms

await page.waitForTimeout(300);

await lookup(LANDLET_B); // fast GET, resolves well before A's delayed POST

const statGridAfterB = await page.locator('#landletStatGrid').textContent();
console.log('stat grid right after looking up B while A\'s force-complete is still in flight (should mention B, not A):', statGridAfterB.includes(LANDLET_B), statGridAfterB.includes(LANDLET_A));

// Wait out A's stale, delayed force-complete response too.
await page.waitForTimeout(2200);
const statGridFinal = await page.locator('#landletStatGrid').textContent();
console.log('stat grid after A\'s stale, delayed force-complete response also lands (should still mention B, not reverted to A):', statGridFinal);

const pass =
  statGridAfterB.includes(LANDLET_B) && !statGridAfterB.includes(LANDLET_A) &&
  statGridFinal.includes(LANDLET_B) && !statGridFinal.includes(LANDLET_A) &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: '#2072: a stale, delayed Force Complete response does not revert a fresher lookup\'s result',
  errors,
});
