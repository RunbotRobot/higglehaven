// #4407 (part 2): the admin dashboard's Rename on a user. The route is covered by worker/admin-rename-account.test.js;
// this is what that suite cannot see: the real page's button and in-app dialog (old and new name shown before
// anything changes, a space refused on the spot, a refusal from the server shown in the dialog) and that the page
// shows the new name afterwards.
import { ensureAdminSession, finish } from './helpers.mjs';
import { chromium } from 'playwright';

const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH || null;
const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';
const browser = await chromium.launch(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {});
const errors = [];

async function api(path, options = {}) {
  const response = await fetch(`${BASE_URL}/api${path}`, {
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers },
  });
  let body = null;
  try { body = await response.json(); } catch (_) { /* no body */ }
  return { response, body };
}

const adminCookie = await ensureAdminSession();
const [, adminToken] = adminCookie.split('=');

// A local server still accepts a name with a space at sign-up, which is how an account like the owner's is made here.
const stamp = Date.now();
const spaced = `Rename Target ${stamp}`;
const signedUp = await api('/auth/signup', {
  method: 'POST',
  body: JSON.stringify({ email: `e2e-rename-${stamp}@example.com`, password: 'a fine long password', username: spaced, ageAttested: true }),
});
if (signedUp.response.status !== 201) throw new Error(`sign-up of the fixture failed (${signedUp.response.status}): ${JSON.stringify(signedUp.body)}`);

const page = await browser.newPage();
page.on('pageerror', (err) => errors.push(err.message));
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
await page.context().addCookies([{ name: 'hh_session', value: adminToken, url: BASE_URL }]);
await page.goto(`${BASE_URL}/admin/dashboard`, { waitUntil: 'networkidle' });
await page.click('button[data-panel="accounts"]');
await page.waitForSelector('.users-open', { timeout: 15000 });
await page.locator('.users-open', { hasText: spaced }).first().click();
await page.waitForSelector('.rename-account-btn', { timeout: 15000 });
await page.click('.rename-account-btn');
await page.waitForSelector('#renameAccountDialog[open]');

const prefilled = await page.inputValue('#renameAccountInput');
const confirmEnabledAtFirst = await page.locator('#renameAccountConfirm').isEnabled();
const previewFirst = await page.textContent('#renameAccountPreview');
console.log('Prefilled with the name without spaces:', prefilled, '| Rename enabled:', confirmEnabledAtFirst, '| preview:', previewFirst);

await page.fill('#renameAccountInput', 'has space');
const spaceMessage = await page.textContent('#renameAccountPreview');
const confirmEnabledWithSpace = await page.locator('#renameAccountConfirm').isEnabled();
console.log('With a space typed (message, enabled):', spaceMessage, confirmEnabledWithSpace);

// A name the server refuses shows its reason in the dialog and changes nothing.
await page.fill('#renameAccountInput', 'higglehaven17');
await page.click('#renameAccountConfirm');
await page.waitForSelector('#renameAccountErr:not([hidden])', { timeout: 8000 });
const refusal = await page.textContent('#renameAccountErr');
console.log('Server refusal shown in the dialog:', refusal);

const newName = `RenameTarget${stamp}`;
await page.fill('#renameAccountInput', newName);
await page.click('#renameAccountConfirm');
await page.waitForSelector('#renameAccountDialog:not([open])', { state: 'attached', timeout: 8000 });
await page.waitForFunction((name) => document.getElementById('userDetailWrap').textContent.includes(name), newName, { timeout: 8000 });
const detail = await page.textContent('#userDetailWrap');
console.log('User detail now shows the new name:', detail.includes(newName));

const pass = prefilled === `RenameTarget${stamp}`
  && confirmEnabledAtFirst
  && previewFirst.includes(spaced) && previewFirst.includes(newName)
  && /can't have spaces/.test(spaceMessage) && !confirmEnabledWithSpace
  && /taken/i.test(refusal)
  && detail.includes(newName) && !detail.includes(spaced)
  && errors.filter((message) => !/409/.test(message)).length === 0; // the refused rename logs one failed request
await finish(browser, { pass, label: 'Admin rename account shows old and new, refuses a space, and renames (#4407)', errors });
