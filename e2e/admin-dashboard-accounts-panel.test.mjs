// #2299: the Admin Dashboard's Account suspension panel -- a thin form over
// the already-built, already-tested handleSuspendAccount/
// handleUnsuspendAccount/handleSuspensionStatus endpoints (worker/index.js,
// covered at the API level by worker/account-suspension.test.js and
// friends). This only needs to exercise what that suite can't -- the real
// static page's own client-side JS wiring (the actual fetch calls, their
// request bodies, and rendering of both the success and error paths), same
// reasoning admin-dashboard-fixtures-grant.test.mjs's own comment gives for
// why this page needs a real e2e check at all.
import { ensureAdminSession, finish } from './helpers.mjs';
import { chromium } from 'playwright';

const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH || null;
const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';

const browser = await chromium.launch(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {});
const errors = [];

// Plain Node-side fetch, deliberately not page.evaluate(fetch(...)) -- see
// helpers.mjs's own adminApi comment for why: running this inside the admin
// page would share (and overwrite) its own session cookie jar.
async function api(path, cookie, options = {}) {
  const response = await fetch(`${BASE_URL}/api${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...options.headers,
    },
  });
  let body = null;
  try { body = await response.json(); } catch (_) { /* no body */ }
  return { response, body };
}

const adminCookie = await ensureAdminSession(); // "hh_session=<token>"
const [, adminToken] = adminCookie.split('=');

// A fresh, ordinary (non-admin) account for this test to suspend/unsuspend --
// created via a plain fetch, entirely separate from the admin page's own
// session below.
const targetEmail = `e2e-suspend-target-${Date.now()}@example.com`;
const signedUp = await api('/auth/signup', null, {
  method: 'POST',
  body: JSON.stringify({
    email: targetEmail, password: 'a fine long password', username: `e2e-suspend-${Date.now()}`,
    ageAttested: true,
  }),
});
if (signedUp.response.status !== 201) {
  throw new Error(`signup for test target failed (${signedUp.response.status}): ${JSON.stringify(signedUp.body)}`);
}

const page = await browser.newPage();
page.on('pageerror', (err) => errors.push(err.message));
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
await page.context().addCookies([{ name: 'hh_session', value: adminToken, url: BASE_URL }]);

await page.goto(`${BASE_URL}/admin/dashboard`, { waitUntil: 'networkidle' });
await page.click('button[data-panel="accounts"]');
const panelVisible = await page.locator('#panel-accounts').isVisible();
console.log('accounts panel visible after clicking its nav item (should be true):', panelVisible);

// --- Status lookup before any suspension: no active suspension ---
await page.fill('#suspensionStatusEmailInput', targetEmail);
await page.click('#suspensionStatusBtn');
await page.waitForFunction(
  () => document.getElementById('suspensionStatusResult')?.textContent.trim().length > 0,
  null,
  { timeout: 10000 },
);
const statusBeforeText = await page.textContent('#suspensionStatusResult');
console.log('suspension status before suspending (should say "No active suspension."):', statusBeforeText.trim());

// --- Suspend, with an evidence note and content removal opted in ---
const reason = 'E2E test suspension -- counterfeit listing report';
const evidenceNote = 'Admin-only evidence note for e2e coverage';
await page.fill('#suspendForm input[name="email"]', targetEmail);
await page.fill('#suspendForm input[name="reason"]', reason);
await page.fill('#suspendForm input[name="graceDays"]', '14');
await page.fill('#suspendForm input[name="evidenceNote"]', evidenceNote);
await page.check('#suspendForm input[name="removeContent"]');
await page.click('#suspendForm button[type="submit"]');
await page.waitForSelector('#suspendOk:not([hidden])', { timeout: 10000 });
const suspendOkText = await page.textContent('#suspendOk');
console.log('suspend success message (should mention grace period ending):', suspendOkText);

// Cross-check against a real, independent read of the same account --
// same reasoning admin-dashboard-fixtures-grant.test.mjs's own comment
// gives for not trusting the UI's own claimed result by itself.
const statusAfterSuspend = await api(`/auth/suspension-status?email=${encodeURIComponent(targetEmail)}`, adminCookie);
console.log('real suspension-status read after suspending:', JSON.stringify(statusAfterSuspend.body));
const reallySuspended = statusAfterSuspend.body?.suspension?.reason === reason
  && typeof statusAfterSuspend.body?.suspension?.gracePeriodEndsAt === 'string';

// --- Status lookup in the UI reflects the real, just-created suspension ---
await page.click('#suspensionStatusBtn'); // re-run the lookup for the same email already filled in
await page.waitForFunction(
  () => document.getElementById('suspensionStatusResult')?.textContent.includes('counterfeit listing report'),
  null,
  { timeout: 10000 },
);
const statusAfterText = await page.textContent('#suspensionStatusResult');
console.log('suspension status after suspending (should show the reason and evidence note):', statusAfterText.trim());

// --- Error path: suspending an unknown email surfaces the real 404, not a false "success" ---
await page.fill('#suspendForm input[name="email"]', 'no-such-account-e2e@example.com');
await page.fill('#suspendForm input[name="reason"]', 'irrelevant');
await page.click('#suspendForm button[type="submit"]');
await page.waitForSelector('#suspendErr:not([hidden])', { timeout: 10000 });
const suspendErrText = await page.textContent('#suspendErr');
console.log('suspend error message for unknown email (should mention no account found):', suspendErrText);

// --- Unsuspend the real target account, then confirm via both UI and API ---
await page.fill('#unsuspendForm input[name="email"]', targetEmail);
await page.click('#unsuspendForm button[type="submit"]');
await page.waitForSelector('#unsuspendOk:not([hidden])', { timeout: 10000 });
const unsuspendOkText = await page.textContent('#unsuspendOk');
console.log('unsuspend success message:', unsuspendOkText);

const statusAfterUnsuspend = await api(`/auth/suspension-status?email=${encodeURIComponent(targetEmail)}`, adminCookie);
console.log('real suspension-status read after unsuspending (should be null):', JSON.stringify(statusAfterUnsuspend.body));
const reallyUnsuspended = statusAfterUnsuspend.body?.suspension === null;

await page.click('#suspensionStatusBtn');
await page.waitForFunction(
  () => document.getElementById('suspensionStatusResult')?.textContent.includes('No active suspension.'),
  null,
  { timeout: 10000 },
);
const statusAfterUnsuspendText = await page.textContent('#suspensionStatusResult');
console.log('UI suspension status after unsuspending (should say "No active suspension."):', statusAfterUnsuspendText.trim());

// The deliberate 404 above (triggering the error path on purpose) makes
// Chromium log a "Failed to load resource: 404" console error independent
// of this page's own handling -- the same established, expected side
// effect admin-dashboard-fixtures-grant.test.mjs and others already filter.
errors.splice(0, errors.length, ...errors.filter((e) => !e.includes('Failed to load resource')));

const pass =
  panelVisible &&
  statusBeforeText.includes('No active suspension.') &&
  /grace period/i.test(suspendOkText) &&
  reallySuspended &&
  statusAfterText.includes('counterfeit listing report') &&
  statusAfterText.includes(evidenceNote) &&
  /no account/i.test(suspendErrText) &&
  /unsuspended/i.test(unsuspendOkText) &&
  reallyUnsuspended &&
  statusAfterUnsuspendText.includes('No active suspension.') &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: '#2299: Admin Dashboard Account suspension panel suspends/unsuspends and reads status through the real endpoints',
  errors,
});
