// #4495 (the admin dashboard walked as the owner on a phone): a table in the Admin roster or R2 model storage panel
// used to widen the whole page (472 px and 980 px at a 390 px screen), so the toolbar and every other control slid
// off to the right. A table now scrolls inside its own wrapper and the page stays one screen wide.
import { chromium } from 'playwright';
import { ensureAdminSession, finish } from './helpers.mjs';

const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH || null;
const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';
const adminCookie = await ensureAdminSession();
const [, adminToken] = adminCookie.split('=');

const browser = await chromium.launch(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {});
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
await page.context().addCookies([{ name: 'hh_session', value: adminToken, url: BASE_URL }]);
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`${BASE_URL}/admin/dashboard`, { waitUntil: 'networkidle' });
let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

for (const panel of ['roster', 'models', 'accounts', 'purchases', 'flags']) {
  await page.click(`nav button[data-panel="${panel}"]`);
  await page.waitForTimeout(1500);
  const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  check(sw <= 391, `the ${panel} panel keeps the page one screen wide (page is ${sw} px at a 390 px screen)`);
}
await page.click('nav button[data-panel="roster"]');
await page.waitForTimeout(1000);
const table = await page.evaluate(() => {
  const t = document.querySelector('#rosterTableWrap table');
  if (!t) return null;
  const wrap = document.getElementById('rosterTableWrap');
  return { wrapOverflow: getComputedStyle(wrap).overflowX, wrapW: wrap.clientWidth };
});
check(table && table.wrapOverflow === 'auto' && table.wrapW <= 390, `the roster table scrolls inside its wrapper (${JSON.stringify(table)})`);

await finish(browser, { pass, label: '#4495: the admin dashboard stays one screen wide on a phone; tables scroll inside their wrappers', errors });
