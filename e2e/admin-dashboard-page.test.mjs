// #1818 (sub-issue of #1817): the page shell/nav/auth-gating other #1817
// sub-issues plug their own panel content into. Same "a unit test using the
// workers-pool ASSETS binding can't run a real vite build, so the
// /admin/... page-serving route itself needs a real e2e check" reasoning as
// e2e/control-room-admin-page.test.mjs and e2e/admin-action-log-page.test.mjs
// (see their own comments) — worker/control-room.test.js already covers the
// requireAdmin gate itself, so this only needs to exercise the real static
// file end to end: the shell renders, nav switches panels, and the external
// links point at the two pre-existing admin pages rather than re-implementing
// them.
import { chromium } from 'playwright';
import { ensureAdminSession, finish } from './helpers.mjs';

const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH || null;
const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';

const browser = await chromium.launch(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {});
const errors = [];

// --- An anonymous visitor gets the sign-in message, never the real page ---
const anonPage = await browser.newPage();
anonPage.on('pageerror', (err) => errors.push(err.message));
const anonResponse = await anonPage.goto(`${BASE_URL}/admin/dashboard`);
const anonStatus = anonResponse.status();
console.log('anonymous visitor status (should be 401):', anonStatus);
const anonBodyText = await anonPage.textContent('body');
const anonSeesSignIn = anonBodyText.includes('Sign in');
console.log('anonymous visitor sees the sign-in message (should be true):', anonSeesSignIn);
await anonPage.close();

// --- The owner's own admin session sees the real page ---
const sessionCookie = await ensureAdminSession(); // "hh_session=<token>"
const [, token] = sessionCookie.split('=');

const page = await browser.newPage();
page.on('pageerror', (err) => errors.push(err.message));
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
await page.context().addCookies([{ name: 'hh_session', value: token, url: BASE_URL }]);

await page.goto(`${BASE_URL}/admin/dashboard`, { waitUntil: 'networkidle' });
const heading = await page.textContent('h1');
console.log('admin page heading (should be "Admin Dashboard"):', heading);

// The default/first panel (roster) should already be visible on load.
const rosterVisibleByDefault = await page.locator('#panel-roster').isVisible();
console.log('roster panel visible by default (should be true):', rosterVisibleByDefault);
const modelsHiddenByDefault = await page.locator('#panel-models').isVisible();
console.log('models panel hidden by default (should be false):', modelsHiddenByDefault);

// Clicking a nav item switches the visible panel.
await page.click('button[data-panel="models"]');
const modelsVisibleAfterClick = await page.locator('#panel-models').isVisible();
const rosterHiddenAfterClick = await page.locator('#panel-roster').isVisible();
console.log('models panel visible after clicking its nav item (should be true):', modelsVisibleAfterClick);
console.log('roster panel hidden after switching away (should be false):', rosterHiddenAfterClick);
const modelsNavActive = await page.locator('button[data-panel="models"]').evaluate((el) => el.classList.contains('active'));
console.log('models nav button marked active after click (should be true):', modelsNavActive);

// The clearly-labeled Test/Ops Fixtures panel.
await page.click('button[data-panel="fixtures"]');
const fixturesVisible = await page.locator('#panel-fixtures').isVisible();
const fixturesBadgeText = await page.textContent('#panel-fixtures .fixtures-badge');
console.log('fixtures panel visible after clicking its nav item (should be true):', fixturesVisible);
console.log('fixtures panel carries its own "not a real transaction" badge (actual):', fixturesBadgeText.trim());

// External links out to the two pre-existing admin pages, not rebuilt here.
const controlRoomHref = await page.getAttribute('a[href="/admin/control-room"]', 'href');
const actionLogHref = await page.getAttribute('a[href="/admin/action-log"]', 'href');
console.log('nav links out to the Control Room page (actual href):', controlRoomHref);
console.log('nav links out to the Action Log page (actual href):', actionLogHref);

const pass = anonStatus === 401 &&
  anonSeesSignIn &&
  heading === 'Admin Dashboard' &&
  rosterVisibleByDefault &&
  !modelsHiddenByDefault &&
  modelsVisibleAfterClick &&
  !rosterHiddenAfterClick &&
  modelsNavActive &&
  fixturesVisible &&
  fixturesBadgeText.toLowerCase().includes('not a real transaction') &&
  controlRoomHref === '/admin/control-room' &&
  actionLogHref === '/admin/action-log' &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: 'Admin Dashboard shell (#1818): gated for anon visitors, nav switches panels, Test/Ops Fixtures clearly labeled, external links to existing admin pages',
  errors,
});
