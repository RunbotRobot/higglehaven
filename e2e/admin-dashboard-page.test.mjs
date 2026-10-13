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
const me = await fetch(`${BASE_URL}/api/auth/me`, { headers: { cookie: sessionCookie } });
const adminEmail = (await me.json()).user.email;

const page = await browser.newPage();
page.on('pageerror', (err) => errors.push(err.message));
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
// The roster panel's Revoke button goes through a confirm() -- auto-accept
// it, same as launchPage's own dialog handler elsewhere in this suite.
page.on('dialog', (dialog) => dialog.accept());
await page.context().addCookies([{ name: 'hh_session', value: token, url: BASE_URL }]);

await page.goto(`${BASE_URL}/admin/dashboard`, { waitUntil: 'networkidle' });
const heading = await page.textContent('h1');
console.log('admin page heading (should be "Admin Dashboard"):', heading);

// The default/first panel (roster) should already be visible on load.
const rosterVisibleByDefault = await page.locator('#panel-roster').isVisible();
console.log('roster panel visible by default (should be true):', rosterVisibleByDefault);
const modelsHiddenByDefault = await page.locator('#panel-models').isVisible();
console.log('models panel hidden by default (should be false):', modelsHiddenByDefault);

// --- #1819: roster panel actually lists/grants/revokes admins ---
await page.waitForSelector('#rosterTableWrap table', { timeout: 10000 });
const ownRowVisible = await page.locator('#rosterTableWrap', { hasText: adminEmail }).isVisible();
console.log('roster panel lists the signed-in admin by email (should be true):', ownRowVisible);

// grant-admin only promotes an *existing* account by email -- it doesn't
// create one -- so this needs a real signup first, the same prerequisite
// handleGrantAdmin's own unit test (worker/reviews-auth.test.js) sets up
// via signupBuilder before ever calling grant-admin.
const grantEmail = `e2e-roster-grant-${crypto.randomUUID()}@e2e.test`;
await fetch(`${BASE_URL}/api/auth/signup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    email: grantEmail, password: 'e2e-roster-grant-password-123',
    username: `e2e-roster-grant-${crypto.randomUUID().slice(0, 8)}`, ageAttested: true,
  }),
});
await page.fill('#grantEmailInput', grantEmail);
await page.click('#grantBtn');
const grantedRow = page.locator('#rosterTableWrap tr', { has: page.locator('td', { hasText: grantEmail }) });
await grantedRow.waitFor({ timeout: 10000 });
const grantedRowVisible = await grantedRow.isVisible();
console.log('granting a new admin by email adds it to the roster list (should be true):', grantedRowVisible);

await grantedRow.locator('.revoke-btn').click();
await grantedRow.waitFor({ state: 'detached', timeout: 10000 });
const grantedRowGoneAfterRevoke = await page.locator('#rosterTableWrap', { hasText: grantEmail }).count() === 0;
console.log('revoking that admin removes it from the roster list (should be true):', grantedRowGoneAfterRevoke);

// #1877: loadRoster() had no request-ordering guard -- a slower,
// overlapping call (e.g. a manual Refresh still in flight) could land
// after a faster, newer one (grantAdmin's own success-path reload) and
// silently overwrite the table with stale rows. Delay only the Refresh
// click's own GET /api/auth/admins so it's still in flight when
// grantAdmin's reload resolves first, same technique admin-action-log-
// page.test.mjs's own #1857 regression test uses.
let delayNextAdminsGet = false;
await page.route('**/api/auth/admins', async (route) => {
  if (delayNextAdminsGet) {
    delayNextAdminsGet = false;
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await route.fulfill({ response });
    return;
  }
  await route.continue();
});

const raceGrantEmail = `e2e-roster-race-${crypto.randomUUID()}@e2e.test`;
await fetch(`${BASE_URL}/api/auth/signup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    email: raceGrantEmail, password: 'e2e-roster-race-password-123',
    username: `e2e-roster-race-${crypto.randomUUID().slice(0, 8)}`, ageAttested: true,
  }),
});

delayNextAdminsGet = true;
await page.click('#rosterRefreshBtn'); // triggers the delayed, stale call
await page.waitForTimeout(300); // let it actually start before granting
await page.fill('#grantEmailInput', raceGrantEmail);
await page.click('#grantBtn'); // triggers a second, undelayed call
const raceGrantedRow = page.locator('#rosterTableWrap tr', { has: page.locator('td', { hasText: raceGrantEmail }) });
await raceGrantedRow.waitFor({ timeout: 10000 });
const raceGrantedRowVisibleBeforeStaleResponse = await raceGrantedRow.isVisible();
console.log('granting lands before the delayed Refresh call resolves, so the table already shows it (should be true):', raceGrantedRowVisibleBeforeStaleResponse);

// Wait out the delayed Refresh response too, and confirm it didn't land
// late and silently revert the table to its own stale (pre-grant) list.
await page.waitForTimeout(2700);
const raceGrantedRowStillVisibleAfterStaleResponse = await page.locator('#rosterTableWrap', { hasText: raceGrantEmail }).isVisible();
console.log('newly granted admin still shown after the stale delayed Refresh response also lands (should be true, not overwritten):', raceGrantedRowStillVisibleAfterStaleResponse);

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
  ownRowVisible &&
  grantedRowVisible &&
  grantedRowGoneAfterRevoke &&
  raceGrantedRowVisibleBeforeStaleResponse &&
  raceGrantedRowStillVisibleAfterStaleResponse &&
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
  label: 'Admin Dashboard shell (#1818) + roster panel (#1819, #1877): gated for anon visitors, nav switches panels, roster lists/grants/revokes admins and survives a stale overlapping reload, Test/Ops Fixtures clearly labeled, external links to existing admin pages',
  errors,
});
