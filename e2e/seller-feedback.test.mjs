// Seller feedback (#1096, docs/API.md's "Seller feedback") — distinct from
// product reviews: rates a specific seller's own service (listing
// accuracy, timeliness, communication) for one specific purchase from
// them, not the product itself. Submission happens via a confirm()+two-
// prompt() flow right after #shop-buy-hint completes a purchase
// (promptSellerFeedback, src/main.js), which — like #shop-review-hint
// (see product-reviews.test.mjs's own comment) — isn't reachable without
// real in-world camera movement, so this exercises the feedback API
// directly (the same one that flow calls, createSellerFeedback in
// src/api.js) and covers the one real piece of UI this feature has: the
// Seller modal's own aggregate display (#seller-feedback-summary,
// renderSellerFeedbackSummary), fetched fresh on every modal open.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

const LABEL = 'Seller Feedback Suite Tester';
const PRODUCT_NAME = 'Suite Feedback Product';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 10000 });
await page.waitForTimeout(300);

// Summary stays hidden with no feedback yet.
const summaryHiddenBefore = await page.locator('#seller-feedback-summary').isHidden();
console.log('feedback summary hidden before any feedback exists (should be true):', summaryHiddenBefore);

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
console.log('uploaded product found in catalog:', !!template);

const { seller } = (await fetchJson('/api/sellers/me')).body;
console.log('seller identity resolved (should be truthy):', !!seller);

// Two separate purchases of the same product, same shape as
// product-reviews.test.mjs's own two-purchase setup — each purchase grants
// exactly one feedback slot (seller_feedback.purchase_id is UNIQUE), so two
// purchases are needed to exercise the averageRating/count aggregate with
// more than a single data point.
const { builders } = (await fetchJson('/api/builders')).body;
const me = builders.find((b) => b.label === LABEL);
const { landlets } = (await fetchJson(`/api/landlets?status=claimed&ownerBuilderId=${me.builderId}&limit=100`)).body;
const instanceId = 'suite-feedback-instance';
await fetchJson('/api/instances', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ instanceId, landletId: landlets[0].landletId, templateId: template.templateId, x: 0, y: 0 }),
});
const purchase1 = (await fetchJson(`/api/instances/${instanceId}/purchase`, { method: 'POST' })).body.purchase;
const purchase2 = (await fetchJson(`/api/instances/${instanceId}/purchase`, { method: 'POST' })).body.purchase;
console.log('two distinct purchase ids created:', purchase1.purchaseId !== purchase2.purchaseId);

// Leave feedback on each purchase directly via the API the confirm()/
// prompt() flow calls (createSellerFeedback in src/api.js) — 5 and 3 stars,
// averaging to 4.0.
const feedback1 = await fetchJson(`/api/purchases/${purchase1.purchaseId}/feedback`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ rating: 5, text: 'Shipped fast, exactly as described!' }),
});
const feedback2 = await fetchJson(`/api/purchases/${purchase2.purchaseId}/feedback`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ rating: 3 }),
});
console.log('feedback creation statuses (should both be 201):', feedback1.status, feedback2.status);

// A second feedback attempt on the same purchase is rejected (409, the
// purchase_id UNIQUE constraint's own atomic check-and-insert guard) —
// (full rating-bounds/eligibility validation is covered by
// worker/seller-feedback.test.js instead of here).
const duplicate = await fetchJson(`/api/purchases/${purchase1.purchaseId}/feedback`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ rating: 1 }),
});
console.log('duplicate feedback on the same purchase rejected (should be 409):', duplicate.status);

const { feedback, averageRating, count } = (await fetchJson(`/api/sellers/${seller.sellerId}/feedback`)).body;
console.log('feedback entries for this seller (should be 2):', feedback.length);
console.log('averageRating (should be 4) and count (should be 2):', averageRating, count);

// Reopen the Seller modal — renderSellerFeedbackSummary re-fetches on every
// open, so this is the real path a seller would see their updated average
// through, not a one-off render captured at modal-open-at-test-start time.
// A Sell-nav click while already in Sell mode is a no-op (currentMode ===
// target, see the mode-nav click handler's own early return) — switching
// modes is a real page reload (#540), so getting back into Sell means
// actually leaving first, same two-hop dance
// seller-upload-and-resize.test.mjs's own comment documents for this exact
// case. The seller identity itself is already active this session, so the
// identity picker doesn't reopen on the way back, just the modal once
// bootstrap() lands.
await page.click('#seller-close-btn');
await page.waitForTimeout(300);
await page.click('.mode-nav-btn[data-mode="build"]');
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
await page.waitForSelector('#add-item-btn', { timeout: 15000 });
await page.waitForTimeout(300);
await page.click('.mode-nav-btn[data-mode="sell"]');
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
await page.waitForSelector('#seller-modal.visible', { timeout: 15000 });
await page.waitForFunction(() => !document.getElementById('seller-feedback-summary').hidden, { timeout: 5000 });
const summaryText = await page.locator('#seller-feedback-summary').textContent();
console.log('feedback summary text after reopening the modal (should mention 4.0 average and "2 ratings"):', summaryText);

// The deliberate 409 above is a real, expected HTTP error response —
// Chromium logs it to the console as "Failed to load resource" independent
// of anything this app's own code does, the same expected fallout
// saved-layout-paste.test.mjs's own comment documents filtering out.
const unexpectedErrors = errors.filter((e) => !e.includes('Failed to load resource'));

const pass = !!template &&
  summaryHiddenBefore === true &&
  !!seller &&
  purchase1.purchaseId !== purchase2.purchaseId &&
  feedback1.status === 201 &&
  feedback2.status === 201 &&
  duplicate.status === 409 &&
  feedback.length === 2 &&
  averageRating === 4 &&
  count === 2 &&
  summaryText.includes('4.0') && summaryText.includes('2 ratings') &&
  unexpectedErrors.length === 0;
await finish(browser, { pass, label: 'Seller Feedback: purchase-gated creation + Seller-modal aggregate summary (#1096)', errors });
