// #1824 (sub-issue of #1817): the Purchases (admin fallback) panel —
// refund/mark-shipped for a purchase whose seller_id is dangling. The
// server-side filter/guard logic (GET /api/purchases?danglingSeller=1,
// and the refund/mark-shipped admin-override branches themselves) is
// already thoroughly covered by worker/commerce.test.js's own vitest
// suite; this only needs to exercise what that suite can't — the real
// static page's own client-side JS wiring (the actual fetch call, its
// own response parsing, and rendering), same "a unit test using the
// workers-pool ASSETS binding can't run a real vite build" reasoning
// admin-dashboard-page.test.mjs's own comment already gives for why this
// page needs a real e2e check at all.
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
await page.click('button[data-panel="purchases"]');
const panelVisible = await page.locator('#panel-purchases').isVisible();
console.log('purchases panel visible after clicking its nav item (should be true):', panelVisible);

// A fresh/clean test DB has no purchase with a dangling seller_id at all
// (every seeded/simulated purchase's own seller is still live) — exactly
// the empty-list path, which still needs the real fetch call to
// /api/purchases?danglingSeller=1 to succeed and parse correctly to reach.
// #2636 (sub-issue of #2635): waitForFunction's signature is (pageFunction,
// arg, options) -- a bare (fn, { timeout }) call puts the options object in
// the `arg` slot instead, so `options` stayed undefined and the real applied
// timeout was always Playwright's actual default (30000ms), never the
// smaller number written here. The explicit `null` arg reaches the options
// slot, and the timeout itself is widened to 60000ms for real headroom under
// CI load, same as this suite's other admin-dashboard-panel waits.
await page.waitForFunction(
  () => document.getElementById('purchasesStatusLine')?.textContent !== 'Loading…',
  null,
  { timeout: 60000 },
);
const statusText = await page.textContent('#purchasesStatusLine');
const errText = await page.locator('#purchasesErrLine').isVisible();
const tableWrapText = await page.textContent('#purchasesTableWrap');
console.log('purchases panel status line (should read "0 shown · N total", not an error):', statusText);
console.log('purchases panel error line visible (should be false):', errText);
console.log('purchases panel body (should say "No matching purchases." with nothing dangling in a fresh DB):', tableWrapText.trim());

const pass =
  panelVisible &&
  !errText &&
  /^\d+ shown · \d+ total$/.test(statusText.trim()) &&
  tableWrapText.includes('No matching purchases.') &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: 'Admin Dashboard purchases panel (#1824): loads real data via GET /api/purchases?danglingSeller=1 and renders the empty state cleanly',
  errors,
});
