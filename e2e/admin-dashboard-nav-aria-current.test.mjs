// #1966: the Admin Dashboard's left-nav panel switcher (public/admin-
// dashboard.html) only ever toggled a CSS .active class to show which panel
// is current -- never an ARIA attribute, unlike the main app's own single-
// choice toggle groups (mode-nav/seller-view, fixed for #1503/#1760/#1842/
// #1901). A screen-reader user got no indication of which panel was
// selected. Fixed with aria-current="page", the semantically correct
// attribute for a <nav>'s current-page indicator.
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

const rosterBtn = 'button[data-panel="roster"]';
const modelsBtn = 'button[data-panel="models"]';

const rosterAriaCurrentInitially = await page.locator(rosterBtn).getAttribute('aria-current');
const modelsAriaCurrentInitially = await page.locator(modelsBtn).getAttribute('aria-current');
console.log('Roster nav aria-current on initial load (should be "page" -- the default-active panel):', rosterAriaCurrentInitially);
console.log('Models nav aria-current on initial load (should be null -- not the current panel):', modelsAriaCurrentInitially);

await page.click(modelsBtn);
await page.waitForTimeout(300);

const rosterAriaCurrentAfterSwitch = await page.locator(rosterBtn).getAttribute('aria-current');
const modelsAriaCurrentAfterSwitch = await page.locator(modelsBtn).getAttribute('aria-current');
console.log('Roster nav aria-current after switching to Models (should be null):', rosterAriaCurrentAfterSwitch);
console.log('Models nav aria-current after switching to it (should be "page"):', modelsAriaCurrentAfterSwitch);

const pass =
  rosterAriaCurrentInitially === 'page' &&
  modelsAriaCurrentInitially === null &&
  rosterAriaCurrentAfterSwitch === null &&
  modelsAriaCurrentAfterSwitch === 'page' &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: '#1966: Admin Dashboard nav buttons expose the current panel via aria-current, not just a CSS class',
  errors,
});
