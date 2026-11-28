// #4651 (Disputes 3/3, part of #4648): the admin dashboard's Disputes panel lists Stripe disputes on orders, open
// ones first, with the due date, the reason, the evidence state and the purchase id; with none it says "No disputes.";
// a failed load says so and keeps the page working. The route is answered here with a fixed body (the server's ordering
// and its admin-only rule are tested in worker/stripe-dispute-record.test.js).
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
page.on('console', (msg) => { if (msg.type() === 'error' && !msg.text().includes('Failed to load resource')) errors.push(msg.text()); });
await page.context().addCookies([{ name: 'hh_session', value: token, url: BASE_URL }]);

let answer = { kind: 'rows' };
await page.route('**/api/auth/admin-purchase-disputes', async (route) => {
  if (answer.kind === 'fail') {
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'The disputes could not be read.' }) });
    return;
  }
  const disputes = answer.kind === 'none' ? [] : [
    { disputeId: 'dp_a', purchaseId: 'purchase-aaa', productName: 'Garden <b>Gnome</b>', sellerName: 'Gnome Works', reason: 'product_not_received', amountCents: 2400, status: 'needs_response', evidenceDueBy: '2099-12-03T12:00:00.000Z', outcome: 'open', evidenceSent: false, evidenceError: 'Stripe did not answer', openedAt: '2026-11-28T00:00:00Z', shipped: true, hasTracking: false, isDigitalGood: false },
    { disputeId: 'dp_b', purchaseId: 'purchase-bbb', productName: 'Old Bench', sellerName: 'Bench Co', reason: 'fraudulent', amountCents: 5000, status: 'won', evidenceDueBy: '2026-11-01T12:00:00.000Z', outcome: 'won', evidenceSent: true, evidenceError: null, openedAt: '2026-10-20T00:00:00Z', shipped: true, hasTracking: true, isDigitalGood: false },
  ];
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ disputes, totalCount: disputes.length, limit: 200 }) });
});

await page.goto(`${BASE_URL}/admin/dashboard`, { waitUntil: 'networkidle' });
await page.click('button[data-panel="disputes"]');
await page.waitForSelector('#disputesTableWrap tr[data-dispute-id="dp_a"]', { timeout: 10000 });
const status = await page.textContent('#disputesStatusLine');
const rows = await page.locator('#disputesTableWrap tbody tr').count();
const first = await page.locator('#disputesTableWrap tbody tr').first().innerText();
const injected = await page.locator('#disputesTableWrap b').count();
console.log('status:', status, '; rows (should be 2):', rows, '; first row:', first.replace(/\s+/g, ' '), '; injected tags (should be 0):', injected);

answer = { kind: 'none' };
await page.click('#disputesRefreshBtn');
await page.waitForFunction(() => document.getElementById('disputesStatusLine').textContent === 'No disputes.', null, { timeout: 8000 });
const emptied = await page.locator('#disputesTableWrap tbody tr').count();

answer = { kind: 'fail' };
await page.click('#disputesRefreshBtn');
await page.waitForFunction(() => !document.getElementById('disputesErrLine').hidden, null, { timeout: 8000 });
const failure = await page.textContent('#disputesErrLine');
console.log('after none, rows (should be 0):', emptied, '; failure line:', failure);

const pass = /^1 open · 2 shown/.test(status) && rows === 2 && /Garden <b>Gnome<\/b>/.test(first) && /Gnome Works/.test(first)
  && /product_not_received/.test(first) && /\$24\.00/.test(first) && /Not sent: Stripe did not answer/.test(first) && /purchase-aaa/.test(first)
  && injected === 0 && emptied === 0 && failure === 'The disputes could not be read.' && errors.length === 0;
await finish(browser, { pass, label: '#4651: the admin Disputes panel lists disputes, says when there are none and when it failed', errors });
