// #4522: a destructive admin action is confirmed in the page's own dialog, never a browser confirm() (#3278). This
// drives the shared `window.adminConfirm` on the real dashboard: it names the thing, answers false for Cancel, for
// Escape and for a click on the backdrop, answers true only for the destructive button, takes focus on Cancel, and
// never raises a native dialog.
import { chromium } from 'playwright';
import { ensureAdminSession, finish } from './helpers.mjs';

const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH || null;
const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';

const browser = await chromium.launch(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {});
const errors = [];
const sessionCookie = await ensureAdminSession();
const [, token] = sessionCookie.split('=');
const page = await browser.newPage();
page.on('pageerror', (err) => errors.push(err.message));
let nativeDialogs = 0;
page.on('dialog', (dialog) => { nativeDialogs += 1; dialog.dismiss(); });
await page.context().addCookies([{ name: 'hh_session', value: token, url: BASE_URL }]);
await page.goto(`${BASE_URL}/admin/dashboard`, { waitUntil: 'networkidle' });

const ask = () => page.evaluate(() => {
  window.__confirmAnswer = undefined;
  window.adminConfirm({ title: 'Delete the thing', message: 'Delete thing 42? It cannot be undone.', confirmLabel: 'Delete thing' })
    .then((answer) => { window.__confirmAnswer = answer; });
});
const answered = () => page.waitForFunction(() => window.__confirmAnswer !== undefined).then(() => page.evaluate(() => window.__confirmAnswer));
const dialog = page.locator('dialog.admin-confirm-dialog');

await ask();
await dialog.waitFor({ state: 'visible', timeout: 10000 });
const text = await dialog.innerText();
const focusOnCancel = await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('admin-confirm-cancel'));
const okLabel = await page.locator('.admin-confirm-ok').textContent();
console.log('dialog text:', text.replace(/\s+/g, ' ').trim(), '| focus on Cancel:', focusOnCancel, '| destructive label:', okLabel);
await page.click('.admin-confirm-cancel');
const afterCancel = await answered();
const goneAfterCancel = (await dialog.count()) === 0;

await ask();
await dialog.waitFor({ state: 'visible', timeout: 10000 });
await page.keyboard.press('Escape');
const afterEscape = await answered();

await ask();
await dialog.waitFor({ state: 'visible', timeout: 10000 });
await page.mouse.click(2, 2); // outside the dialog's box: the backdrop
const afterBackdrop = await answered();

await ask();
await dialog.waitFor({ state: 'visible', timeout: 10000 });
await page.click('.admin-confirm-ok');
const afterOk = await answered();
const goneAfterOk = (await dialog.count()) === 0;
console.log('answers (cancel, escape, backdrop, ok):', afterCancel, afterEscape, afterBackdrop, afterOk, '| native dialogs:', nativeDialogs);

const pass = text.includes('Delete the thing') && text.includes('Delete thing 42') && focusOnCancel && okLabel === 'Delete thing'
  && afterCancel === false && afterEscape === false && afterBackdrop === false && afterOk === true
  && goneAfterCancel && goneAfterOk && nativeDialogs === 0 && errors.length === 0;
await finish(browser, { pass, label: '#4522: the admin confirm is an in-app dialog that names the thing and answers true only for the destructive button', errors });
