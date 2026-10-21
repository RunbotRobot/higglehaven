// Regression/coverage test for #1231: the real-money-only post-purchase
// shipping flow (Mark Shipped button + ?confirmDelivery= link, docs/API.md's
// "Mark purchase shipped"/"Purchase delivery confirmation") had zero e2e
// coverage — every existing e2e purchase goes through the simulated
// higgles-currency endpoint, which never sets paymentIntentId, so nothing in
// the suite ever reached the ship button or the confirm-delivery link in the
// first place. Driving an actual Stripe checkout isn't an option either
// (STRIPE_SECRET_KEY is never configured in this suite). simulatePaidPurchaseForTests
// asks the simulated purchase endpoint's own dev-only test seam (docs/API.md's
// "E2E_SIMULATE_PAID_PURCHASES test seam") to mint a synthetic paymentIntentId,
// exercising the exact same writePurchaseRow() real-money branch a real
// Stripe-finalized purchase would, with no Stripe call anywhere in the path.
//
// The invalid/expired-token rejection path isn't covered here, same reason
// the no-returns rejection path isn't in e2e/purchase-refunds.test.mjs: a
// real 400 trips this file's own errors.length === 0 check. That path (plus
// every other rejection case for both endpoints) is already covered by
// worker/commerce.test.js's own mark-shipped/confirm-delivery tests.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, finish, emailForLabel, grantAdmin } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

const LABEL = 'Purchase Shipping Suite Tester';
const PRODUCT_NAME = 'Suite Shippable Product';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

// launchPage already registers its own page.on('dialog', ...) that accepts
// every dialog — this second listener alongside it just also records the
// alert() message each confirm-delivery visit shows, same technique as
// e2e/land-auctions.test.mjs's own lastAlertMessage capture.
const dialogMessages = [];
page.on('dialog', (dialog) => { dialogMessages.push(dialog.message()); });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForTimeout(300);
await page.click('#upload-model-btn');
await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });
await page.fill('#upload-name', PRODUCT_NAME);
await page.fill('#upload-price', '40');
await page.setInputFiles('#upload-file-input', CRATE_MODEL_PATH);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-step-dimensions').hidden, null, { timeout: 30000 });
await page.waitForTimeout(300);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), null, { timeout: 20000 });
await page.waitForTimeout(500);

async function fetchJson(pathAndQuery, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [pathAndQuery, options]);
}

const { templates } = (await fetchJson('/api/catalog?limit=100')).body;
const template = templates.find((t) => t.name === PRODUCT_NAME);
console.log('uploaded, priced product found in catalog:', !!template);

const { builder } = (await fetchJson('/api/builders/me')).body;
const { landlets } = (await fetchJson(`/api/landlets?status=claimed&ownerBuilderId=${builder.builderId}&limit=100`)).body;
const landlet = landlets[0];

const instanceId = 'suite-shippable-instance';
await fetchJson('/api/instances', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ instanceId, landletId: landlet.landletId, templateId: template.templateId, x: 0, y: 0 }),
});

// #653: the simulated path is now admin-only (this seller hasn't
// completed Stripe Connect onboarding) — grant it to this same
// browser-session account rather than switching to a separate one, so
// this purchase still lands against the product/landlet this test
// already built up under this session's own cookie.
await grantAdmin(emailForLabel(LABEL));

const purchased = await fetchJson(`/api/instances/${instanceId}/purchase`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ buyerLabel: 'A Shipping Shopper', simulatePaidPurchaseForTests: true }),
});
console.log('purchase created (status should be 201):', purchased.status);
console.log('purchase has a paymentIntentId (should be true):', !!purchased.body.purchase?.paymentIntentId);
const deliveryConfirmUrl = purchased.body.deliveryConfirmUrl;
console.log('response included a deliveryConfirmUrl (should be true):', !!deliveryConfirmUrl);

// Open the product's row and its Sales panel — same selectors
// e2e/purchase-refunds.test.mjs already drives for the sibling Refund button.
const row = () => page.locator('.seller-row').filter({ hasText: PRODUCT_NAME });
await row().locator('.seller-row-toggle').click();
await page.waitForTimeout(300);
await row().locator('.seller-sales-toggle').click();
await page.waitForTimeout(500);

const shipBtnCountBefore = await row().locator('.product-sale-row-ship-btn').count();
console.log('Mark shipped button present for this real-money, non-digital, unrefunded purchase (should be 1):', shipBtnCountBefore);

await row().locator('.product-sale-row-ship-btn').click();
await page.waitForFunction(
  () => Array.from(document.querySelectorAll('.product-sale-row-shipping')).some((el) => el.textContent.includes('Shipped')),
  null,
  { timeout: 20000 },
);
const shippingTextAfterShip = await row().locator('.product-sale-row-shipping').first().textContent();
console.log('shipping status text after marking shipped (should mention "Shipped"):', shippingTextAfterShip);
const shipBtnCountAfter = await row().locator('.product-sale-row-ship-btn').count();
console.log('Mark shipped button remaining (should be 0 — nothing left to ship again):', shipBtnCountAfter);

// Buyer side: the ?confirmDelivery= link needs no account at all (#454) —
// visit it as a plain page load, the same way a real emailed link would be
// opened (e2e/auth.test.mjs's own verifyEmail/resetPassword link visits use
// the identical page.goto(url) idiom for this reason).
await page.goto(deliveryConfirmUrl);
await page.waitForTimeout(500);
console.log('alert after a valid, first confirm-delivery visit (should mention "Delivery confirmed"):', dialogMessages[dialogMessages.length - 1]);

// Re-visiting the exact same link again is idempotent, not an error
// (docs/API.md's "Purchase delivery confirmation", #1361) — still a
// success alert, so this doesn't trip errors.length === 0 either.
await page.goto(deliveryConfirmUrl);
await page.waitForTimeout(500);
console.log('alert after re-visiting the same link a second time (should still mention "Delivery confirmed", not an error):', dialogMessages[dialogMessages.length - 1]);

// Each page.goto(deliveryConfirmUrl) above was a real navigation (same
// origin, stripped query string) — the seller modal is long closed by now,
// same as any other fresh page load. Re-enter it the normal way instead of
// assuming prior UI state survived.
await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: false });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForTimeout(300);
await row().locator('.seller-row-toggle').click();
await page.waitForTimeout(300);
await row().locator('.seller-sales-toggle').click();
await page.waitForTimeout(500);
const shippingTextAfterConfirm = await row().locator('.product-sale-row-shipping').first().textContent();
console.log('shipping status text after delivery confirmed (should mention "Delivery confirmed"):', shippingTextAfterConfirm);

const pass = !!template && purchased.status === 201 &&
  !!purchased.body.purchase?.paymentIntentId && !!deliveryConfirmUrl &&
  shipBtnCountBefore === 1 &&
  shippingTextAfterShip.includes('Shipped') && shipBtnCountAfter === 0 &&
  dialogMessages.filter((m) => m.includes('Delivery confirmed')).length === 2 &&
  shippingTextAfterConfirm.includes('Delivery confirmed') &&
  errors.length === 0;
await finish(browser, { pass, label: 'Post-purchase shipping flow: Mark Shipped + ?confirmDelivery= (#1231)', errors });
