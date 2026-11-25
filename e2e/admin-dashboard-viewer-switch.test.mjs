// #4175 (slice c): the owner's switch for the look-only admin role, on a fleet account's detail in the admin
// dashboard: Give look-only access opens an in-app confirmation that says what the account will see, the
// server records it, and the button then offers Remove. A person's account is not offered the switch.
import { ensureAdminSession, localD1, finish } from './helpers.mjs';
import { chromium } from 'playwright';

const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH || null;
const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';
const browser = await chromium.launch(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {});
const errors = [];

async function api(path, cookie, options = {}) {
  const response = await fetch(`${BASE_URL}/api${path}`, {
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...options.headers },
  });
  let body = null;
  try { body = await response.json(); } catch (_) { /* no body */ }
  return { response, body };
}

const adminCookie = await ensureAdminSession();
const [, adminToken] = adminCookie.split('=');

async function makeAccount(prefix, fleet) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const email = `e2e-${prefix}-${stamp}@example.com`;
  const signup = await api('/auth/signup', null, { method: 'POST', body: JSON.stringify({ email, password: 'a fine long password', username: `e2e-${prefix}-${stamp}`, ageAttested: true }) });
  if (signup.response.status !== 201) throw new Error(`signup failed (${signup.response.status})`);
  if (fleet) localD1(`UPDATE users SET is_fleet = 1 WHERE email = '${email}'`);
  const found = await api(`/auth/admin-user-search?q=${encodeURIComponent(`e2e-${prefix}-${stamp}`)}`, adminCookie);
  return { userId: found.body.users[0].userId, username: found.body.users[0].username };
}

const fleet = await makeAccount('viewer-fleet', true);
const person = await makeAccount('viewer-person', false);

const page = await browser.newPage();
page.on('pageerror', (err) => errors.push(err.message));
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
await page.context().addCookies([{ name: 'hh_session', value: adminToken, url: BASE_URL }]);
await page.goto(`${BASE_URL}/admin/dashboard`, { waitUntil: 'networkidle' });
await page.click('button[data-panel="accounts"]');

const openDetail = async (userId) => {
  await page.evaluate((id) => window.__adminLoadUserDetail(id), userId);
  await page.waitForSelector('.delete-account-btn', { timeout: 10000 });
};

await openDetail(person.userId);
const offeredToPerson = await page.locator('.viewer-access-btn').count();
console.log('switch offered on an ordinary person (should be 0):', offeredToPerson);

await openDetail(fleet.userId);
const labelBefore = await page.textContent('.viewer-access-btn');
await page.click('.viewer-access-btn');
await page.waitForSelector('#viewerAccessDialog[open]', { timeout: 5000 });
const dialogText = await page.textContent('#viewerAccessBody');
console.log('dialog before giving access:', JSON.stringify(dialogText));
await page.click('#viewerAccessConfirm');
await page.waitForFunction(() => document.querySelector('.viewer-access-btn')?.textContent.includes('Remove'), null, { timeout: 10000 });
const labelAfter = await page.textContent('.viewer-access-btn');
const granted = localD1(`SELECT is_admin_viewer FROM users WHERE user_id = '${fleet.userId}'`, { json: true });
const loggedGrant = localD1(`SELECT count(*) AS n FROM admin_action_log WHERE action_type = 'admin_viewer_granted' AND target_id = '${fleet.userId}'`, { json: true });

await page.click('.viewer-access-btn');
await page.waitForSelector('#viewerAccessDialog[open]', { timeout: 5000 });
await page.click('#viewerAccessConfirm');
await page.waitForFunction(() => document.querySelector('.viewer-access-btn')?.textContent.includes('Give'), null, { timeout: 10000 });
const removed = localD1(`SELECT is_admin_viewer FROM users WHERE user_id = '${fleet.userId}'`, { json: true });

// --- The look-only admin's own dashboard (slice d) ---
const viewerStamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const viewerEmail = `e2e-viewer-seat-${viewerStamp}@example.com`;
const viewerSignup = await api('/auth/signup', null, { method: 'POST', body: JSON.stringify({ email: viewerEmail, password: 'a fine long password', username: `e2e-viewer-seat-${viewerStamp}`, ageAttested: true }) });
if (viewerSignup.response.status !== 201) throw new Error(`viewer signup failed (${viewerSignup.response.status})`);
const viewerToken = /hh_session=([^;]+)/.exec(viewerSignup.response.headers.get('set-cookie') || '')?.[1];
// Set directly (the owner's switch only gives it to a fleet account; this test needs a session it can open the page with).
localD1(`UPDATE users SET is_admin_viewer = 1 WHERE email = '${viewerEmail}'`);
const viewerPage = await browser.newPage();
viewerPage.on('pageerror', (err) => errors.push(err.message));
await viewerPage.context().addCookies([{ name: 'hh_session', value: viewerToken, url: BASE_URL }]);
await viewerPage.goto(`${BASE_URL}/admin/dashboard`, { waitUntil: 'networkidle' });
await viewerPage.waitForSelector('.viewer-banner', { timeout: 10000 }).catch(() => {});
const banner = (await viewerPage.textContent('.viewer-banner').catch(() => '')) || '';
await viewerPage.click('button[data-panel="accounts"]');
const submitDisabled = await viewerPage.locator('#suspendForm button[type="submit"]').isDisabled();
const readStatus = await viewerPage.evaluate(async () => (await fetch('/api/auth/admin-users')).status);
const writeAttempt = await viewerPage.evaluate(async () => {
  const response = await fetch('/api/auth/suspend-account', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  return { status: response.status, error: (await response.json()).error };
});
const maskedEmailInTable = await viewerPage.evaluate(async () => {
  const body = await (await fetch('/api/auth/admin-users')).json();
  return body.users.every((u) => !u.email.includes('@example.com') || u.email.includes('***'));
});
console.log('viewer dashboard:', JSON.stringify({ banner, submitDisabled, readStatus, writeAttempt, maskedEmailInTable }));
const pageOpenLogged = localD1("SELECT count(*) AS n FROM admin_action_log WHERE action_type = 'admin_viewer_page_open'", { json: true })[0].results[0].n;

// #4232: the admin pages' static files are served to an admin only.
const staticFile = (cookie) => fetch(`${BASE_URL}/admin-dashboard-5.js`, { headers: cookie ? { cookie } : {} }).then((r) => r.status);
const staticSignedOut = await staticFile(null);
const staticAdmin = await staticFile(adminCookie);
console.log('admin static file, signed out / admin (should be 404 / 200):', staticSignedOut, staticAdmin);

// The dashboard page's own favicon request is a 404 here, the same one admin-dashboard-accounts-panel filters.
errors.splice(0, errors.length, ...errors.filter((e) => !e.includes('Failed to load resource')));

const flag = (out) => out[0].results[0].is_admin_viewer;
const pass = offeredToPerson === 0
  && /Give look-only access/.test(labelBefore) && /Remove look-only access/.test(labelAfter)
  && /open the admin dashboard/.test(dialogText) && /cannot change anything/.test(dialogText)
  && flag(granted) === 1 && loggedGrant[0].results[0].n === 1 && flag(removed) === 0
  && /Look-only access/.test(banner) && submitDisabled && readStatus === 200
  && writeAttempt.status === 403 && /cannot change anything/.test(writeAttempt.error) && maskedEmailInTable && pageOpenLogged >= 1
  && staticSignedOut === 404 && staticAdmin === 200
  && errors.length === 0;
await finish(browser, { pass, label: 'Admin dashboard: the owner gives and removes look-only access from a fleet account (#4175)', errors });
