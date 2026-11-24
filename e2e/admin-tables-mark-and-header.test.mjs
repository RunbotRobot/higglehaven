// #4134: in the admin dashboard a tapped table row stays marked while the table is scrolled sideways or down, and the
// header rows stay in view. Checked on the Users table at phone width and at 1280 px.
import { chromium } from 'playwright';
import { ensureAdminSession, finish } from './helpers.mjs';

const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH || null;
const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';

const adminCookie = await ensureAdminSession();
const [, adminToken] = adminCookie.split('=');
const tag = `e2etm${Date.now().toString(36)}`;
for (let i = 0; i < 14; i += 1) {
  const name = `${tag}-${String(i).padStart(2, '0')}`;
  const response = await fetch(`${BASE_URL}/api/auth/signup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `${name}@example.com`, password: 'a fine long password', username: name, ageAttested: true }),
  });
  if (response.status !== 201) throw new Error(`signup failed ${response.status}`);
}

const browser = await chromium.launch(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {});
const errors = [];
const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); };

for (const [label, viewport] of [['phone 390', { width: 390, height: 520 }], ['desktop 1280', { width: 1280, height: 520 }]]) {
  const page = await browser.newPage({ viewport });
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('response', (r) => { if (r.status() === 404 && !/favicon\.ico$/.test(r.url())) errors.push(`404: ${r.url()}`); });
  // The browser's own request for /favicon.ico on a page that names none shows up as a console 404; it is not ours.
  page.on('console', (msg) => { if (msg.type() === 'error' && !/status of 404/.test(msg.text())) errors.push(msg.text()); });
  await page.context().addCookies([{ name: 'hh_session', value: adminToken, url: BASE_URL }]);
  await page.goto(`${BASE_URL}/admin/dashboard`, { waitUntil: 'networkidle' });
  await page.click('button[data-panel="accounts"]');
  await page.waitForSelector('#usersTbody .users-open', { timeout: 15000 });
  await page.fill('#usersSearchInput', tag);
  await page.waitForFunction((n) => document.querySelectorAll('#usersTbody tr').length >= n, 14, { timeout: 15000 });

  const target = page.locator('#usersTbody tr').nth(6);
  const targetName = (await target.locator('td').first().innerText()).trim();
  await target.locator('td').nth(1).click(); // a cell that is not the username link
  const marked = () => page.evaluate((name) => {
    const rows = [...document.querySelectorAll('#usersTbody tr')];
    const row = rows.find((r) => r.cells[0].textContent.trim() === name);
    const cells = row ? [...row.cells] : [];
    return {
      count: document.querySelectorAll('#usersTbody tr.row-marked').length,
      marked: !!row && row.classList.contains('row-marked'),
      tint: cells.length ? [...new Set(cells.map((c) => getComputedStyle(c).backgroundColor))] : [],
    };
  }, targetName);
  const first = await marked();
  check(first.marked && first.count === 1, `${label}: the tapped row is marked, and only it`);
  check(first.tint.length === 1, `${label}: one tint across every cell of the row, the held first column too (${first.tint.join(' | ')})`);

  // Scroll sideways and down inside the table's box.
  await page.evaluate(() => { const w = document.getElementById('usersTableWrap'); w.scrollLeft = w.scrollWidth; w.scrollTop = w.scrollHeight; });
  await page.waitForTimeout(300);
  const after = await marked();
  check(after.marked && after.count === 1, `${label}: still marked after scrolling both ways`);
  const geometry = await page.evaluate(() => {
    const w = document.getElementById('usersTableWrap');
    const box = w.getBoundingClientRect();
    const head = document.querySelector('.users-table thead tr:first-child th');
    const filter = document.querySelector('.users-table .users-filter-row th');
    const h = head.getBoundingClientRect();
    const f = filter.getBoundingClientRect();
    return {
      scrolledDown: w.scrollTop > 0, scrolledSideways: w.scrollLeft > 0,
      headerAtTop: Math.abs(h.top - box.top) <= 1,
      filterUnderHeader: Math.abs(f.top - h.bottom) <= 1,
      firstColumnHeld: Math.abs(head.getBoundingClientRect().left - box.left) <= 1,
    };
  });
  check(geometry.scrolledDown, `${label}: the table really scrolled down`);
  check(geometry.headerAtTop && geometry.filterUnderHeader, `${label}: the heading and filter rows stay at the top`);
  if (label.startsWith('desktop')) check(true, `${label}: sideways scroll ${geometry.scrolledSideways ? 'happened' : 'was not needed at this width'}`);
  else check(geometry.scrolledSideways && geometry.firstColumnHeld, `${label}: scrolled sideways, the first column stays in place`);

  // Tapping it again unmarks; tapping another moves the mark; the mark survives a redraw (a sort).
  await page.evaluate(() => { const w = document.getElementById('usersTableWrap'); w.scrollLeft = 0; w.scrollTop = 0; });
  await page.locator('#usersTbody tr').nth(6).locator('td').nth(1).click();
  check((await marked()).count === 0, `${label}: tapping the marked row again clears the mark`);
  await page.locator('#usersTbody tr').nth(2).locator('td').nth(1).click();
  await page.locator('#usersTbody tr').nth(3).locator('td').nth(1).click();
  const moved = await page.evaluate(() => [...document.querySelectorAll('#usersTbody tr')].map((r, i) => (r.classList.contains('row-marked') ? i : -1)).filter((i) => i >= 0));
  check(moved.length === 1 && moved[0] === 3, `${label}: tapping another row moves the mark`);
  const keptName = await page.locator('#usersTbody tr').nth(3).locator('td').first().innerText();
  await page.click('.users-sort[data-sort="username"]');
  await page.click('.users-sort[data-sort="username"]');
  await page.waitForTimeout(300);
  const stillMarked = await page.evaluate((name) => {
    const row = [...document.querySelectorAll('#usersTbody tr')].find((r) => r.cells[0].textContent.trim() === name.trim());
    return !!row && row.classList.contains('row-marked');
  }, keptName);
  check(stillMarked, `${label}: the mark stays on the same row after the table is sorted`);
  if (process.env.E2E_SHOT_DIR) await page.screenshot({ path: `${process.env.E2E_SHOT_DIR}/admin-tables-${label.split(' ')[0]}.png` });
  await page.close();
}

await finish(browser, {
  pass: failures.length === 0 && errors.length === 0,
  label: 'Admin tables: a tapped row stays marked, the header rows stay in view (#4134)',
  errors,
});
