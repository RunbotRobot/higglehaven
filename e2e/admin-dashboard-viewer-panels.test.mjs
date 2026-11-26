// #4382: what a look-only admin's dashboard shows in every section. It lands on Users, opens each section without a
// refused request or a "Failed to load.", says "Not shown to a look-only account." where a section's reads carry tax,
// order, flag or evidence detail, and draws no enabled control that sends a change (every enabled button is pressed
// and none of them produces a write). The route lists behind it are in worker/admin-viewer.test.js.
import { ensureAdminSession, localD1, finish } from './helpers.mjs';
import { chromium } from 'playwright';

const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH || null;
const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';
const browser = await chromium.launch(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {});
const errors = [];

await ensureAdminSession(); // the dashboard's own routes need a database that has been migrated

const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const email = `e2e-viewer-panels-${stamp}@example.com`;
const signup = await fetch(`${BASE_URL}/api/auth/signup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, password: 'a fine long password', username: `e2e-viewer-panels-${stamp}`, ageAttested: true }),
});
if (signup.status !== 201) throw new Error(`signup failed (${signup.status})`);
const token = /hh_session=([^;]+)/.exec(signup.headers.get('set-cookie') || '')?.[1];
localD1(`UPDATE users SET is_admin_viewer = 1 WHERE email = '${email}'`);

const page = await browser.newPage();
const refused = [];
page.on('pageerror', (err) => errors.push(err.message));
page.on('console', (msg) => { if (msg.type() === 'error' && !msg.text().includes('Failed to load resource')) errors.push(msg.text()); });
page.on('response', (response) => {
  const url = new URL(response.url());
  if (url.pathname.startsWith('/api/') && response.status() >= 400) refused.push(`${response.status()} ${url.pathname}`);
});
await page.context().addCookies([{ name: 'hh_session', value: token, url: BASE_URL }]);
await page.goto(`${BASE_URL}/admin/dashboard`, { waitUntil: 'networkidle' });
await page.waitForSelector('.viewer-banner', { timeout: 10000 });
await page.waitForTimeout(500);

const banner = await page.textContent('.viewer-banner');
const landedOn = await page.evaluate(() => document.querySelector('nav button.nav-item.active')?.dataset.panel);

const OPEN = ['roster', 'models', 'world', 'landlets', 'tax-education', 'accounts', 'video-jobs'];
const CLOSED = ['tax', 'purchases', 'flags'];
const sections = {};
for (const name of [...OPEN, ...CLOSED, 'fixtures']) {
  await page.click(`nav button[data-panel="${name}"]`);
  await page.waitForTimeout(700);
  const text = await page.evaluate((n) => document.getElementById('panel-' + n).innerText, name);
  // Press every enabled button in the section: none may send a change.
  const pressed = await page.evaluate((n) => {
    const buttons = [...document.querySelectorAll('#panel-' + n + ' button')].filter((b) => !b.disabled && !b.hidden && !b.closest('[hidden]'));
    buttons.forEach((b) => b.click());
    return buttons.map((b) => b.id || b.className || b.textContent.trim());
  }, name);
  await page.waitForTimeout(400);
  sections[name] = { failed: /Failed to load/i.test(text), notShown: /Not shown to a look-only account/.test(text), pressed: pressed.length };
}
const blockedWrites = await page.evaluate(() => window.__viewerBlockedWrites);
// The one part of a section that is closed inside an open section.
await page.click('nav button[data-panel="models"]');
const modelsText = await page.evaluate(() => document.getElementById('panel-models').innerText);
await page.click('nav button[data-panel="accounts"]');
const accountsText = await page.evaluate(() => document.getElementById('panel-accounts').innerText);
const rosterRows = await page.evaluate(() => document.querySelectorAll('#rosterTableWrap tbody tr').length);
const rosterEmails = await page.evaluate(() => document.getElementById('rosterTableWrap').innerText);

console.log(JSON.stringify({ banner, landedOn, sections, blockedWrites, refused, rosterRows }, null, 1));
const pass = /most of what is here/.test(banner)
  && landedOn === 'accounts'
  && [...OPEN, 'fixtures'].every((n) => !sections[n].failed)
  && CLOSED.every((n) => sections[n].notShown && !sections[n].failed)
  && /Not shown to a look-only account/.test(modelsText) && /Used|used of/.test(modelsText)
  && /Not shown to a look-only account/.test(accountsText)
  && rosterRows >= 1 && !rosterEmails.includes('@example.com') === true
  && blockedWrites.length === 0
  && refused.length === 0
  && errors.length === 0;
await finish(browser, { pass, label: 'Admin dashboard: a look-only admin opens every section without a refusal and without a control that only fails (#4382)', errors });
