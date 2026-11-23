// #4075: the landlet panel's "Make greenbelt" control. A lándlet that is already greenbelt shows it
// disabled with the reason beside it. (The release itself is covered by worker/land-make-greenbelt.test.js.)
import { chromium } from 'playwright';
import { createGreenbeltLandletAsAdmin, ensureAdminSession, finish } from './helpers.mjs';

const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH || null;
const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';
const browser = await chromium.launch(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {});
const errors = [];
const id = `e2e-greenbelt-${Date.now().toString(36)}`;
await createGreenbeltLandletAsAdmin(id);
const [, token] = (await ensureAdminSession()).split('=');
const page = await browser.newPage();
page.on('pageerror', (err) => errors.push(err.message));
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
await page.context().addCookies([{ name: 'hh_session', value: token, url: BASE_URL }]);
await page.goto(`${BASE_URL}/admin/dashboard`, { waitUntil: 'networkidle' });
await page.click('button[data-panel="landlets"]');
await page.fill('#landletLookupInput', id);
await page.click('#landletLookupBtn');
await page.waitForFunction((x) => document.getElementById('landletStatGrid')?.textContent.includes(x), id, { timeout: 15000 });
const disabled = await page.locator('#landletGreenbeltBtn').isDisabled();
const hint = (await page.textContent('#landletGreenbeltHint')).trim();
const modalHidden = await page.locator('#landletGreenbeltModal').isHidden();
console.log('disabled, hint, modal hidden:', disabled, hint, modalHidden);
await finish(browser, {
  pass: disabled && /already greenbelt/.test(hint) && modalHidden && errors.length === 0,
  label: 'Make greenbelt is disabled with its reason for a lándlet that is already greenbelt (#4075)',
  errors,
});
