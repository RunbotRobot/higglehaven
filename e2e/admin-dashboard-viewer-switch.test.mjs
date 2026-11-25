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

// The dashboard page's own favicon request is a 404 here, the same one admin-dashboard-accounts-panel filters.
errors.splice(0, errors.length, ...errors.filter((e) => !e.includes('Failed to load resource')));

const flag = (out) => out[0].results[0].is_admin_viewer;
const pass = offeredToPerson === 0
  && /Give look-only access/.test(labelBefore) && /Remove look-only access/.test(labelAfter)
  && /open the admin dashboard/.test(dialogText) && /cannot change anything/.test(dialogText)
  && flag(granted) === 1 && loggedGrant[0].results[0].n === 1 && flag(removed) === 0
  && errors.length === 0;
await finish(browser, { pass, label: 'Admin dashboard: the owner gives and removes look-only access from a fleet account (#4175)', errors });
