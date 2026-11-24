// #4135: a selected user in the admin dashboard shows their lándlets: "Lándlets (1)" with the lándlet's name, id,
// place and published version; "Open" on the row goes to the Landlet overrides panel with that lándlet loaded
// (no new actions here); a person holding none is told so plainly. (A builder can claim only one lándlet, so the
// several-lándlets list is covered in worker/account-moderation.test.js.)
import {
  launchPage, chooseIdentity, ensureAdminSession, finish,
  createGreenbeltLandletAsAdmin,
} from './helpers.mjs';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';
const suffix = Date.now().toString(36);
const ONE = `e2e-user-landlets-${suffix}`;
await createGreenbeltLandletAsAdmin(ONE);

const person = await launchPage({ promptAnswer: 'User Landlets Person' });
const browser = person.browser;
await chooseIdentity(person.page, { mode: 'build', label: 'User Landlets Person', isNew: true });
const identity = await person.page.evaluate(async () => {
  const me = await (await fetch('/api/auth/me')).json();
  const builder = await (await fetch('/api/builders/me')).json();
  return { userId: me.user.userId, builderId: builder.builder.builderId };
});
const claim = await person.page.evaluate((landletId) => fetch('/api/landlets/' + landletId + '/claim', { method: 'POST' }).then((r) => r.status), ONE);
console.log('claim (should be 200):', claim);

const sessionCookie = await ensureAdminSession();
const [, token] = sessionCookie.split('=');
const errors = [];
const page = await browser.newPage();
page.on('pageerror', (err) => errors.push(err.message));
page.on('console', (msg) => { if (msg.type() === 'error' && !/status of 40[34]/.test(msg.text())) errors.push(msg.text()); });
await page.context().addCookies([{ name: 'hh_session', value: token, url: BASE_URL }]);
await page.goto(`${BASE_URL}/admin/dashboard`, { waitUntil: 'networkidle' });
await page.click('button[data-panel="accounts"]');
await page.waitForFunction(() => typeof window.__adminLoadUserDetail === 'function');

// 1. The person with one.
await page.evaluate((id) => window.__adminLoadUserDetail(id), identity.userId);
await page.waitForSelector('#userLandletsHeading', { timeout: 10000 });
const heading = await page.textContent('#userLandletsHeading');
const rowText = await page.locator('.user-landlets tbody tr').allTextContents();
const hasListed = rowText.some((t) => t.includes(ONE));
console.log('heading (should say 1):', heading, '| rows:', rowText.length, '| listed (should be true):', hasListed);

// 2. Open a row: the Landlet overrides panel shows that lándlet.
await page.locator(`.open-landlet-btn[data-landlet-id="${ONE}"]`).click();
await page.waitForFunction((id) => document.querySelector('#landletStatGrid')?.textContent.includes(id), ONE, { timeout: 10000 });
const panelActive = await page.locator('#panel-landlets.active').count();
console.log('the lándlets panel is showing and has loaded the chosen one (should be 1):', panelActive);

// 3. A person with none (this admin account has a builder profile and no lándlets).
const adminUserId = await page.evaluate(async () => (await (await fetch('/api/auth/me')).json()).user.userId);
await page.click('button[data-panel="accounts"]');
await page.evaluate((id) => window.__adminLoadUserDetail(id), adminUserId);
await page.waitForFunction(() => /Lándlets \(0\)/.test(document.getElementById('userLandletsHeading')?.textContent || ''), null, { timeout: 10000 });
const none = await page.textContent('.user-landlets tbody');
console.log('a person with none is told so (should say no lándlets):', none.trim());

const pass = claim === 200 && /\(1\)/.test(heading) && rowText.length === 1 && hasListed
  && panelActive === 1 && /no lándlets/.test(none) && errors.length === 0;
await finish(browser, { pass, label: "#4135: a selected user's lándlets are listed, each one opens in the lándlet panel, and a person with none is told so", errors });
