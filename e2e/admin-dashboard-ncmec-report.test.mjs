// #3040: the Admin Dashboard's "Report to NCMEC" form (Accounts panel) -- a
// thin form over POST/GET /api/ncmec-reports, whose behavior (insert-only,
// one report per decision, admin-only, nothing visible to the reported
// account) is covered at the API level by worker/ncmec-reports.test.js.
// This exercises what that suite can't: that the real page's own client-
// side wiring works and, since a JS error while the Accounts panel
// initializes would also break its suspend/unsuspend forms, that adding
// this form didn't.
import { ensureAdminSession, finish } from './helpers.mjs';
import { chromium } from 'playwright';

const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH || null;
const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';

const browser = await chromium.launch(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {});
const errors = [];

// Plain Node-side fetch, not page.evaluate(fetch(...)) -- see helpers.mjs's
// own adminApi comment for why.
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

const adminCookie = await ensureAdminSession();
const [, adminToken] = adminCookie.split('=');

// A fresh account with a real, confirmed suspension to report. Created over
// plain fetch, entirely separate from the admin page's own session.
const targetEmail = `e2e-ncmec-target-${Date.now()}@example.com`;
const signedUp = await api('/auth/signup', null, {
  method: 'POST',
  body: JSON.stringify({
    email: targetEmail, password: 'a fine long password', username: `e2e-ncmec-${Date.now()}`,
    ageAttested: true,
  }),
});
if (signedUp.response.status !== 201) {
  throw new Error(`signup for test target failed (${signedUp.response.status}): ${JSON.stringify(signedUp.body)}`);
}
const suspended = await api('/auth/suspend-account', adminCookie, {
  method: 'POST',
  body: JSON.stringify({ email: targetEmail, reason: 'E2E suspension to be reported' }),
});
if (suspended.response.status !== 200) {
  throw new Error(`suspending test target failed (${suspended.response.status}): ${JSON.stringify(suspended.body)}`);
}
const { suspensionId, userId } = suspended.body.suspension;

const page = await browser.newPage();
page.on('pageerror', (err) => errors.push(err.message));
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
let dialogMode = 'accept';
const dialogMessages = [];
page.on('dialog', async (dialog) => {
  dialogMessages.push(dialog.message());
  if (dialogMode === 'accept') await dialog.accept(); else await dialog.dismiss();
});
await page.context().addCookies([{ name: 'hh_session', value: adminToken, url: BASE_URL }]);

await page.goto(`${BASE_URL}/admin/dashboard`, { waitUntil: 'networkidle' });
await page.click('button[data-panel="accounts"]');

// The list loads when the panel opens; nothing reported for this account yet.
await page.waitForFunction(
  () => document.getElementById('ncmecReportsWrap')?.textContent.trim().length > 0,
  null,
  { timeout: 10000 },
);

// --- Find user -> a suspension's own Report button fills the form ---
await page.fill('#userSearchInput', targetEmail);
await page.click('#userSearchBtn');
await page.waitForSelector('.use-for-ncmec-btn', { timeout: 10000 });
await page.click('.use-for-ncmec-btn');
const filledSuspensionId = await page.inputValue('#ncmecReportForm input[name="suspensionId"]');
console.log('suspensionId filled from the Report button (should equal the real one):', filledSuspensionId === suspensionId);

// --- Switching decision type swaps the visible fields ---
await page.selectOption('#ncmecReportForm select[name="decisionType"]', 'content_removal');
const removalFieldsVisible = await page.locator('#ncmecRemovalFields').isVisible();
const suspensionFieldsHiddenOnRemoval = !(await page.locator('#ncmecSuspensionFields').isVisible());
await page.selectOption('#ncmecReportForm select[name="decisionType"]', 'account_suspension');
const suspensionFieldsVisible = await page.locator('#ncmecSuspensionFields').isVisible();
const removalFieldsHiddenAgain = !(await page.locator('#ncmecRemovalFields').isVisible());
console.log('field swap works:', removalFieldsVisible, suspensionFieldsHiddenOnRemoval, suspensionFieldsVisible, removalFieldsHiddenAgain);

// --- Declining the confirmation writes nothing ---
dialogMode = 'dismiss';
await page.fill('#ncmecReportForm input[name="note"]', 'e2e note');
await page.fill('#ncmecReportForm input[name="contentRefs"]', 'sign_posts:e2e-post-1');
await page.click('#ncmecReportForm button[type="submit"]');
await page.waitForTimeout(500);
const afterDismiss = await api(`/ncmec-reports?reportedUserId=${encodeURIComponent(userId)}`, adminCookie);
console.log('reports after declining the confirmation (should be 0):', afterDismiss.body?.reports?.length);

// --- Accepting records it; the UI result matches an independent API read ---
dialogMode = 'accept';
await page.click('#ncmecReportForm button[type="submit"]');
await page.waitForSelector('#ncmecReportOk:not([hidden])', { timeout: 10000 });
const okText = await page.textContent('#ncmecReportOk');
const afterCreate = await api(`/ncmec-reports?reportedUserId=${encodeURIComponent(userId)}`, adminCookie);
const created = afterCreate.body?.reports?.[0];
console.log('real report read after creating:', JSON.stringify(created));
const reallyCreated = afterCreate.body?.reports?.length === 1
  && created.decisionType === 'account_suspension'
  && created.decisionId === suspensionId
  && created.reportedUserId === userId
  && created.note === 'e2e note'
  && created.contentRefs.length === 1
  && created.contentRefs[0].sourceTable === 'sign_posts'
  && created.contentRefs[0].sourceId === 'e2e-post-1';

await page.waitForFunction(
  (id) => document.getElementById('ncmecReportsWrap')?.textContent.includes(id),
  suspensionId,
  { timeout: 10000 },
);
const listText = await page.textContent('#ncmecReportsWrap');

// --- Reporting the same decision again surfaces the real 409 ---
await page.click('.use-for-ncmec-btn');
await page.click('#ncmecReportForm button[type="submit"]');
await page.waitForSelector('#ncmecReportErr:not([hidden])', { timeout: 10000 });
const dupErrText = await page.textContent('#ncmecReportErr');
const afterDup = await api(`/ncmec-reports?reportedUserId=${encodeURIComponent(userId)}`, adminCookie);
console.log('duplicate attempt error:', dupErrText, '| reports after (should still be 1):', afterDup.body?.reports?.length);

// The deliberate 409 makes Chromium log a "Failed to load resource" console
// error independent of this page's own handling -- the same expected side
// effect the sibling admin-dashboard tests already filter.
errors.splice(0, errors.length, ...errors.filter((e) => !e.includes('Failed to load resource')));

const pass =
  filledSuspensionId === suspensionId &&
  removalFieldsVisible && suspensionFieldsHiddenOnRemoval && suspensionFieldsVisible && removalFieldsHiddenAgain &&
  afterDismiss.body?.reports?.length === 0 &&
  dialogMessages.length >= 2 && /permanent/i.test(dialogMessages[0]) &&
  /report recorded/i.test(okText) &&
  reallyCreated &&
  listText.includes(suspensionId) && listText.includes('sign_posts:e2e-post-1') &&
  /already been reported/i.test(dupErrText) &&
  afterDup.body?.reports?.length === 1 &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: '#3040: Admin Dashboard "Report to NCMEC" form confirms before writing, records through the real endpoint, and surfaces a duplicate',
  errors,
});
