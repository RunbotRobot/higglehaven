// #1646: the admin tool pages (action-log, control-room) had form inputs
// with only a `placeholder` attribute -- no <label>, aria-label, or
// aria-labelledby. Same bug shape (and same fix idiom -- a real aria-label)
// as #1324's icon-button fix and #1506's catalog/seller search-input fix
// (see e2e/search-input-accessible-names.test.mjs's own header comment for
// why placeholder text alone isn't a reliable accessible name). Neither
// admin page is reachable from launchPage/chooseIdentity, so this needs its
// own admin-session navigation, same as e2e/admin-action-log-page.test.mjs
// and e2e/control-room-admin-page.test.mjs.
import { chromium } from 'playwright';
import { ensureAdminSession, finish } from './helpers.mjs';

const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH || null;
const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';

const browser = await chromium.launch(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {});
const errors = [];
const page = await browser.newPage();
page.on('pageerror', (err) => errors.push(err.message));
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });

const sessionCookie = await ensureAdminSession(); // "hh_session=<token>"
const [, token] = sessionCookie.split('=');
await page.context().addCookies([{ name: 'hh_session', value: token, url: BASE_URL }]);

await page.goto(`${BASE_URL}/admin/action-log`, { waitUntil: 'networkidle' });
const actionLogLabels = {
  actionType: await page.getAttribute('input[name="actionType"]', 'aria-label'),
  targetType: await page.getAttribute('input[name="targetType"]', 'aria-label'),
  adminUserId: await page.getAttribute('input[name="adminUserId"]', 'aria-label'),
  targetId: await page.getAttribute('input[name="targetId"]', 'aria-label'),
};
console.log('admin-action-log.html filter input aria-labels (all should be set):', actionLogLabels);

await page.goto(`${BASE_URL}/admin/control-room`, { waitUntil: 'networkidle' });
const controlRoomLabels = {
  from: await page.getAttribute('input[name="from"]', 'aria-label'),
  kind: await page.getAttribute('select[name="kind"]', 'aria-label'),
  grantAdminEmail: await page.getAttribute('#grantAdminEmail', 'aria-label'),
  search: await page.getAttribute('#search', 'aria-label'),
};
console.log('admin-control-room.html input aria-labels (all should be set):', controlRoomLabels);

const pass = Object.values(actionLogLabels).every(Boolean) &&
  Object.values(controlRoomLabels).every(Boolean) &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: 'Admin tool pages (action-log, control-room) have real accessible names on their form inputs (#1646)',
  errors,
});
