// #3775: rating a product is one-to-one with an order, and starts from My purchases: each order
// offers "Rate this product" beside "Rate this seller", shows the rating once given, and lets
// the person change or remove it there. The endpoints are covered by the worker tests
// (worker/product-review-buyer-account.test.js), so this serves them from fixtures to pin the panel.
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, finish } from './helpers.mjs';

const LABEL = 'My purchases Product Rating Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

const base = (id, over = {}) => ({
  purchaseId: id, templateId: `template-${id}`, createdAt: '2026-03-01T12:00:00.000Z', productName: `Product ${id}`, sellerName: 'Shop A',
  quantity: 1, totalCents: 1250, isDigitalGood: false, shippedAt: null, refundedAt: null, refundedAmountCents: null,
  canLeaveFeedback: false, feedback: null, canDispute: false, canReviewProduct: false, productReview: null, ...over,
});
const state = {
  open: base('open', { createdAt: '2026-03-03T00:00:00.000Z', canReviewProduct: true }),
  rated: base('rated', { createdAt: '2026-03-02T00:00:00.000Z', productReview: { reviewId: 'review-rated', rating: 2, text: 'Wobbly' } }),
  refunded: base('refunded', { createdAt: '2026-03-01T00:00:00.000Z', refundedAt: '2026-03-02T00:00:00.000Z' }),
};
const calls = [];
const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
await page.route('**/api/purchases/mine*', (route) => json(route, 200, { purchases: Object.values(state), nextCursor: null }));
await page.route('**/api/catalog/*/reviews**', async (route) => {
  const url = new URL(route.request().url());
  const method = route.request().method();
  const parts = url.pathname.split('/');
  const templateId = decodeURIComponent(parts[3]);
  const id = templateId.replace('template-', '');
  const body = route.request().postDataJSON?.() || {};
  if (method === 'GET') return json(route, 200, { reviews: [], averageRating: null, count: 0 });
  calls.push(`${method} ${id}${body.purchaseId ? ` for ${body.purchaseId}` : ''}`);
  if (method === 'POST') {
    state[id] = { ...state[id], canReviewProduct: false, productReview: { reviewId: `review-${id}`, rating: body.rating, text: body.text || null } };
    return json(route, 201, { review: { reviewId: `review-${id}`, rating: body.rating, text: body.text || null } });
  }
  if (method === 'PATCH') {
    state[id] = { ...state[id], productReview: { ...state[id].productReview, rating: body.rating, text: body.text || null } };
    return json(route, 200, { review: { reviewId: state[id].productReview.reviewId, rating: body.rating, text: body.text || null } });
  }
  state[id] = { ...state[id], canReviewProduct: true, productReview: null };
  return json(route, 200, { deleted: true });
});

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };
const rowOf = (id) => page.locator(`#my-purchases-list .my-purchase-row[data-purchase-id="${id}"]`);

await openAccountMenu(page);
await page.click('#my-purchases-btn');
await page.waitForSelector('#my-purchases-list .my-purchase-row', { timeout: 5000 });

check((await rowOf('refunded').getByRole('button', { name: /product/i }).count()) === 0, 'a refunded order offers no product rating');
check((await rowOf('rated').getByRole('button', { name: 'Rate this product' }).count()) === 0, 'a rated order does not offer Rate this product again');
check((await rowOf('rated').locator('.my-purchase-product-rating .my-purchase-feedback-summary').innerText()).includes('"Wobbly"'), 'a rated order shows its product rating');

// Rate it: the rating is recorded against this very order.
await rowOf('open').getByRole('button', { name: 'Rate this product' }).click();
await rowOf('open').getByLabel('Product rating').selectOption('4');
await rowOf('open').getByLabel('Product comment').fill('Sturdy');
await rowOf('open').getByRole('button', { name: 'Save product rating' }).click();
await rowOf('open').locator('.my-purchase-product-rating .my-purchase-feedback-summary').waitFor({ timeout: 5000 });
check((await rowOf('open').locator('.my-purchase-product-rating .my-purchase-feedback-summary').innerText()).includes('"Sturdy"'), 'the new product rating is shown');
check((await rowOf('open').getByRole('button', { name: 'Rate this product' }).count()) === 0, 'Rate this product is gone once rated');

// Change it (prefilled), then remove it: the order offers rating again.
await rowOf('rated').getByRole('button', { name: 'Edit product rating' }).click();
check((await rowOf('rated').getByLabel('Product comment').inputValue()) === 'Wobbly', 'the edit form is prefilled');
await rowOf('rated').getByLabel('Product rating').selectOption('5');
await rowOf('rated').getByRole('button', { name: 'Save product rating' }).click();
await page.waitForFunction(() => document.querySelector('[data-purchase-id="rated"] .my-purchase-product-rating .my-purchase-feedback-summary')?.textContent.includes('★★★★★'), null, { timeout: 5000 });
await rowOf('rated').getByRole('button', { name: 'Delete product rating' }).click();
await rowOf('rated').getByRole('button', { name: 'Rate this product' }).waitFor({ timeout: 5000 });

check(calls.join(',') === 'POST open for open,PATCH rated,DELETE rated', `calls: ${calls.join(',')}`);
await finish(browser, { pass: pass && errors.length === 0, label: 'my-purchases-product-rating', errors });
