// Product reviews (docs/SPEC.md §5's "Review incentives," docs/API.md's
// "Product reviews") — tied to the catalog template (the product itself),
// not to any one placed instance of it, and with no builder opt-in flag at
// all (every template is reviewable by definition). Moderation therefore
// lives in the Seller modal's own per-product row (a collapsed "Reviews"
// panel, same idiom as that row's existing Extensibility panel), not in
// Build mode. Reviews are gated on a real purchase under the same name
// first (standard marketplace practice) — this test "buys" the product via
// the API before posting each review, same as a real reviewer would need
// to. Posting a review is exercised directly via the API here (the
// in-world Shop-mode "Rate this Product" hint isn't reachable without real
// camera movement — see docs/API.md's own testing note for this feature);
// this test covers the Seller modal's display/moderation of reviews and
// the backend contract those routes rely on.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

const LABEL = 'Product Reviews Suite Tester';
const PRODUCT_NAME = 'Suite Reviewable Product';

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
console.log('uploaded product found in catalog:', !!template);

// A review requires a real purchase under the same name first (standard
// marketplace practice — see worker/index.js's own comment on the reviews
// POST handler) — place an instance of the product on the already-claimed
// landlet, then "buy" it once per reviewer via the same API the in-world
// "Simulate Purchase" hint calls, before posting each review.
const { builders } = (await fetchJson('/api/builders')).body;
const me = builders.find((b) => b.label === LABEL);
const { landlets } = (await fetchJson(`/api/landlets?status=claimed&ownerBuilderId=${me.builderId}&limit=100`)).body;
const instanceId = 'suite-reviewable-instance';
await fetchJson('/api/instances', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ instanceId, landletId: landlets[0].landletId, templateId: template.templateId, x: 0, y: 0 }),
});
for (const buyerLabel of ['A Shopper', 'Another Shopper']) {
  await fetchJson(`/api/instances/${instanceId}/purchase`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ buyerLabel }),
  });
}

// Reviews attach to the product with no opt-in needed — post directly via
// the API the in-world "Rate this Product" hint calls (createProductReview
// in src/api.js).
await fetchJson(`/api/catalog/${template.templateId}/reviews`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ authorLabel: 'A Shopper', rating: 5, text: 'Lovely product!' }),
});
await fetchJson(`/api/catalog/${template.templateId}/reviews`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ authorLabel: 'Another Shopper', rating: 3 }),
});
const { reviews, averageRating, count } = (await fetchJson(`/api/catalog/${template.templateId}/reviews`)).body;
console.log('reviews on the product (should be 2, oldest first):', reviews.map((r) => `${r.authorLabel}: ${r.rating}★${r.text ? ` (${r.text})` : ''}`));
console.log('averageRating (should be 4) and count (should be 2):', averageRating, count);

// Expand the product's own row and open its "Reviews" panel — the seller's
// moderation view.
const row = () => page.locator('.seller-row').filter({ hasText: PRODUCT_NAME });
await row().locator('.seller-row-toggle').click();
await page.waitForTimeout(300);
const reviewToggleBefore = await row().locator('.seller-review-toggle').textContent();
console.log('Reviews toggle label before opening (should read "Reviews ▾"):', reviewToggleBefore);
await row().locator('.seller-review-toggle').click();
await page.waitForTimeout(500);

const rowCountInPanel = await row().locator('.product-review-row').count();
const firstRowText = await row().locator('.product-review-row').first().textContent();
const summaryText = await row().locator('.seller-review-summary').textContent();
console.log('rows shown in the panel (should be 2):', rowCountInPanel);
console.log('first row mentions author+rating+text (should mention "A Shopper", stars, and "Lovely product"):', firstRowText);
console.log('summary text (should mention the 4.0 average and "2 reviews"):', summaryText);

// Delete the second review via its row's own × button (not the API
// directly) — this is the actual moderation path a seller would use.
await row().locator('.product-review-row').filter({ hasText: 'Another Shopper' }).locator('.product-review-row-delete').click();
await page.waitForFunction(() => document.querySelectorAll('.product-review-row').length === 1, { timeout: 5000 });
const rowCountAfterDelete = await row().locator('.product-review-row').count();
console.log('rows shown after deleting one via the panel (should be 1):', rowCountAfterDelete);

const afterDelete = (await fetchJson(`/api/catalog/${template.templateId}/reviews`)).body;
console.log('reviews persisted server-side after the panel delete (should be 1, the surviving one authored by "A Shopper"):', afterDelete.reviews.map((r) => r.authorLabel));

// (Rating-bounds validation, the optional text field, average computation,
// and cascade-on-template-delete are covered by worker/index.test.js's own
// "Product reviews" describe block instead of here.)

const pass = !!template &&
  reviewToggleBefore.trim() === 'Reviews ▾' &&
  reviews.length === 2 &&
  reviews[0].text === 'Lovely product!' &&
  averageRating === 4 &&
  count === 2 &&
  rowCountInPanel === 2 &&
  firstRowText.includes('A Shopper') && firstRowText.includes('Lovely product') &&
  summaryText.includes('4.0') && summaryText.includes('2 reviews') &&
  rowCountAfterDelete === 1 &&
  afterDelete.reviews.length === 1 && afterDelete.reviews[0].authorLabel === 'A Shopper' &&
  errors.length === 0;
await finish(browser, { pass, label: 'Product Reviews: Seller-modal moderation panel + reviews API', errors });
