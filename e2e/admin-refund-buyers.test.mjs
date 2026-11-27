// #4376 (owner decision 2026-11-26, option A): approving a counterfeit flag refunds no one; the approved flag gets a
// "Refund buyers" action in the admin dashboard, confirmed in its own in-app dialog that names the count and the
// total first. worker/counterfeit-refund-buyers.test.js covers the server rules; this drives the real page: the
// approved listing appears, the dialog names the buyers, the total and the second line higglehaven would cover, Cancel leaves
// everything untouched, Confirm refunds the first-line orders, and (#4422) the second line, with its own confirmation,
// covers the paid-out order before the listing leaves the list.
import { chromium } from 'playwright';
import { ensureAdminSession, finish, localD1 } from './helpers.mjs';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';
const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH || null;
const stamp = Date.now().toString(36);
const TEMPLATE_ID = `refund-buyers-${stamp}`;
const NAME = `Refund Buyers Fake ${stamp}`;
let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

async function api(route, cookie, options = {}) {
  const response = await fetch(`${BASE_URL}/api${route}`, {
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
  });
  return { status: response.status, body: await response.json().catch(() => ({})), response };
}
async function newAccount(label) {
  const signedUp = await api('/auth/signup', null, {
    method: 'POST',
    body: JSON.stringify({ email: `${label}-${stamp}@e2e.test`, password: 'e2e-refund-buyers-pass-123', username: `${label}-${stamp}`, ageAttested: true }),
  });
  const cookie = signedUp.response.headers.get('set-cookie').match(/hh_session=([^;]+)/)[0];
  await api('/auth/confirm-card', cookie, { method: 'POST' });
  return cookie;
}

const adminCookie = await ensureAdminSession();
const sellerCookie = await newAccount('rb-seller');
const flaggerCookie = await newAccount('rb-flagger');
const seller = (await api('/sellers/me', sellerCookie)).body.seller;
const host = (await api('/builders/me', sellerCookie)).body.builder;

const created = await api('/catalog', sellerCookie, {
  method: 'POST',
  body: JSON.stringify({ templateId: TEMPLATE_ID, name: NAME, color: '#123456', dimensions: { width: 1, depth: 1, height: 1 }, priceCents: 1000, sellerId: seller.sellerId }),
});
check(created.status === 201, `the listing is created (${created.status})`);

// Three orders: two refundable ($10 and $5) and one whose seller was already paid out ($7), with no card payment, so the
// refund is the local reversal the way the worker suite's are.
const insert = (n, cents, paidOut) => `INSERT INTO purchases (purchase_id, instance_id, template_id, builder_id, unit_price_cents, quantity, total_cents, commission_cents, builder_share_cents, platform_share_cents, paid_out_at) VALUES ('${TEMPLATE_ID}-p${n}', 'rb-instance', '${TEMPLATE_ID}', '${host.builderId}', ${cents}, 1, ${cents}, 20, 10, 10, ${paidOut ? "'2026-01-01T00:00:00Z'" : 'NULL'})`;
localD1(`${insert(1, 1000, false)}; ${insert(2, 500, false)}; ${insert(3, 700, true)};`);

check((await api(`/catalog/${TEMPLATE_ID}/flags`, flaggerCookie, { method: 'POST', body: JSON.stringify({}) })).status === 201, 'the flag is raised');
const approved = await api(`/catalog/${TEMPLATE_ID}/flags/resolve`, adminCookie, { method: 'POST', body: JSON.stringify({ action: 'approve' }) });
check(approved.status === 200, `the flag is approved (${approved.status})`);
const refundedAt = () => JSON.stringify(localD1(`SELECT purchase_id, refunded_at FROM purchases WHERE template_id = '${TEMPLATE_ID}' ORDER BY purchase_id`, { json: true }));
const refundedIds = () => (localD1(`SELECT purchase_id FROM purchases WHERE template_id = '${TEMPLATE_ID}' AND refunded_at IS NOT NULL ORDER BY purchase_id`, { json: true })[0]?.results || []).map((r) => r.purchase_id);
check(refundedIds().length === 0, `approving refunded no one (${refundedAt()})`);

const browser = await chromium.launch(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {});
const errors = [];
const page = await browser.newPage();
page.on('pageerror', (err) => errors.push(err.message));
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
await page.context().addCookies([{ name: 'hh_session', value: adminCookie.split('=')[1], url: BASE_URL }]);
await page.goto(`${BASE_URL}/admin/dashboard`, { waitUntil: 'networkidle' });
await page.click('button[data-panel="flags"]');

const row = page.locator(`#refundBuyersTableWrap tr[data-template-id="${TEMPLATE_ID}"]`);
await row.waitFor({ timeout: 15000 });
check((await row.textContent()).includes(NAME), 'the approved listing is listed by name');
check((await row.locator('td').nth(3).textContent()).trim() === '3', 'the row counts the three orders it can repay (two refunds and one the platform covers)');

// Cancel leaves everything as it was.
await row.locator('.action-refund-buyers').click();
const dialog = page.locator('#refundBuyersDialog');
await dialog.waitFor({ state: 'visible', timeout: 10000 });
const text = await page.textContent('#refundBuyersBody');
console.log('dialog:', text.replace(/\s+/g, ' ').trim());
check(text.includes(NAME), 'the dialog names the product');
check(/2\s*buyers/.test(text), 'the dialog names the number of buyers (2)');
check(text.includes('$14.85') && text.includes('$15.00'), 'the dialog names the total refunded ($14.85) and paid ($15.00)');
check(/higglehaven would cover \$6\.93 for 1 buyer/.test(text), 'the dialog names the second line: what higglehaven would cover and for how many');
check((await page.textContent('#refundBuyersConfirm')).includes('$14.85'), 'the confirm button carries the amount');
await page.click('#refundBuyersCancel');
check(!(await dialog.isVisible()), 'Cancel closes the dialog');
check(refundedIds().length === 0, 'Cancel refunded no one');

// Confirm refunds the two, not the paid-out one.
await row.locator('.action-refund-buyers').click();
await dialog.waitFor({ state: 'visible', timeout: 10000 });
await page.click('#refundBuyersConfirm');
await page.waitForFunction(() => /refunded/.test(document.getElementById('refundBuyersBody')?.textContent || '') && !/Refunding…/.test(document.getElementById('refundBuyersBody').textContent), null, { timeout: 30000 });
const done = (await page.textContent('#refundBuyersBody')).replace(/\s+/g, ' ').trim();
console.log('result:', done);
check(/2 orders refunded/.test(done) && done.includes('$14.85'), 'the result says two orders and $14.85 were refunded');
check(!/could not be refunded here/.test(done), 'the paid-out order is the second line now, not an order that could not be refunded');
const ids = refundedIds();
check(ids.length === 2 && ids[0].endsWith('-p1') && ids[1].endsWith('-p2'), `only the two first-line orders are refunded by the first confirmation (${ids.join(', ')})`);
await page.click('#refundBuyersCancel'); // reads "Close" now
// The paid-out order is still to cover, so the listing stays until the second line is confirmed too.
await row.waitFor({ timeout: 10000 });
check((await row.locator('td').nth(3).textContent()).trim() === '1', 'the listing stays with the one order higglehaven would cover');

// #4422: the second line has its own confirmation; Back changes nothing, Pay covers the paid-out order.
await row.locator('.action-refund-buyers').click();
await dialog.waitFor({ state: 'visible', timeout: 10000 });
await page.click('#refundBuyersPlatformBtn');
const ask = (await page.textContent('#refundBuyersBody')).replace(/\s+/g, ' ').trim();
console.log('platform confirm:', ask);
check(ask.includes('$6.93') && /own balance/.test(ask) && /keep it/.test(ask), 'the second confirmation names the amount, the balance it comes from, and that sellers keep what they were paid');
await page.click('#refundBuyersPlatformBack');
check(refundedIds().length === 2, 'Back refunded no one');
await page.click('#refundBuyersPlatformBtn');
await page.click('#refundBuyersPlatformGo');
await page.waitForFunction(() => /1 order refunded/.test(document.getElementById('refundBuyersBody')?.textContent || ''), null, { timeout: 30000 });
check(refundedIds().length === 3, 'the paid-out order is refunded on the second line');
await page.click('#refundBuyersCancel');
await page.waitForFunction((id) => !document.querySelector(`#refundBuyersTableWrap tr[data-template-id="${id}"]`), TEMPLATE_ID, { timeout: 10000 });
check(true, 'the listing left the list');

await finish(browser, { pass: pass && errors.length === 0, label: 'admin-refund-buyers (#4376)', errors });
