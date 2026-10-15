// #2217: the Seller modal's "Duplicate" button (src/main.js, duplicateBtn's
// click handler) copies name/category/dimensions/color/modelUrl/price/
// stockQuantity/metadata (the #1045/#2107 fixes) but never called
// persistCatalogThumbnail(copy) the way the upload-flow (#327) and
// resize-save (#544) paths both do -- so a duplicated product's
// imageUrl/imageEmbedding stayed permanently null, making it unfindable via
// Prompt-mode similarity search. Creates a product directly via the API (same
// shortcut e2e/seller-duplicate-preserves-stock.test.mjs already uses),
// duplicates it through the real Duplicate button, then polls the API for
// the copy's imageUrl/imageEmbedding to show up (persistCatalogThumbnail is
// deliberately fire-and-forget, not awaited by its caller, so this can't
// just check immediately after the click).
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL = 'Duplicate Thumbnail Tester';
const PRODUCT_NAME = 'Duplicate Thumbnail Original';
const TEMPLATE_ID = `duplicate-thumb-${Date.now()}`;

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForTimeout(300);

async function fetchJson(pathAndQuery, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [pathAndQuery, options]);
}

const { seller } = (await fetchJson('/api/sellers/me')).body;

const created = await fetchJson('/api/catalog', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    templateId: TEMPLATE_ID,
    name: PRODUCT_NAME,
    color: '#2277ff',
    dimensions: { width: 1, depth: 1, height: 1 },
    priceCents: 500,
    sellerId: seller.sellerId,
  }),
});
console.log('product created directly via the API (status should be 201):', created.status);

// Reload so the Seller modal's own activeCatalog (fetched once at mode-entry,
// not live-subscribed) picks up the product just created via a raw API call
// rather than the real upload wizard. Same reasoning as the #2107 regression
// test's own comment.
await page.reload({ waitUntil: 'networkidle' });
await page.click('.mode-nav-btn[data-mode="sell"]');
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForTimeout(300);

const { templates: templatesBefore } = (await fetchJson('/api/catalog?limit=100')).body;
const original = templatesBefore.find((t) => t.name === PRODUCT_NAME);
console.log('original product has no stored thumbnail yet (should be true, created via raw API):', !original?.imageUrl);

const row = page.locator('.seller-row').filter({ hasText: PRODUCT_NAME });
await row.locator('.seller-row-toggle').click();
await page.waitForTimeout(300);
await row.locator('.seller-row-action-btn', { hasText: 'Duplicate' }).click();
await page.waitForTimeout(500);

// persistCatalogThumbnail is deliberately fire-and-forget (render the GLTF
// model to a canvas, then upload) -- poll instead of asserting right after
// the click.
let copy;
for (let attempt = 0; attempt < 20; attempt++) {
  const { templates } = (await fetchJson('/api/catalog?limit=100')).body;
  copy = templates.find((t) => t.name === `${PRODUCT_NAME} (copy)`);
  if (copy?.imageUrl) break;
  await page.waitForTimeout(500);
}
console.log('duplicate exists (should be true):', Boolean(copy));
console.log('duplicate got a persisted thumbnail (should be true, was the #2217 bug -- used to stay null forever):', Boolean(copy?.imageUrl));
console.log('duplicate got a persisted embedding (should be true):', Boolean(copy?.imageEmbedding));

const pass =
  created.status === 201 &&
  !original?.imageUrl &&
  Boolean(copy) &&
  Boolean(copy?.imageUrl) &&
  Boolean(copy?.imageEmbedding) &&
  errors.length === 0;
await finish(browser, { pass, label: 'Duplicate button persists a thumbnail/embedding for the copy (#2217)', errors });
