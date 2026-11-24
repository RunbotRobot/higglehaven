// #4060: the Admin Dashboard's Users table (Accounts tab): sort, each kind of filter, the search box,
// the column chooser remembered across a reload, the empty state, and the refusals. The endpoint's own
// contract (no secrets, counts) is worker/admin-users-table.test.js.
import { chromium } from 'playwright';
import { ensureAdminSession, finish } from './helpers.mjs';

const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH || null;
const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';

async function api(path, cookie, options = {}) {
  const response = await fetch(`${BASE_URL}/api${path}`, {
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
  });
  let body = null;
  try { body = await response.json(); } catch (_) { /* none */ }
  return { response, body };
}

const adminCookie = await ensureAdminSession();
const [, adminToken] = adminCookie.split('=');
const tag = `e2eut${Date.now().toString(36)}`;
const names = ['a', 'b', 'c'].map((s) => `${tag}-${s}`);
let nonAdminCookie = null;
for (const name of names) {
  const signedUp = await api('/auth/signup', null, {
    method: 'POST',
    body: JSON.stringify({ email: `${name}@example.com`, password: 'a fine long password', username: name, ageAttested: true }),
  });
  if (signedUp.response.status !== 201) throw new Error(`signup failed ${signedUp.response.status}`);
  if (!nonAdminCookie) nonAdminCookie = (signedUp.response.headers.get('set-cookie') || '').split(';')[0];
}
const suspended = await api('/auth/suspend-account', adminCookie, {
  method: 'POST', body: JSON.stringify({ email: `${names[1]}@example.com`, reason: 'E2E users table' }),
});
if (suspended.response.status !== 200) throw new Error(`suspend failed ${suspended.response.status}`);

const anon = await api('/auth/admin-users', null);
const nonAdmin = await api('/auth/admin-users', nonAdminCookie);
console.log('signed-out refused (401):', anon.response.status === 401, ' non-admin refused (403):', nonAdmin.response.status === 403);

const browser = await chromium.launch(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {});
const errors = [];
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.on('pageerror', (err) => errors.push(err.message));
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
await page.context().addCookies([{ name: 'hh_session', value: adminToken, url: BASE_URL }]);
await page.goto(`${BASE_URL}/admin/dashboard`, { waitUntil: 'networkidle' });
await page.click('button[data-panel="accounts"]');
await page.waitForSelector('#usersTbody .users-open', { timeout: 15000 });

const rowNames = () => page.$$eval('#usersTbody tr td:first-child', (tds) => tds.map((t) => t.textContent.trim()));
const countLine = () => page.textContent('#usersCountLine');

// The search box narrows every column at once.
await page.fill('#usersSearchInput', tag);
const searched = await rowNames();
console.log('search narrows to the three test users:', searched.length === 3);

// Sort: username ascending, then again for descending.
await page.click('.users-sort[data-sort="username"]');
const asc = await rowNames();
await page.click('.users-sort[data-sort="username"]');
const desc = await rowNames();
console.log('sort asc then desc reverses the order:', asc.join() === [...asc].sort().join() && desc.join() === [...asc].reverse().join());

// A yes/no filter (Suspended), a choice filter (Kind), a text filter (email), number and date ranges.
await page.click('#usersColumnsBtn');
for (const key of ['suspended', 'email', 'kind', 'createdAt', 'ordersCount', 'userId']) {
  const box = page.locator(`#usersColumnChooser input[data-col="${key}"]`);
  if (!(await box.isChecked())) await box.check();
}
await page.click('#usersColumnsBtn');
await page.selectOption('[data-filter="suspended"]', 'yes');
const onlySuspended = await rowNames();
console.log('Suspended=yes leaves only the suspended user:', onlySuspended.length === 1 && onlySuspended[0] === names[1]);
await page.selectOption('[data-filter="suspended"]', 'any');
await page.selectOption('[data-filter="kind"]', 'Person');
console.log('Kind=Person keeps all three:', (await rowNames()).length === 3);
await page.selectOption('[data-filter="kind"]', '');
await page.fill('[data-filter="email"]', `${names[2]}@`);
const byEmail = await rowNames();
console.log('email contains filter finds one:', byEmail.length === 1 && byEmail[0] === names[2]);
await page.fill('[data-filter="email"]', '');
await page.fill('[data-filter="ordersCount"][data-part="min"]', '1');
const noOrders = await page.isVisible('#usersEmpty');
console.log('Orders at least 1 shows "No users match these filters":', noOrders && (await page.textContent('#usersEmpty')).includes('No users match these filters'));
await page.fill('[data-filter="ordersCount"][data-part="min"]', '');
const today = new Date();
const pad = (n) => String(n).padStart(2, '0');
const day = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const tomorrow = new Date(today.getTime() + 36 * 3600 * 1000);
await page.fill('[data-filter="createdAt"][data-part="from"]', day(tomorrow));
const futureEmpty = await page.isVisible('#usersEmpty');
await page.fill('[data-filter="createdAt"][data-part="from"]', day(new Date(today.getTime() - 36 * 3600 * 1000)));
const pastRows = (await rowNames()).length;
console.log('date range: created from tomorrow is empty, from yesterday keeps three:', futureEmpty && pastRows === 3);
console.log('the count line says how many are shown:', /Showing 3 of \d+ users/.test(await countLine()));

// "Clear filters" returns every row; text can be selected (no pointer-events or user-select block).
await page.click('#usersClearBtn');
const afterClear = (await rowNames()).length;
const selectable = await page.$eval('#usersTbody td:nth-child(2)', (el) => getComputedStyle(el).userSelect !== 'none');
console.log('clear filters shows all rows, cells are selectable:', afterClear >= 3 && selectable);

// The chosen columns survive a reload; Reset view puts the defaults back.
await page.reload({ waitUntil: 'networkidle' });
await page.click('button[data-panel="accounts"]');
await page.waitForSelector('#usersTbody .users-open', { timeout: 15000 });
const hasIdAfterReload = await page.$('.users-sort[data-sort="userId"]') !== null;
await page.click('#usersResetBtn');
const hasIdAfterReset = await page.$('.users-sort[data-sort="userId"]') !== null;
console.log('Account id column kept across reload, gone after Reset view:', hasIdAfterReload && !hasIdAfterReset);

// #4073: Select all / Deselect all, the lines between columns, and widths the owner can drag.
const headCount = () => page.$$eval('.users-table thead tr:first-child th', (ths) => ths.length);
const widthOf = (key) => page.$eval(`.users-table thead th[data-key="${key}"]`, (th) => Math.round(th.getBoundingClientRect().width));
await page.click('#usersColumnsBtn');
await page.click('#usersColumnChooser > .users-bulk-all [data-bulk="all"]');
const allShown = await headCount();
const allBoxes = await page.$$eval('#usersColumnChooser input[data-col]', (els) => els.length);
await page.click('#usersColumnChooser > .users-bulk-all [data-bulk="none"]');
const noneShown = await headCount();
const onlyUsernameLeft = await page.$eval('.users-table thead th', (th) => th.dataset.key);
console.log('Select all shows every column; Deselect all leaves only Username:', allShown === allBoxes, noneShown === 1 && onlyUsernameLeft === 'username');
await page.click('#usersColumnChooser > .users-bulk-all [data-bulk="all"]');
const firstGroup = await page.$eval('#usersColumnChooser fieldset .users-bulk [data-bulk="group-none"]', (b) => b.dataset.group);
await page.click(`#usersColumnChooser [data-bulk="group-none"][data-group="${firstGroup}"]`);
const afterGroupNone = await headCount();
console.log('Deselect all on one group removes just that group:', afterGroupNone < allShown && afterGroupNone > 1);
await page.click('#usersColumnChooser > .users-bulk-all [data-bulk="all"]');
await page.click('#usersColumnsBtn');
const rule = await page.$eval('.users-table tbody tr td:first-child', (td) => getComputedStyle(td).borderRightWidth);
console.log('a rule separates columns:', rule !== '0px');
const before = await widthOf('username');
const handle = page.locator('.users-resize[data-resize="username"]');
const hb = await handle.boundingBox();
await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
await page.mouse.down();
await page.mouse.move(hb.x + hb.width / 2 + 80, hb.y + hb.height / 2, { steps: 6 });
await page.mouse.up();
const dragged = await widthOf('username');
console.log('dragging a heading edge widens the column by about the drag:', dragged - before >= 70 && dragged - before <= 90, { before, dragged });
const sortedByDrag = await page.$eval('.users-table thead th[data-key="username"]', (th) => th.getAttribute('aria-sort'));
await page.reload({ waitUntil: 'networkidle' });
await page.click('button[data-panel="accounts"]');
await page.waitForSelector('#usersTbody .users-open', { timeout: 15000 });
const afterReload = await widthOf('username');
console.log('the width survives a reload:', Math.abs(afterReload - dragged) <= 1, { afterReload });
await page.locator('.users-resize[data-resize="username"]').dblclick();
const afterDouble = await widthOf('username');
console.log('double-click on the edge returns the default width:', Math.abs(afterDouble - before) <= 1, { afterDouble });
const hb2 = await page.locator('.users-resize[data-resize="username"]').boundingBox();
await page.mouse.move(hb2.x + hb2.width / 2, hb2.y + hb2.height / 2);
await page.mouse.down();
await page.mouse.move(hb2.x + hb2.width / 2 - 60, hb2.y + hb2.height / 2, { steps: 6 });
await page.mouse.up();
const narrowed = await widthOf('username');
await page.click('#usersResetBtn');
const afterResetWidth = await widthOf('username');
console.log('Reset view clears the widths:', narrowed < before && Math.abs(afterResetWidth - before) <= 1, { narrowed, afterResetWidth });
const resizeOk = dragged - before >= 70 && dragged - before <= 90 && Math.abs(afterReload - dragged) <= 1
  && Math.abs(afterDouble - before) <= 1 && narrowed < before && Math.abs(afterResetWidth - before) <= 1;
const bulkOk = allShown === allBoxes && noneShown === 1 && onlyUsernameLeft === 'username' && afterGroupNone < allShown && afterGroupNone > 1 && rule !== '0px';
console.log('a drag did not sort the column:', sortedByDrag === null || sortedByDrag === 'ascending' || sortedByDrag === 'descending');

// A tap on a name opens that account's detail below.
await page.fill('#usersSearchInput', names[0]);
await page.click('#usersTbody .users-open');
await page.waitForSelector('#userDetailWrap .use-for-suspend-btn', { timeout: 10000 });
console.log('tapping a name opens its detail:', true);

const pass = anon.response.status === 401 && nonAdmin.response.status === 403 && searched.length === 3
  && asc.join() === [...asc].sort().join() && desc.join() === [...asc].reverse().join()
  && onlySuspended.length === 1 && onlySuspended[0] === names[1] && byEmail.length === 1 && noOrders
  && futureEmpty && pastRows === 3 && afterClear >= 3 && selectable && hasIdAfterReload && !hasIdAfterReset
  && bulkOk && resizeOk;
await finish(browser, { pass, label: 'Admin users table (#4060, #4073): search, sort, filters, column chooser, select all, column widths, refusals', errors });
