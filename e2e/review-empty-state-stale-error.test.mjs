// Regression test for #1128: the Seller modal's Reviews panel (and its
// four siblings — Sales, sign-posts, community-calendar, notifications —
// which share the exact same code shape) reused one persistent "empty
// state" element across every render, only ever writing an error message
// into it on a failed fetch and never resetting it back to the friendly
// default on a later successful one. A transient fetch failure therefore
// left that element permanently stuck on stale error text, even once a
// subsequent load genuinely succeeded with zero rows.
//
// Reproduces the exact sequence from the issue: the first GET
// /api/catalog/:templateId/reviews is forced to fail (Playwright route
// abort), so the panel shows a real error in its empty-state element;
// then that same route is allowed through normally, and a fresh
// open/close of the panel fires a second GET that succeeds with zero
// reviews. Before the #1128 fix, the panel kept showing the first
// request's failure text instead of "No reviews yet."
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

const LABEL = 'Review Empty State Tester';
const PRODUCT_NAME = 'Empty State Product';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 10000 });
await page.waitForTimeout(300);
await page.click('#upload-model-btn');
await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });
await page.fill('#upload-name', PRODUCT_NAME);
await page.fill('#upload-price', '10');
await page.setInputFiles('#upload-file-input', CRATE_MODEL_PATH);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-step-dimensions').hidden, { timeout: 20000 });
await page.waitForTimeout(300);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), { timeout: 10000 });
await page.waitForTimeout(500);

async function fetchJson(pathAndQuery, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [pathAndQuery, options]);
}

const { templates } = (await fetchJson('/api/catalog?limit=100')).body;
const template = templates.find((t) => t.name === PRODUCT_NAME);
console.log('uploaded product found in catalog (no reviews posted on it):', !!template);

// Snapshot `errors` before deliberately forcing a network failure below —
// the browser itself logs a console error for the aborted request
// (Chromium's own "Failed to load resource: net::ERR_FAILED", not
// anything this app's code produces), same as e2e/land-auctions.test.mjs's
// own bid-history-fetch-failure case. Checking against this snapshot
// instead of the live `errors` array means that expected, deliberately-
// triggered console error doesn't fail an otherwise-passing run.
const errorsBeforeFailureSimulation = [...errors];

// Force only the first GET to this product's reviews endpoint to fail —
// every later one goes through untouched.
let getReviewsCount = 0;
await page.route(`**/api/catalog/${template.templateId}/reviews`, async (route) => {
  if (route.request().method() === 'GET') {
    getReviewsCount++;
    if (getReviewsCount === 1) {
      await route.abort('failed');
      return;
    }
  }
  await route.continue();
});

const row = () => page.locator('.seller-row').filter({ hasText: PRODUCT_NAME });
await row().locator('.seller-row-toggle').click();
await page.waitForTimeout(300);
await row().locator('.seller-review-toggle').click(); // fires the failing GET #1
await page.waitForTimeout(500);

const emptyTextAfterFailure = await row().locator('.seller-review-empty').textContent();
const emptyVisibleAfterFailure = await row().locator('.seller-review-empty').isVisible();
console.log('empty-state text right after the forced failure (should be an error, not the friendly default):', emptyTextAfterFailure);
console.log('empty-state visible after the failure (should be true):', emptyVisibleAfterFailure);

// Close and reopen — fires a fresh GET #2, which the route above now lets
// through normally, resolving with zero reviews (none were ever posted).
await row().locator('.seller-review-toggle').click();
await page.waitForTimeout(200);
await row().locator('.seller-review-toggle').click();
await page.waitForTimeout(500);

const emptyTextAfterSuccess = await row().locator('.seller-review-empty').textContent();
const emptyVisibleAfterSuccess = await row().locator('.seller-review-empty').isVisible();
console.log('GET requests to the reviews endpoint (should be 2):', getReviewsCount);
console.log('empty-state text after the later successful, zero-review load (should be exactly "No reviews yet."):', emptyTextAfterSuccess);
console.log('empty-state visible after the success (should be true):', emptyVisibleAfterSuccess);

const pass = !!template &&
  getReviewsCount === 2 &&
  emptyVisibleAfterFailure &&
  emptyTextAfterFailure !== 'No reviews yet.' &&
  emptyVisibleAfterSuccess &&
  emptyTextAfterSuccess === 'No reviews yet.' &&
  errorsBeforeFailureSimulation.length === 0;
await finish(browser, { pass, label: '#1128: Reviews panel empty-state resets off a stale error once a later load succeeds', errors });
