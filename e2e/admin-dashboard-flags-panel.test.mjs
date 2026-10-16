// #2178: the Trust & Safety panel — counterfeit/policy flags (#2017) and
// self-dealing flags (#2019) review queues. The server-side list/resolve/
// review logic is already thoroughly covered by worker/product-flags.test.js
// and worker/self-dealing-flags.test.js's own vitest suites; this only needs
// to exercise what those suites can't — the real static page's own
// client-side JS wiring (the actual fetch calls, their own response parsing,
// and rendering), same reasoning admin-dashboard-purchases-panel.test.mjs's
// own comment gives for why this page needs a real e2e check at all.
import { chromium } from 'playwright';
import { ensureAdminSession, finish } from './helpers.mjs';

const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH || null;
const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';

const browser = await chromium.launch(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {});
const errors = [];

const sessionCookie = await ensureAdminSession(); // "hh_session=<token>"
const [, token] = sessionCookie.split('=');

const page = await browser.newPage();
page.on('pageerror', (err) => errors.push(err.message));
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
await page.context().addCookies([{ name: 'hh_session', value: token, url: BASE_URL }]);

await page.goto(`${BASE_URL}/admin/dashboard`, { waitUntil: 'networkidle' });
await page.click('button[data-panel="flags"]');
const panelVisible = await page.locator('#panel-flags').isVisible();
console.log('flags panel visible after clicking its nav item (should be true):', panelVisible);

// A fresh/clean test DB has no pending flag of either kind — exactly the
// empty-list path for both sub-sections, which still needs both real fetch
// calls (GET /api/product-flags and GET /api/self-dealing-flags) to succeed
// and parse correctly to reach.
await page.waitForFunction(
  () => document.getElementById('productFlagsStatusLine')?.textContent !== 'Loading…'
    && document.getElementById('selfDealingFlagsStatusLine')?.textContent !== 'Loading…',
  null,
  { timeout: 15000 },
);
const pfStatusText = await page.textContent('#productFlagsStatusLine');
const pfErrVisible = await page.locator('#productFlagsErr').isVisible();
const pfTableText = await page.textContent('#productFlagsTableWrap');
console.log('product flags status line (should read "0 shown · 0 total"):', pfStatusText);
console.log('product flags error line visible (should be false):', pfErrVisible);
console.log('product flags panel body (should say "No pending flags." in a fresh DB):', pfTableText.trim());

const sdStatusText = await page.textContent('#selfDealingFlagsStatusLine');
const sdErrVisible = await page.locator('#selfDealingFlagsErr').isVisible();
const sdTableText = await page.textContent('#selfDealingFlagsTableWrap');
console.log('self-dealing flags status line (should read "0 shown · 0 total"):', sdStatusText);
console.log('self-dealing flags error line visible (should be false):', sdErrVisible);
console.log('self-dealing flags panel body (should say "No pending flags." in a fresh DB):', sdTableText.trim());

const pass =
  panelVisible &&
  !pfErrVisible &&
  /^\d+ shown · \d+ total$/.test(pfStatusText.trim()) &&
  pfTableText.includes('No pending flags.') &&
  !sdErrVisible &&
  /^\d+ shown · \d+ total$/.test(sdStatusText.trim()) &&
  sdTableText.includes('No pending flags.') &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: 'Admin Dashboard Trust & Safety panel (#2178): loads real data via GET /api/product-flags and GET /api/self-dealing-flags, renders both empty states cleanly',
  errors,
});
