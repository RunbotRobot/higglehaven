// #2107: the Seller modal's "Duplicate" button (src/main.js, duplicateBtn's
// click handler) copies category/subcategory/price/etc. (the #1045 fix) but
// never stockQuantity, added later by #1948/#1951. Duplicating a one-of-a-kind
// (stockQuantity: 1) product silently produced an unlimited-stock copy, with
// nothing in the UI calling out the reset. Creates a finite-stock product
// directly via the API (same shortcut e2e/low-stock-highlight.test.mjs/
// sold-out-markers.test.mjs already use, since there's no seller-facing
// "set stock" UI control to drive instead), reloads so the Seller modal's
// own activeCatalog picks it up, then duplicates it through the real
// Duplicate button and checks the resulting copy's stockQuantity via the API
// -- same "confirm via the API, not just the client" approach #1045's own
// regression test uses.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL = 'Duplicate Stock Tester';
const PRODUCT_NAME = 'Duplicate Stock One-Of-A-Kind';
const TEMPLATE_ID = `duplicate-stock-${Date.now()}`;

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
    color: '#ff8800',
    dimensions: { width: 1, depth: 1, height: 1 },
    priceCents: 500,
    stockQuantity: 1,
    sellerId: seller.sellerId,
  }),
});
console.log('one-of-a-kind product created directly via the API (status should be 201):', created.status);

// Reload so the Seller modal's own activeCatalog (fetched once at mode-entry,
// not live-subscribed) picks up the product just created via a raw API call
// rather than the real upload wizard. A plain reload re-runs bootstrap() with
// no sessionStorage start-mode set, which defaults back to Shop mode (same
// reasoning e2e/multiplayer-presence.test.mjs's own comment gives) -- so
// Sell mode needs re-entering via the nav button afterward, same as
// chooseIdentity's own first entry, rather than the modal reopening on its
// own.
await page.reload({ waitUntil: 'networkidle' });
await page.click('.mode-nav-btn[data-mode="sell"]');
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForTimeout(300);

const { templates: templatesBefore } = (await fetchJson('/api/catalog?limit=100')).body;
const original = templatesBefore.find((t) => t.name === PRODUCT_NAME);
console.log('original product has stockQuantity 1 (should be true):', original?.stockQuantity === 1);

const row = page.locator('.seller-row').filter({ hasText: PRODUCT_NAME });
await row.locator('.seller-row-toggle').click();
await page.waitForTimeout(300);
await row.locator('.seller-row-action-btn', { hasText: 'Duplicate' }).click();
await page.waitForTimeout(500);

const { templates: templatesAfter } = (await fetchJson('/api/catalog?limit=100')).body;
const copy = templatesAfter.find((t) => t.name === `${PRODUCT_NAME} (copy)`);
console.log('duplicate exists (should be true):', Boolean(copy));
console.log('duplicate kept stockQuantity 1 (should be true, was the #2107 bug -- used to come back null/unlimited):', copy?.stockQuantity === 1);
console.log('duplicate stockQuantity value:', copy?.stockQuantity);

const pass =
  created.status === 201 &&
  original?.stockQuantity === 1 &&
  Boolean(copy) &&
  copy?.stockQuantity === 1 &&
  errors.length === 0;
await finish(browser, { pass, label: 'Duplicate button preserves stockQuantity (#2107)', errors });
