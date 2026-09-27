// #996: admin_action_log (#814, migrations/0087) was write-only until this
// page/endpoint -- every requireAdmin-gated mutation logged who did what,
// but there was no way to browse it short of a direct D1 query. Same
// "a unit test using the workers-pool ASSETS binding can't run a real vite
// build, so the /admin/... page-serving route itself needs a real e2e
// check" reasoning as e2e/control-room-admin-page.test.mjs (see that
// file's own comment) -- worker/worker-api.test.js already covers the
// underlying GET /api/admin-action-log endpoint's own validation/filtering
// in depth, so this only needs to exercise the page-serving route and the
// real static file end to end, not re-cover every filter case.
import { chromium } from 'playwright';
import { ensureAdminSession, finish } from './helpers.mjs';

const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH || null;
const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';

const browser = await chromium.launch(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {});
const errors = [];

// --- An anonymous visitor gets the sign-in message, never the real page ---
const anonPage = await browser.newPage();
anonPage.on('pageerror', (err) => errors.push(err.message));
const anonResponse = await anonPage.goto(`${BASE_URL}/admin/action-log`);
const anonStatus = anonResponse.status();
console.log('anonymous visitor status (should be 401):', anonStatus);
const anonBodyText = await anonPage.textContent('body');
const anonSeesSignIn = anonBodyText.includes('Sign in');
console.log('anonymous visitor sees the sign-in message (should be true):', anonSeesSignIn);
await anonPage.close();

// --- Trigger one real, known admin action so there's something to see ---
const sessionCookie = await ensureAdminSession(); // "hh_session=<token>"
const [, token] = sessionCookie.split('=');

async function adminFetch(path, options) {
  const response = await fetch(`${BASE_URL}/api${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', cookie: sessionCookie, ...(options && options.headers) },
  });
  return { response, body: await response.json() };
}

// The admin's own builder (created on demand by GET /builders/me if it
// doesn't exist yet) — simplest available requireAdmin-gated mutation to
// trigger without needing a full browser-driven signup/claim flow, per
// grantLandCapHeadroomAsAdmin's own use of this same endpoint elsewhere in
// this suite.
const me = await adminFetch('/builders/me');
const builderId = me.body.builder.builderId;
const grantAmountCents = 4321;
const granted = await adminFetch(`/builders/${builderId}/land-cap-grants`, {
  method: 'POST', body: JSON.stringify({ amountCents: grantAmountCents }),
});
console.log('land-cap-grant response (status should be 201):', granted.response.status);

// --- The owner's own admin session sees the real page and the entry ---
const page = await browser.newPage();
page.on('pageerror', (err) => errors.push(err.message));
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
await page.context().addCookies([{ name: 'hh_session', value: token, url: BASE_URL }]);

await page.goto(`${BASE_URL}/admin/action-log`, { waitUntil: 'networkidle' });
const heading = await page.textContent('h1');
console.log('admin page heading (should be "higglehaven Admin Action Log"):', heading);

const row = page.locator('tr', { has: page.locator('td', { hasText: builderId }) });
await row.waitFor({ timeout: 10000 });
const rowText = await row.textContent();
console.log('logged land_cap_grant row is visible with the right action/target (actual row text):', rowText.trim());

const filteredRowVisible = await (async () => {
  await page.fill('input[name="actionType"]', 'land_cap_grant');
  await page.click('#filterBtn');
  await page.waitForLoadState('networkidle');
  return row.isVisible();
})();
console.log('row still visible after filtering by its own actionType (should be true):', filteredRowVisible);

const noMatchIsEmpty = await (async () => {
  await page.fill('input[name="actionType"]', 'this-action-type-does-not-exist');
  await page.click('#filterBtn');
  await page.locator('.empty').waitFor({ timeout: 10000 });
  return page.textContent('.empty');
})();
console.log('filtering by a non-existent actionType shows the empty state (actual):', noMatchIsEmpty.trim());

const pass = anonStatus === 401 &&
  anonSeesSignIn &&
  granted.response.status === 201 &&
  heading === 'higglehaven Admin Action Log' &&
  rowText.includes('land_cap_grant') &&
  rowText.includes(String(grantAmountCents)) &&
  filteredRowVisible &&
  noMatchIsEmpty.includes('No matching admin actions') &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: 'Admin action log page (#996): gated for anon visitors, lists a real logged action, filters work',
  errors,
});
