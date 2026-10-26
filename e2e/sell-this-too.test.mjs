// #2748 (leaf of #2745's shared-products redesign): the Seller modal's
// "Sell This Too" button (src/sell/mode.js) -- lets a seller browse every
// product in the catalog via its own dedicated #sell-this-too-modal grid
// and attach their own listing (price/stock) to a product a *different*
// seller originally uploaded, via POST /api/catalog/listings (#2747),
// without going through the model-upload flow at all. Also exercises worker/lib/
// catalog.js's own #2748 fix: the ordinary single-item POST /api/catalog
// path now backs every new template with a 1:1 `products` row at creation
// time (same convention migrations/0153's historical backfill used), so a
// product created going forward -- not just a pre-existing, backfilled
// one -- is actually "Sell This Too"-able by a second seller.
//
// Two separate real accounts, each its own launchPage() session (same
// shape e2e/auction-list-bid-race.test.mjs uses for its own multi-seller
// scenario) -- a single page/cookie jar can't hold two logged-in accounts
// at once. Seller A's product is created directly via the API (the same
// shortcut e2e/seller-duplicate-preserves-stock.test.mjs uses) rather than
// through the real upload wizard -- this test is about the cross-seller
// attach flow, not re-covering the upload wizard itself (already covered
// by e2e/seller-upload-and-resize.test.mjs and friends).
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const SELLER_A = 'Sell This Too Seller A';
const SELLER_B = 'Sell This Too Seller B';
const PRODUCT_NAME = 'Shared Reading Lamp';

const sellerASession = await launchPage({ promptAnswer: SELLER_A });
const sellerBSession = await launchPage({ promptAnswer: SELLER_B });

async function fetchJson(page, pathAndQuery, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [pathAndQuery, options]);
}

await chooseIdentity(sellerASession.page, { mode: 'sell', label: SELLER_A, isNew: true });
await sellerASession.page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await sellerASession.page.waitForTimeout(300);

const { seller: sellerA } = (await fetchJson(sellerASession.page, '/api/sellers/me')).body;

const created = await fetchJson(sellerASession.page, '/api/catalog', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    name: PRODUCT_NAME,
    color: '#ffcc66',
    dimensions: { width: 0.2, depth: 0.2, height: 0.5 },
    priceCents: 1500,
    sellerId: sellerA.sellerId,
  }),
});
console.log('seller A\'s product created directly via the API (status should be 201):', created.status);
console.log('#2748 fix: a brand-new template is backed by its own product_id right away (should be truthy):', !!created.body.template?.productId);

const originalTemplateId = created.body.template.templateId;
const productId = created.body.template.productId;

await chooseIdentity(sellerBSession.page, { mode: 'sell', label: SELLER_B, isNew: true });
await sellerBSession.page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await sellerBSession.page.waitForTimeout(300);

const sellThisTooBtnVisible = await sellerBSession.page.locator('#sell-this-too-btn').isVisible();
console.log('"Sell This Too" button visible in the Seller modal (should be true):', sellThisTooBtnVisible);

// Replace launchPage's own single-answer dialog handler (it would accept
// every prompt with the label text, which isn't a valid price) -- this
// flow shows exactly two prompts in strict sequence: price, then stock.
const dialogMessages = [];
let dialogCount = 0;
sellerBSession.page.removeAllListeners('dialog');
sellerBSession.page.on('dialog', (dialog) => {
  dialogMessages.push(dialog.message());
  dialogCount += 1;
  if (dialogCount === 1) return dialog.accept('24.99');
  if (dialogCount === 2) return dialog.accept('5');
  return dialog.accept();
});

await sellerBSession.page.click('#sell-this-too-btn');
await sellerBSession.page.waitForSelector('#sell-this-too-modal.visible', { timeout: 10000 });
await sellerBSession.page.locator('#sell-this-too-grid .seller-card').filter({ hasText: PRODUCT_NAME }).click();

// A successful attach closes #sell-this-too-modal and re-arms the Seller
// modal's own focus trap (closeSellThisTooModal, src/sell/mode.js) --
// same stacked-modal shape as the Upload modal's own closeUploadModal.
await sellerBSession.page.waitForSelector('#seller-modal.visible', { timeout: 10000 });
await sellerBSession.page.waitForFunction(
  () => document.querySelectorAll('.seller-row').length > 0,
  null,
  { timeout: 10000 },
);
console.log('dialogs shown (should be exactly 2 -- price, stock):', dialogMessages.length);

const { templates } = (await fetchJson(sellerBSession.page, '/api/catalog?limit=100')).body;
const sellerBListing = templates.find((t) => t.name === PRODUCT_NAME && t.templateId !== originalTemplateId);
const sellerAListingStillThere = templates.find((t) => t.templateId === originalTemplateId);

console.log('a second, distinct listing was created (should be truthy):', Boolean(sellerBListing));
console.log('the new listing is attached to the same shared product (should be true):', sellerBListing?.productId === productId);
console.log('the new listing carries the price entered in the prompt (should be 2499):', sellerBListing?.priceCents);
console.log('the new listing carries the stock entered in the prompt (should be 5):', sellerBListing?.stockQuantity);
console.log('the new listing is owned by seller B, not seller A (should be true):', sellerBListing?.sellerId !== sellerA.sellerId);
console.log('every shared field was copied from the product, not re-entered (color should still be #ffcc66):', sellerBListing?.color);
console.log('seller A\'s original listing is untouched (should still exist, unchanged price 1500):', sellerAListingStillThere?.priceCents === 1500);

const sellerBRow = sellerBSession.page.locator('.seller-row').filter({ hasText: PRODUCT_NAME });
const sellerBRowVisible = await sellerBRow.isVisible();
console.log('the new listing shows up in seller B\'s own Manage view right away (should be true):', sellerBRowVisible);

const errors = [...sellerASession.errors, ...sellerBSession.errors];
const pass =
  created.status === 201 &&
  !!productId &&
  dialogMessages.length === 2 &&
  Boolean(sellerBListing) &&
  sellerBListing?.productId === productId &&
  sellerBListing?.priceCents === 2499 &&
  sellerBListing?.stockQuantity === 5 &&
  sellerBListing?.sellerId !== sellerA.sellerId &&
  sellerBListing?.color === '#ffcc66' &&
  sellerAListingStillThere?.priceCents === 1500 &&
  sellerBRowVisible &&
  errors.length === 0;

await finish(sellerBSession.browser, {
  pass,
  label: '#2748: "Sell This Too" attaches a second seller\'s own listing to a product a different seller uploaded',
  errors,
});
await sellerASession.browser.close();
