// "Report a problem" on a My Purchases row (#3199). The dispute endpoint itself
// is covered by worker/purchase-disputes.test.js, so this test fulfils
// GET /api/purchases/mine and POST /api/purchases/:id/dispute from fixtures to
// pin the UI: the control only shows when the list says the order can be
// disputed, a two-step confirm, the row visibly becoming "Refunded" after an
// auto-resolved dispute, plain-words messages for the other outcomes (a 409
// "already paid out" and a not-auto-resolved answer), and a double click
// sending exactly one request.
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, finish } from './helpers.mjs';

const LABEL = 'My Purchases Dispute Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

const purchase = (id, over = {}) => ({
  purchaseId: id, createdAt: '2026-03-01T12:00:00.000Z', productName: `Product ${id}`, sellerName: 'Shop A',
  quantity: 1, totalCents: 1250, isDigitalGood: false, shippedAt: null, refundedAt: null, refundedAmountCents: null,
  canLeaveFeedback: false, feedback: null, canDispute: true, ...over,
});

const disputeCalls = [];
await page.route('**/api/purchases/mine*', (route) => route.fulfill({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({
    purchases: [
      purchase('auto'),
      purchase('manual'),
      purchase('paid-out'),
      purchase('double'),
      purchase('ineligible', { canDispute: false }),
    ],
    nextCursor: null,
  }),
}));
await page.route('**/api/purchases/*/dispute', async (route) => {
  const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2));
  disputeCalls.push(id);
  const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  if (id === 'auto') return json(200, { autoResolved: true, purchase: { purchaseId: id, refundedAt: '2026-03-05T00:00:00.000Z', refundedAmountCents: 1237 } });
  if (id === 'manual') return json(200, { autoResolved: false, purchase: { purchaseId: id, refundedAt: null } });
  if (id === 'paid-out') return json(409, { error: 'raw server wording' });
  await new Promise((resolve) => setTimeout(resolve, 400)); // 'double': slow enough to click twice
  return json(200, { autoResolved: true, purchase: { purchaseId: id, refundedAt: '2026-03-05T00:00:00.000Z', refundedAmountCents: 1237 } });
});

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };
const row = (id) => page.locator(`#my-purchases-list .my-purchase-row[data-purchase-id="${id}"]`);

await openAccountMenu(page);
await page.click('#my-purchases-btn');
await page.waitForSelector('#my-purchases-list .my-purchase-row', { timeout: 5000 });

// The control shows only where the list says a dispute can be raised.
check((await row('auto').locator('.my-purchase-dispute-btn').count()) === 1, 'eligible row has the control');
check((await row('ineligible').locator('.my-purchase-dispute-btn').count()) === 0, 'ineligible row has no control');

// Two-step confirm: nothing is sent until "Yes, report it"; "Never mind" backs out.
await row('auto').locator('.my-purchase-dispute-btn').click();
check(await row('auto').locator('.my-purchase-dispute-confirm-btn').isVisible(), 'confirm step shown');
await row('auto').locator('.my-purchase-dispute-cancel-btn').click();
check(disputeCalls.length === 0, 'cancelling sends nothing');
check(await row('auto').locator('.my-purchase-dispute-btn').isVisible(), 'control back after cancel');

// Auto-resolved: the row visibly becomes Refunded, says so, and loses the control.
await row('auto').locator('.my-purchase-dispute-btn').click();
await row('auto').locator('.my-purchase-dispute-confirm-btn').click();
await page.waitForFunction(() => document.querySelector('#my-purchases-list [data-purchase-id="auto"]')?.innerText.includes('Refunded'), null, { timeout: 5000 });
check((await row('auto').innerText()).includes('Your refund has been issued.'), 'refund message shown');
check((await row('auto').locator('.my-purchase-dispute-btn').count()) === 0, 'control gone after refund');

// Not auto-resolved: plain wording, order unchanged, no refund claimed.
await row('manual').locator('.my-purchase-dispute-btn').click();
await row('manual').locator('.my-purchase-dispute-confirm-btn').click();
await page.waitForFunction(() => document.querySelector('#my-purchases-list [data-purchase-id="manual"]')?.innerText.includes('contact the seller or support'), null, { timeout: 5000 });
check(!(await row('manual').innerText()).includes('Refunded'), 'not-auto-resolved order is not shown as refunded');

// Already paid out (409): contact-support message, control stays so the buyer is not stuck.
await row('paid-out').locator('.my-purchase-dispute-btn').click();
await row('paid-out').locator('.my-purchase-dispute-confirm-btn').click();
await page.waitForFunction(() => document.querySelector('#my-purchases-list [data-purchase-id="paid-out"]')?.innerText.includes('contact support'), null, { timeout: 5000 });
check(!(await row('paid-out').innerText()).includes('raw server wording'), 'raw 409 wording not shown');

// Double click on the confirm button sends exactly one request.
await row('double').locator('.my-purchase-dispute-btn').click();
const yes = row('double').locator('.my-purchase-dispute-confirm-btn');
await yes.dblclick();
await page.waitForFunction(() => document.querySelector('#my-purchases-list [data-purchase-id="double"]')?.innerText.includes('Refunded'), null, { timeout: 5000 });
check(disputeCalls.filter((id) => id === 'double').length === 1, `one request for a double click, got ${disputeCalls.filter((id) => id === 'double').length}`);

// Phone width: nothing overflows with the confirm step open.
await page.setViewportSize({ width: 360, height: 700 });
await row('paid-out').locator('.my-purchase-dispute-btn').click();
const fits = await page.evaluate(() => {
  const r = document.getElementById('my-purchases-modal-content').getBoundingClientRect();
  return r.left >= 0 && r.right <= window.innerWidth && document.documentElement.scrollWidth <= window.innerWidth;
});
check(fits, 'panel fits at phone width with the confirm step open');

// The mocked 409 makes the browser log its own "Failed to load resource" line.
const unexpectedErrors = errors.filter((message) => !/status of 409/.test(String(message)));
await finish(browser, { pass: pass && unexpectedErrors.length === 0, label: 'my-purchases-dispute', errors: unexpectedErrors });
