// Regression test for #2514: renderSellerFeedbackSummary (the Seller
// modal's #seller-feedback-summary/#seller-feedback-list, #1096/#2286) had
// no stale-response guard, unlike every sibling fetch-then-render function
// in this file (renderReviews, renderSales, renderMyAvatarsList, etc, each
// using the established `let xLoadToken = 0` idiom). A slow first fetch
// resolving after a faster, fresher second one could silently overwrite
// the panel with stale data. Delays the first GET
// /api/sellers/:sellerId/feedback via Playwright route interception to get
// a deterministic reordering, matching the exact repro in the issue and
// mirroring e2e/sales-panel-race.test.mjs's own established approach for
// this bug class.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, finish, emailForLabel, grantAdmin } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

const LABEL = 'Seller Feedback Race Tester';
const PRODUCT_NAME = 'Feedback Race Product';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForTimeout(300);

await page.click('#upload-model-btn');
await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });
await page.fill('#upload-name', PRODUCT_NAME);
await page.fill('#upload-price', '10');
await page.setInputFiles('#upload-file-input', CRATE_MODEL_PATH);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-step-dimensions').hidden, null, { timeout: 30000 });
await page.waitForTimeout(300);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), null, { timeout: 30000 });
await page.waitForTimeout(500);

async function fetchJson(pathAndQuery, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [pathAndQuery, options]);
}

const { templates } = (await fetchJson('/api/catalog?limit=100')).body;
const template = templates.find((t) => t.name === PRODUCT_NAME);
console.log('uploaded product found in catalog:', !!template);

const { seller } = (await fetchJson('/api/sellers/me')).body;
console.log('seller identity resolved (should be truthy):', !!seller);

const { builders } = (await fetchJson('/api/builders')).body;
const me = builders.find((b) => b.label === LABEL);
const { landlets } = (await fetchJson(`/api/landlets?status=claimed&ownerBuilderId=${me.builderId}&limit=100`)).body;
const instanceId = 'feedback-race-instance';
await fetchJson('/api/instances', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ instanceId, landletId: landlets[0].landletId, templateId: template.templateId, x: 0, y: 0 }),
});

// #653: the simulated path is now admin-only (this seller hasn't
// completed Stripe Connect onboarding) — grant it to this same
// browser-session account now, before either purchase below, so neither
// one (especially the second, mid-race) picks up an extra grant-admin
// round trip that could itself perturb the timing this test depends on.
await grantAdmin(emailForLabel(LABEL));

// First purchase/feedback: a single 5-star rating, submitted before the
// race begins -- this is the content the stale (first) fetch will see.
const purchase1 = (await fetchJson(`/api/instances/${instanceId}/purchase`, { method: 'POST' })).body.purchase;
await fetchJson(`/api/purchases/${purchase1.purchaseId}/feedback`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ rating: 5, text: 'First rating' }),
});

// Delay only the DELIVERY of the first GET /api/sellers/:sellerId/feedback
// response that fires after route interception begins -- the closed-modal
// reopen below -- so it arrives in the page *after* a second rating lands
// and a second, faster reopen fires. route.fetch() performs the real
// request immediately (capturing the true, still-1-rating state right
// now, before the second rating below exists) and hands back a real
// Response to fulfill with later -- delaying before route.continue()
// instead would delay the real request's own dispatch, not just the
// page's receipt of it, so by the time it actually reached the server the
// second rating would already exist, making both responses identical and
// this test unable to tell a guarded fix from the original bug.
let getFeedbackCount = 0;
await page.route('**/api/sellers/*/feedback', async (route) => {
  if (route.request().method() !== 'GET') {
    await route.continue();
    return;
  }
  getFeedbackCount++;
  if (getFeedbackCount === 1) {
    const response = await route.fetch();
    const body = await response.text();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.fulfill({ response, body });
    return;
  }
  await route.continue();
});

await page.click('#seller-close-btn');
await page.waitForTimeout(200);
await page.click('#seller-showcase-manage-btn'); // fires the slow GET #1 (still 1 rating, 5.0 average)
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });

// A second rating lands while GET #1 is still in flight -- averaging to 4.0
// across 2 ratings, the content the fresher GET #2 below should show.
const purchase2 = (await fetchJson(`/api/instances/${instanceId}/purchase`, { method: 'POST' })).body.purchase;
const feedback2 = await fetchJson(`/api/purchases/${purchase2.purchaseId}/feedback`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ rating: 3, text: 'Second rating' }),
});
console.log('second feedback created while GET #1 was still in flight (should be 201):', feedback2.status);

// Close and reopen again before GET #1 resolves -- fires a fresh, fast
// GET #2 that should win, showing both ratings' 4.0 average.
await page.click('#seller-close-btn');
await page.waitForTimeout(200);
await page.click('#seller-showcase-manage-btn');
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForFunction(() => !document.getElementById('seller-feedback-summary').hidden, null, { timeout: 30000 });

// GET #2 should already have landed and rendered by now (no artificial
// delay on it) -- confirm the fresher content shows before GET #1's own
// 1500ms delay has even elapsed, then wait past it and confirm nothing
// reverts.
const summaryTextRightAfterReopen = await page.locator('#seller-feedback-summary').textContent();
console.log('summary shows the fresher 2-rating/4.0 average right after the second reopen (before GET #1 could possibly resolve):', summaryTextRightAfterReopen);

await page.waitForTimeout(2000); // long enough for GET #1's delayed, stale response to land too
await page.unroute('**/api/sellers/*/feedback');

const summaryTextAfterStaleResponseLands = await page.locator('#seller-feedback-summary').textContent();
const feedbackRowCountAfterStaleResponseLands = await page.locator('#seller-feedback-list .seller-feedback-row').count();
console.log('summary text after the stale GET #1 response lands too (should still mention 4.0 average and "2 ratings", not revert to 5.0/"1 rating"):', summaryTextAfterStaleResponseLands);
console.log('rendered feedback row count after the stale response lands (should stay 2, not revert to 1):', feedbackRowCountAfterStaleResponseLands);

const pass = !!template &&
  !!seller &&
  feedback2.status === 201 &&
  summaryTextRightAfterReopen.includes('4.0') && summaryTextRightAfterReopen.includes('2 ratings') &&
  summaryTextAfterStaleResponseLands.includes('4.0') && summaryTextAfterStaleResponseLands.includes('2 ratings') &&
  feedbackRowCountAfterStaleResponseLands === 2 &&
  errors.length === 0;
await finish(browser, { pass, label: '#2514: a slow, stale seller-feedback-summary fetch does not overwrite a fresher reopen', errors });
