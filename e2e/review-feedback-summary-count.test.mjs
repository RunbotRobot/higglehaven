// #1235: GET /api/catalog/:id/reviews and GET /api/sellers/:id/feedback
// both already return the product/seller's real, all-time `count` field
// (worker/index.js), distinct from the windowed (LIMIT 200) `reviews`/
// `feedback` array itself -- but renderReviews()/renderSellerFeedbackSummary
// (src/main.js) built their summary text from the array's own .length
// instead, so once either passed 200 rows the displayed count would
// silently freeze at 200 forever even though the average stayed correct.
// Mocking the GET response directly proves the frontend now prefers the
// real `count` over `.length`, without needing 200+ real rows (which
// would also be impractical here -- review/feedback creation has its own
// rate limits unrelated to this bug, same reasoning
// e2e/saved-layouts-load-more.test.mjs's own comment gives for mocking
// its own analogous pagination gap).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

const LABEL = 'Review Feedback Count Tester';
const PRODUCT_NAME = 'Count Mismatch Product';
const FAKE_REVIEW_COUNT = 47;
const FAKE_FEEDBACK_COUNT = 83;

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

await page.route('**/api/catalog/*/reviews*', async (route) => {
  if (route.request().method() !== 'GET') {
    await route.continue();
    return;
  }
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      reviews: [
        { reviewId: 'fake-review-1', authorLabel: LABEL, rating: 5, text: 'Great', createdAt: new Date().toISOString() },
        { reviewId: 'fake-review-2', authorLabel: LABEL, rating: 3, text: null, createdAt: new Date().toISOString() },
      ],
      averageRating: 4,
      count: FAKE_REVIEW_COUNT,
    }),
  });
});

await page.route('**/api/sellers/*/feedback*', async (route) => {
  if (route.request().method() !== 'GET') {
    await route.continue();
    return;
  }
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      feedback: [
        { feedbackId: 'fake-feedback-1', authorLabel: LABEL, rating: 5, text: 'Nice', createdAt: new Date().toISOString() },
      ],
      averageRating: 5,
      count: FAKE_FEEDBACK_COUNT,
    }),
  });
});

// Entering Sell mode reloads the page (#540) -- page.route() handlers
// registered above are attached to the Page itself, so they survive that
// reload and apply to the GET this entry path fires (renderSellerFeedback
// Summary, called from the real sell-mode-entry path per #1214's own
// comment in src/main.js).
await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 10000 });
await page.waitForTimeout(300);

await page.waitForFunction(() => !document.getElementById('seller-feedback-summary').hidden, { timeout: 5000 });
const feedbackSummaryText = await page.locator('#seller-feedback-summary').textContent();
console.log(`seller feedback summary (should mention the real count ${FAKE_FEEDBACK_COUNT}, not the mocked array length 1):`, feedbackSummaryText);

// Upload a product so there's a seller row to open the Reviews panel on.
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

const row = () => page.locator('.seller-row').filter({ hasText: PRODUCT_NAME });
await row().locator('.seller-row-toggle').click();
await page.waitForTimeout(300);
await row().locator('.seller-review-toggle').click();
await page.waitForFunction(
  () => document.querySelectorAll('.product-review-row').length === 2,
  { timeout: 5000 },
);
const reviewSummaryText = await row().locator('.seller-review-summary').textContent();
console.log(`product review summary (should mention the real count ${FAKE_REVIEW_COUNT}, not the mocked array length 2):`, reviewSummaryText);

const pass =
  feedbackSummaryText.includes(String(FAKE_FEEDBACK_COUNT)) &&
  !feedbackSummaryText.includes('1 rating') &&
  reviewSummaryText.includes(String(FAKE_REVIEW_COUNT)) &&
  !reviewSummaryText.includes('2 review') &&
  errors.length === 0;
await finish(browser, { pass, label: "Review/seller-feedback summary text uses the API's real count, not the windowed array length (#1235)", errors });
