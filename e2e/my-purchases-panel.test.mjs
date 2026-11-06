// "My Purchases" panel (#3197): the account-menu list of the buyer's own
// receipts. The endpoint itself is covered by worker/purchases-mine.test.js,
// so this test fulfils GET /api/purchases/mine from fixtures to pin the
// panel's behaviour: newest-first rows, plain status wording, the empty
// state, "Load more", Escape restoring focus, a response arriving after the
// panel was closed being discarded, and the phone-width layout.
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, finish } from './helpers.mjs';

const LABEL = 'My Purchases Panel Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

const purchase = (id, over = {}) => ({
  purchaseId: id, createdAt: '2026-03-01T12:00:00.000Z', productName: `Product ${id}`, sellerName: 'Shop A',
  quantity: 1, totalCents: 1250, isDigitalGood: false, shippedAt: null, refundedAt: null, refundedAmountCents: null,
  canLeaveFeedback: false, feedback: null, canDispute: false, ...over,
});

let mode = 'two';
let releaseLate = null;
await page.route('**/api/purchases/mine*', async (route) => {
  const url = new URL(route.request().url());
  const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  if (mode === 'empty') return json({ purchases: [], nextCursor: null });
  if (mode === 'late') {
    await new Promise((resolve) => { releaseLate = resolve; });
    return json({ purchases: [purchase('late-one')], nextCursor: null });
  }
  if (url.searchParams.get('cursor') === 'c2') return json({ purchases: [purchase('older', { createdAt: '2026-01-01T00:00:00.000Z' })], nextCursor: null });
  return json({
    purchases: [
      purchase('newer', { shippedAt: '2026-03-02T00:00:00.000Z' }),
      purchase('digital', { isDigitalGood: true, createdAt: '2026-02-01T00:00:00.000Z' }),
      purchase('refunded', { refundedAt: '2026-02-02T00:00:00.000Z', createdAt: '2026-01-15T00:00:00.000Z' }),
    ],
    nextCursor: 'c2',
  });
});

const open = async () => {
  await openAccountMenu(page);
  await page.click('#my-purchases-btn');
  await page.waitForSelector('#my-purchases-modal.visible', { timeout: 5000 });
};

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

// Populated list, status wording, Load more.
await open();
await page.waitForSelector('#my-purchases-list .my-purchase-row', { timeout: 5000 });
let texts = await page.locator('#my-purchases-list .my-purchase-row').allInnerTexts();
check(texts.length === 3, `3 rows, got ${texts.length}`);
check(texts[0].startsWith('Product newer') && texts[0].includes('Shipped') && texts[0].includes('$12.50') && texts[0].includes('Shop A'), `row 0: ${texts[0]}`);
check(texts[1].includes('Digital: ready'), `row 1: ${texts[1]}`);
check(texts[2].includes('Refunded'), `row 2: ${texts[2]}`);
check(await page.locator('#my-purchases-empty').isHidden(), 'empty state hidden when rows exist');
await page.click('#my-purchases-load-more-btn');
await page.waitForFunction(() => document.querySelectorAll('#my-purchases-list .my-purchase-row').length === 4, null, { timeout: 5000 });
check(await page.locator('#my-purchases-load-more-btn').isHidden(), 'Load more hidden after last page');

// Phone width: modal fits the viewport with no horizontal overflow.
const fits = await page.evaluate(() => {
  const r = document.getElementById('my-purchases-modal-content').getBoundingClientRect();
  return r.left >= 0 && r.right <= window.innerWidth && document.documentElement.scrollWidth <= window.innerWidth;
});
check(fits, 'panel fits at phone width');

// Escape closes and restores focus to the account menu button.
await page.keyboard.press('Escape');
await page.waitForSelector('#my-purchases-modal:not(.visible)', { state: 'attached', timeout: 5000 });
check(await page.evaluate(() => document.activeElement && document.activeElement.id !== 'my-purchases-modal'), 'focus left the closed modal');

// Empty state.
mode = 'empty';
await open();
await page.waitForSelector('#my-purchases-empty:not([hidden])', { timeout: 5000 });
check((await page.locator('#my-purchases-empty').innerText()) === "You haven't bought anything yet.", 'empty copy');
await page.click('#my-purchases-close-btn');

// A response that lands after the panel was closed is discarded.
mode = 'late';
await open();
await page.waitForFunction(() => true);
await page.waitForTimeout(300);
await page.click('#my-purchases-close-btn');
mode = 'two';
releaseLate?.();
await page.waitForTimeout(500);
check((await page.locator('#my-purchases-list .my-purchase-row').count()) === 0, 'late response not painted after close');

await finish(browser, { pass: pass && errors.length === 0, label: 'my-purchases-panel', errors });
