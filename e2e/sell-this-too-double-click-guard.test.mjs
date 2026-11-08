// #2795: attachListingTo (src/sell/mode.js)'s alreadyMine guard reads
// activeCatalog, which only gets the newly-created listing pushed into it
// *after* createCatalogListing's await resolves -- so a second click on
// the same "Sell This Too" tile while the first request is still in flight
// used to run its own alreadyMine check against the same stale array,
// never showing the "Add another one anyway?" confirmation and silently
// creating two listings for the same product. Fixed with a module-level
// in-flight guard that makes the second submit return immediately. (Since
// #3249 the price/stock questions are a form in the modal, not native
// prompts, and "you already have one" is a note on that form.)
//
// Same two-seller setup as e2e/sell-this-too.test.mjs (seller A's product
// created directly via the API, seller B does the attaching) -- this test
// is purely about the double-click race, not re-covering the happy path
// already covered there.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const SELLER_A = 'Double Click Guard Seller A';
const SELLER_B = 'Double Click Guard Seller B';
const PRODUCT_NAME = 'Double Click Guard Lamp';

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
    color: '#88ccee',
    dimensions: { width: 0.2, depth: 0.2, height: 0.5 },
    priceCents: 1000,
    sellerId: sellerA.sellerId,
  }),
});
const originalTemplateId = created.body.template.templateId;
const productId = created.body.template.productId;

await chooseIdentity(sellerBSession.page, { mode: 'sell', label: SELLER_B, isNew: true });
await sellerBSession.page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await sellerBSession.page.waitForTimeout(300);

// Delay only the create-listing POST -- a reliable window to double-click
// the same tile before the first request's response (and its
// activeCatalog.push) lands, same idiom as seller-size-save-preview-race's
// own PATCH delay.
await sellerBSession.page.route('**/api/catalog/listings', async (route) => {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  await route.continue();
});

// #3249: price and stock are a form in the modal now (no native dialogs).
// Refuse any native dialog that does appear, and count them.
const dialogMessages = [];
sellerBSession.page.removeAllListeners('dialog');
sellerBSession.page.on('dialog', (dialog) => {
  dialogMessages.push(dialog.message());
  return dialog.dismiss();
});

await sellerBSession.page.click('#sell-this-too-btn');
await sellerBSession.page.waitForSelector('#sell-this-too-modal.visible', { timeout: 10000 });

const productCard = sellerBSession.page.locator('#sell-this-too-grid .seller-card').filter({ hasText: PRODUCT_NAME });
await productCard.click();
await sellerBSession.page.waitForSelector('#sell-this-too-form:not([hidden])', { timeout: 5000 });
await sellerBSession.page.fill('#sell-this-too-price-input', '19.99');
await sellerBSession.page.fill('#sell-this-too-stock-input', '3');
// Press Enter in the price field (a form submit) and click the button again
// while the first request is still in flight: the race.
await sellerBSession.page.click('#sell-this-too-add-btn');
await sellerBSession.page.waitForTimeout(150);
await sellerBSession.page.press('#sell-this-too-price-input', 'Enter');
await sellerBSession.page.click('#sell-this-too-add-btn', { force: true });

// A successful attach closes #sell-this-too-modal -- wait for that (the
// first call's eventual resolution), not a fixed delay.
await sellerBSession.page.waitForSelector('#seller-modal.visible', { timeout: 10000 });
await sellerBSession.page.waitForFunction(
  () => document.querySelectorAll('.seller-row').length > 0,
  null,
  { timeout: 10000 },
);
console.log('native dialogs shown (should be 0):', dialogMessages.length);

const { templates } = (await fetchJson(sellerBSession.page, '/api/catalog?limit=100')).body;
const sellerBListings = templates.filter((t) => t.productId === productId && t.templateId !== originalTemplateId);
console.log('listings created by the double-click (should be exactly 1, not 2):', sellerBListings.length);

// With the listing now in place, picking the same product again warns that
// this makes a second one (what the old "Add another one anyway?" confirm did).
await sellerBSession.page.click('#sell-this-too-btn');
await sellerBSession.page.waitForSelector('#sell-this-too-modal.visible', { timeout: 10000 });
await sellerBSession.page.locator('#sell-this-too-grid .seller-card').filter({ hasText: PRODUCT_NAME }).click();
await sellerBSession.page.waitForSelector('#sell-this-too-form:not([hidden])', { timeout: 5000 });
const duplicateNoteShown = await sellerBSession.page.locator('#sell-this-too-form-note').isVisible();
const duplicateButtonText = (await sellerBSession.page.textContent('#sell-this-too-add-btn')).trim();
console.log('picking the product again shows the duplicate note (should be true):', duplicateNoteShown);
console.log('and the button says Add another listing (should be true):', duplicateButtonText === 'Add another listing');

const errors = [...sellerASession.errors, ...sellerBSession.errors];
const pass =
  duplicateNoteShown &&
  duplicateButtonText === 'Add another listing' &&
  dialogMessages.length === 0 &&
  sellerBListings.length === 1 &&
  errors.length === 0;

await finish(sellerBSession.browser, {
  pass,
  label: '#2795: double-clicking a "Sell This Too" tile while the first attach is in flight creates only one listing',
  errors,
});
await sellerASession.browser.close();
