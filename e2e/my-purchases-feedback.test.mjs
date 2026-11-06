// "My Purchases" feedback controls (#3198). The feedback endpoints themselves
// are covered by the worker tests (worker/purchases-mine.test.js and the
// feedback suites), so this fulfils them from fixtures to pin the panel:
// leave, edit and delete from a row, no control on an ineligible row, and a
// 409 showing the refetched value rather than the stale one.
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, finish } from './helpers.mjs';

const LABEL = 'My Purchases Feedback Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

const base = (id, over = {}) => ({
  purchaseId: id, createdAt: '2026-03-01T12:00:00.000Z', productName: `Product ${id}`, sellerName: 'Shop A',
  quantity: 1, totalCents: 1250, isDigitalGood: false, shippedAt: null, refundedAt: null, refundedAmountCents: null,
  canLeaveFeedback: false, feedback: null, canDispute: false, ...over,
});

// Server-side state the mocks serve from.
const state = {
  open: base('open', { createdAt: '2026-03-03T00:00:00.000Z', canLeaveFeedback: true }),
  rated: base('rated', { createdAt: '2026-03-02T00:00:00.000Z', feedback: { rating: 2, text: 'Slow' } }),
  refunded: base('refunded', { createdAt: '2026-03-01T00:00:00.000Z', refundedAt: '2026-03-02T00:00:00.000Z' }),
};
let failNextEditWith409 = false;
const calls = [];

const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
await page.route('**/api/purchases/mine*', (route) => json(route, 200, { purchases: Object.values(state), nextCursor: null }));
await page.route('**/api/purchases/*/feedback', async (route) => {
  const id = new URL(route.request().url()).pathname.split('/').at(-2);
  const method = route.request().method();
  const body = route.request().postDataJSON?.() || {};
  calls.push(`${method} ${id}`);
  if (method === 'POST') {
    state[id] = { ...state[id], canLeaveFeedback: false, feedback: { rating: body.rating, text: body.text || null } };
    return json(route, 201, { feedback: { rating: body.rating, text: body.text || null } });
  }
  if (method === 'PATCH') {
    if (failNextEditWith409) {
      failNextEditWith409 = false;
      // Someone/something else changed it: the server now holds a different value.
      state[id] = { ...state[id], feedback: { rating: 1, text: 'Changed elsewhere' } };
      return json(route, 409, { error: 'Feedback changed concurrently — refetch and retry' });
    }
    state[id] = { ...state[id], feedback: { rating: body.rating, text: body.text || null } };
    return json(route, 200, { feedback: { rating: body.rating, text: body.text || null } });
  }
  state[id] = { ...state[id], canLeaveFeedback: true, feedback: null };
  return json(route, 200, { deleted: true });
});

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };
const rowOf = (id) => page.locator(`#my-purchases-list .my-purchase-row[data-purchase-id="${id}"]`);

await openAccountMenu(page);
await page.click('#my-purchases-btn');
await page.waitForSelector('#my-purchases-list .my-purchase-row', { timeout: 5000 });

// No control at all on a refunded row.
check((await rowOf('refunded').locator('.my-purchase-action').count()) === 0, 'refunded row has no feedback control');

// Leave feedback.
await rowOf('open').getByRole('button', { name: 'Rate this seller' }).click();
await rowOf('open').getByLabel('Rating').selectOption('4');
await rowOf('open').getByLabel('Comment').fill('Great');
await rowOf('open').getByRole('button', { name: 'Save feedback' }).click();
await rowOf('open').locator('.my-purchase-feedback-summary').waitFor({ timeout: 5000 });
check((await rowOf('open').locator('.my-purchase-feedback-summary').innerText()).includes('"Great"'), 'summary shows the new comment');
check((await rowOf('open').getByRole('button', { name: 'Rate this seller' }).count()) === 0, 'rate button gone after leaving feedback');

// Edit it, prefilled from the row.
await rowOf('rated').getByRole('button', { name: 'Edit feedback' }).click();
check((await rowOf('rated').getByLabel('Comment').inputValue()) === 'Slow', 'edit form prefilled');
await rowOf('rated').getByLabel('Rating').selectOption('5');
await rowOf('rated').getByRole('button', { name: 'Save feedback' }).click();
await page.waitForFunction(() => document.querySelector('[data-purchase-id="rated"] .my-purchase-feedback-summary')?.textContent.includes('★★★★★'), null, { timeout: 5000 });

// 409: the panel reloads and shows the server's value, not the stale one.
failNextEditWith409 = true;
await rowOf('rated').getByRole('button', { name: 'Edit feedback' }).click();
await rowOf('rated').getByLabel('Rating').selectOption('3');
await rowOf('rated').getByRole('button', { name: 'Save feedback' }).click();
await page.waitForFunction(() => document.querySelector('[data-purchase-id="rated"] .my-purchase-feedback-summary')?.textContent.includes('Changed elsewhere'), null, { timeout: 5000 });

// Delete: the row offers rating again (server's call after the reload).
await rowOf('rated').getByRole('button', { name: 'Delete feedback' }).click();
await rowOf('rated').getByRole('button', { name: 'Rate this seller' }).waitFor({ timeout: 5000 });
check(calls.join(',') === 'POST open,PATCH rated,PATCH rated,DELETE rated', `calls: ${calls.join(',')}`);

// The browser logs the deliberate 409 above as a console error; nothing else is expected.
const unexpectedErrors = errors.filter((e) => !e.includes('status of 409'));
await finish(browser, { pass: pass && unexpectedErrors.length === 0, label: 'my-purchases-feedback', errors: unexpectedErrors });
