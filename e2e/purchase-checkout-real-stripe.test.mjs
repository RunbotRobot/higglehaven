// #2861 (follow-up from #2859/#2860): #2859 asked for real-Stripe-Elements
// e2e coverage of BOTH call sites that load real Stripe.js and mount a
// card Element -- #2860 covered the age/card-verification step
// (e2e/verify-card-real-stripe.test.mjs); this covers the other one, the
// purchase-checkout step (src/shop/productCheckout.js's runCheckoutFlow,
// worker/lib/purchase-creation.js's createPurchaseCheckout).
//
// Unlike the verify-card step, createPurchaseCheckout only activates once
// a seller has a REAL, capability-enabled Stripe Connect **test** account
// (`seller.stripe_account_id && seller.stripe_onboarding_status ===
// 'complete'`, worker/lib/purchase-creation.js's own gate) -- there's no UI
// flow this suite can drive to provision one (Connect Custom onboarding is
// a real KYC/compliance flow, not just a card number). This instead drives
// the app's own REAL `POST /api/sellers/me/stripe-account` endpoint
// (handleSellerStripeAccount, worker/lib/seller-profile.js) directly via
// fetch -- the exact same code path a real seller's own onboarding form
// submission would hit -- but with Stripe Connect's own documented
// test-mode instant-verification fixture values
// (https://docs.stripe.com/connect/testing) standing in for a real
// person's SSN/address/bank account. In Stripe TEST mode only, those exact
// values let a Custom account reach charges_enabled/payouts_enabled=true
// with no real waiting period -- NOT real personal data, and this never
// runs against a live/production Stripe account (see e2e/run-all.mjs's own
// REAL_STRIPE_TEST_FILES gate, which only ever wires E2E_STRIPE_SECRET_KEY/
// E2E_STRIPE_PUBLISHABLE_KEY -- deliberately separate test-mode-only
// secrets from the live STRIPE_SECRET_KEY/STRIPE_PUBLISHABLE_KEY Worker
// secrets).
//
// Reaching the real "Buy" click itself has the same problem one level up:
// Shop mode's tap-to-inspect is a real raycast against the product's 3D
// mesh (src/main.js's own renderer.domElement click listener), and real
// camera-driven tap accuracy is deliberately never automated in this suite
// (see e2e/product-pricing.test.mjs's own comment on why -- it's verified
// manually instead). Rather than trying to raycast a tap onto the right
// on-screen pixel, this uses one small e2e-only test hook
// (window.__testTapShopProductByInstanceId, src/main.js, added alongside
// this PR) that opens the real product-preview modal for a known
// instanceId once it's in range -- the same "always inert unless a test
// calls it" convention every other window.__test* hook in this suite
// already follows. Everything AFTER that point -- the real "Buy" click,
// the real Stripe Elements card mount, the real confirmCardPayment round
// trip, and the real finalizePurchase call -- runs for real, which is the
// actual point of this test.
//
// Skips (not fails) when E2E_STRIPE_SECRET_KEY/E2E_STRIPE_PUBLISHABLE_KEY
// aren't set, same convention as e2e/verify-card-real-stripe.test.mjs --
// e2e/run-all.mjs only ever passes these through (via its own
// REAL_STRIPE_TEST_FILES gate) when CI's own repo secrets are configured.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, emailForLabel } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

if (!process.env.E2E_STRIPE_SECRET_KEY || !process.env.E2E_STRIPE_PUBLISHABLE_KEY) {
  console.log('SKIP: purchase-checkout-real-stripe.test.mjs (E2E_STRIPE_SECRET_KEY/E2E_STRIPE_PUBLISHABLE_KEY not set)');
  process.exit(0);
}

const SELLER_LABEL = 'Real Stripe Checkout Seller';
const BUYER_LABEL = 'Real Stripe Checkout Buyer';
const PRODUCT_NAME = 'Real Stripe Checkout Product';

async function fetchJson(page, pathAndQuery, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [pathAndQuery, options]);
}

// Shared by both accounts below -- each one independently hits the exact
// same real age/card-verification gate (src/account/identity.js's
// requireVerification, via ensureBuilderIdentity/ensureSellerIdentity/
// ensureShopperIdentity) once real Stripe is configured for this test
// file, same as e2e/verify-card-real-stripe.test.mjs's own single account.
// Duplicated here (not imported from that file) since this suite's own
// convention is a self-contained file per test, not a shared real-Stripe
// helper in e2e/helpers.mjs.
async function signUpAndVerifyWithRealCard(page, label) {
  await page.waitForSelector('#auth-modal.visible', { timeout: 15000 });
  await page.click('.auth-tab-btn[data-auth-view="signup"]');
  await page.fill('#auth-signup-username', label);
  await page.fill('#auth-signup-email', emailForLabel(label));
  await page.fill('#auth-signup-password', 'e2e-test-password-123');
  await page.check('#auth-signup-age-attest');
  const [signupResponse] = await Promise.all([
    page.waitForResponse(
      (response) => response.request().method() === 'POST' && response.url().endsWith('/api/auth/signup'),
      { timeout: 300000 },
    ),
    page.click('#auth-signup-form button[type="submit"]'),
  ]);
  if (!signupResponse.ok()) throw new Error(`signup failed with HTTP ${signupResponse.status()}`);
  await page.waitForSelector('#auth-modal:not(.visible)', { state: 'attached', timeout: 10000 });

  // Real Stripe configured means verifyStripeSetup.simulated is false, so
  // #verify-card-step becomes visible with a real Stripe Elements `card`
  // Element mounted into #verify-card-element -- same real round trip
  // e2e/verify-card-real-stripe.test.mjs's own comment documents in full.
  await page.waitForSelector('#verify-modal.visible', { timeout: 15000 });
  await page.waitForSelector('#verify-card-step:not([hidden])', { timeout: 30000 });
  await page.waitForFunction(() => !document.getElementById('verify-continue-btn').disabled, null, { timeout: 30000 });

  const stripeFrame = page.frameLocator('iframe[name^="__privateStripeFrame"]').first();
  await stripeFrame.locator('[name="cardnumber"]').fill('4242424242424242');
  await stripeFrame.locator('[name="exp-date"]').fill('12/34');
  await stripeFrame.locator('[name="cvc"]').fill('123');
  await stripeFrame.locator('[name="postal"]').fill('42424');

  await page.click('#verify-continue-btn');
  await page.waitForSelector('#verify-modal:not(.visible)', { state: 'attached', timeout: 60000 });
}

// --- Seller: sign up, verify, claim land, upload a priced product, then
// provision a real Stripe Connect TEST account via the app's own real
// onboarding endpoint. ---
const { browser: sellerBrowser, page: sellerPage, errors: sellerErrors } = await launchPage({ promptAnswer: SELLER_LABEL });

// N44 (see e2e/helpers.mjs's own chooseIdentity comment): a fresh page
// load already lands on Shop mode by default, which gates its own entry
// the same way Build/Sell do -- #auth-modal can already be showing before
// this click ever runs, in which case clicking the nav bar underneath it
// just times out against the still-open modal intercepting pointer events
// (found via a real CI failure on this exact line). Mirrors chooseIdentity's
// own two-part guard: skip the click if the modal's already up, then -- once
// verification clears Shop's own gate below, not necessarily Build's --
// switch into the actually-requested mode afterward.
const sellerAuthModalAlreadyShown = (await sellerPage.locator('#auth-modal.visible').count()) > 0;
if (!sellerAuthModalAlreadyShown) {
  await sellerPage.click('.mode-nav-btn[data-mode="build"]');
  await sellerPage.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
}
await signUpAndVerifyWithRealCard(sellerPage, SELLER_LABEL);
if (sellerAuthModalAlreadyShown) {
  await sellerPage.click('.mode-nav-btn[data-mode="build"]');
  await sellerPage.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
}

// Same claim-flow shape as e2e/helpers.mjs's own claimLandlet, inlined
// rather than reused since that helper assumes #auth-modal/#verify-modal
// are already past (true here too, just via the real-card path above
// instead of chooseIdentity's own simulated one) and only differs in how
// this test got to this point, not in the claim flow itself.
await sellerPage.waitForSelector('#claim-modal.visible', { timeout: 120000 });
await sellerPage.waitForFunction(
  () => document.getElementById('claim-status').textContent !== 'Loading the world…',
  null,
  { timeout: 60000 },
);
const claimCanvasBox = await sellerPage.locator('#claim-map-canvas').boundingBox();
for (const [fx, fy] of [[0.5, 0.5], [0.4, 0.4], [0.4, 0.3], [0.5, 0.3], [0.2, 0.4], [0.1, 0.4]]) {
  await sellerPage.mouse.click(claimCanvasBox.x + claimCanvasBox.width * fx, claimCanvasBox.y + claimCanvasBox.height * fy);
  await sellerPage.waitForTimeout(250);
  const selection = await sellerPage.textContent('#claim-selection-name');
  if (selection && selection.includes('Available')) break;
}
const [claimResponse] = await Promise.all([
  sellerPage.waitForResponse(
    (response) => response.request().method() === 'POST' && /\/api\/landlets\/[^/]+\/claim$/.test(new URL(response.url()).pathname),
    { timeout: 60000 },
  ),
  sellerPage.click('#claim-confirm-btn'),
]);
if (!claimResponse.ok()) throw new Error(`claim failed with HTTP ${claimResponse.status()}`);
await sellerPage.waitForSelector('#claim-modal:not(.visible)', { state: 'attached', timeout: 10000 });

await sellerPage.click('.mode-nav-btn[data-mode="sell"]');
await sellerPage.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
await sellerPage.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await sellerPage.waitForTimeout(300);
await sellerPage.click('#upload-model-btn');
await sellerPage.waitForSelector('#upload-modal.visible', { timeout: 10000 });
await sellerPage.fill('#upload-name', PRODUCT_NAME);
await sellerPage.fill('#upload-price', '19.99');
await sellerPage.setInputFiles('#upload-file-input', CRATE_MODEL_PATH);
await sellerPage.click('#upload-submit-btn');
await sellerPage.waitForFunction(() => !document.getElementById('upload-step-dimensions').hidden, null, { timeout: 30000 });
await sellerPage.waitForTimeout(300);
await sellerPage.click('#upload-submit-btn');
await sellerPage.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), null, { timeout: 30000 });
await sellerPage.waitForTimeout(500);

const { templates } = (await fetchJson(sellerPage, '/api/catalog?limit=100')).body;
const template = templates.find((t) => t.name === PRODUCT_NAME);
console.log('uploaded, priced product found in catalog (should be true):', !!template);

const { builder } = (await fetchJson(sellerPage, '/api/builders/me')).body;
const { landlets } = (await fetchJson(sellerPage, `/api/landlets?status=claimed&ownerBuilderId=${builder.builderId}&limit=100`)).body;
const landlet = landlets[0];

const instanceId = 'real-stripe-checkout-instance';
await fetchJson(sellerPage, '/api/instances', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ instanceId, landletId: landlet.landletId, templateId: template.templateId, x: 0, y: 0 }),
});

// Stripe Connect test-mode instant-verification fixture values
// (https://docs.stripe.com/connect/testing) -- NOT a real person's data,
// and only ever meaningful against a Stripe TEST secret key. dob
// 1902-01-01 and address.line1 "address_full_match" are Stripe's own
// documented magic values for an immediate, synchronous identity-
// verification match in test mode; ssn_last_4 "0000" is Stripe's own
// documented value for SSN-last-4 verification. routing/account
// 110000000/000123456789 are Stripe's own documented US test external
// bank account numbers for a successful payout destination. This is the
// exact same buildStripeAccountParams/handleSellerStripeAccount code
// path (worker/lib/seller-profile.js) a real seller's own onboarding form
// submission would hit -- only the input values differ. phone (#2927) is
// a plain test-mode-safe placeholder number, not a documented Stripe
// fixture value -- any validly-formatted number works for this field.
const stripeAccountInput = {
  individual: {
    firstName: 'Test',
    lastName: 'Seller',
    dobDay: 1,
    dobMonth: 1,
    dobYear: 1902,
    ssnLast4: '0000',
    phone: '+14155550100',
    addressLine1: 'address_full_match',
    addressCity: 'San Francisco',
    addressState: 'CA',
    addressPostalCode: '94105',
    addressCountry: 'US',
  },
  externalAccount: { currency: 'usd', routingNumber: '110000000', accountNumber: '000123456789' },
};
let stripeAccountResult = await fetchJson(sellerPage, '/api/sellers/me/stripe-account', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(stripeAccountInput),
});
console.log('Stripe Connect test account created (status should be 200):', stripeAccountResult.status, stripeAccountResult.body);

// Stripe's own test-mode magic values usually resolve synchronously in the
// account-create response itself, but this polls a few times rather than
// assuming that -- same "real network/verification cost, not a bug" margin
// reasoning this suite's own real-Stripe waits already use elsewhere
// (e.g. verify-card-real-stripe.test.mjs's own #verify-modal close wait).
// Logging requirementsCurrentlyDue on every attempt is deliberate: per
// this file's own header comment, a wrong fixture value here fails with
// no other way to debug it short of live Stripe API access, so the CI log
// itself needs to carry that detail.
for (let attempt = 0; attempt < 10 && stripeAccountResult.body.status !== 'complete'; attempt++) {
  await sellerPage.waitForTimeout(2000);
  stripeAccountResult = await fetchJson(sellerPage, '/api/sellers/me/stripe-account');
  console.log(`Stripe Connect account status poll ${attempt + 1} (should eventually be "complete"):`, stripeAccountResult.body.status, stripeAccountResult.body.requirementsCurrentlyDue);
}
const stripeAccountComplete = stripeAccountResult.body.status === 'complete';
console.log('Stripe Connect test account reached "complete" (should be true):', stripeAccountComplete);

await sellerBrowser.close();

// --- Buyer: sign up, verify, teleport to the seller's landlet, tap the
// product via the e2e-only hook above, and drive a real purchase through
// runCheckoutFlow's real Stripe Elements card entry + confirmCardPayment. ---
const { browser, page, errors } = await launchPage({ promptAnswer: BUYER_LABEL });
const dialogMessages = [];
page.on('dialog', (dialog) => { dialogMessages.push(dialog.message()); });

// Same N44 race as the seller's own build-mode entry above -- Shop is
// already the default landing mode on a fresh load, so #auth-modal can
// already be open (and intercepting this exact click) before this ever
// runs. Unlike the seller's build-mode case, no post-verification
// re-click is needed afterward: clearing Shop's own gate already *is*
// clearing the mode this test actually wants.
if ((await page.locator('#auth-modal.visible').count()) === 0) {
  await page.click('.mode-nav-btn[data-mode="shop"]');
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
}
await signUpAndVerifyWithRealCard(page, BUYER_LABEL);

await page.waitForSelector('#shop-fly-btn.visible', { timeout: 10000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });

// #1445: a brief real joystick deflection breaks Shop-mode's own hands-off
// spawn orbit, freeing shopAvatarPosition for the teleport hook below to
// actually drive -- same precedent as e2e/calendar-review-mount-offset.test.mjs.
const moveJoystickBox = await page.locator('#shop-move-joystick').boundingBox();
const moveCenterX = moveJoystickBox.x + moveJoystickBox.width / 2;
const moveCenterY = moveJoystickBox.y + moveJoystickBox.height / 2;
await page.mouse.move(moveCenterX, moveCenterY);
await page.mouse.down();
await page.mouse.move(moveCenterX + 25, moveCenterY, { steps: 5 });
await page.waitForTimeout(100);
await page.mouse.up();
await page.waitForTimeout(100);

await page.evaluate(([x, y]) => {
  window.__testTeleportShopAvatar(x, y);
  window.__testForceShopProximityCheck();
}, [landlet.center.x, landlet.center.y]);

// Polls until the instance's own landlet has loaded into shopReviews AND
// the tap succeeds (window.__testTapShopProductByInstanceId's own "always
// inert unless it can find a real match" contract, src/main.js) -- same
// teleport-then-poll shape as e2e/calendar-review-mount-offset.test.mjs's
// own window.__lastReviewSpriteDebug wait, just polling the tap itself
// instead of a separate debug hook.
await page.waitForFunction(
  (id) => window.__testTapShopProductByInstanceId(id),
  instanceId,
  { timeout: 30000 },
);
await page.waitForFunction(() => document.getElementById('shop-product-preview-buy-btn').classList.contains('visible'), null, { timeout: 15000 });

// handleShopProductBuyClick's own confirm() dialog, and later
// promptSellerFeedback's confirm()/prompt() pair, are all auto-accepted by
// launchPage's own default dialog handler -- this file only adds a second
// listener (same convention as e2e/purchase-shipping.test.mjs's own
// dialogMessages capture) to read back the "Purchase complete" alert as
// this test's actual pass signal, not to change any dialog's outcome.
await page.click('#shop-product-preview-buy-btn');

await page.waitForSelector('#checkout-modal.visible', { timeout: 15000 });
await page.waitForFunction(() => !document.getElementById('checkout-pay-btn').disabled, null, { timeout: 30000 });

const checkoutStripeFrame = page.frameLocator('#checkout-card-element iframe[name^="__privateStripeFrame"]').first();
await checkoutStripeFrame.locator('[name="cardnumber"]').fill('4242424242424242');
await checkoutStripeFrame.locator('[name="exp-date"]').fill('12/34');
await checkoutStripeFrame.locator('[name="cvc"]').fill('123');
await checkoutStripeFrame.locator('[name="postal"]').fill('42424');

await page.click('#checkout-pay-btn');
// #confirmCardPayment (real Stripe round trip) + finalizePurchase -- same
// "network-cost margin, not a click-actionability margin" reasoning
// verify-card-real-stripe.test.mjs's own #verify-modal close wait gives.
await page.waitForSelector('#checkout-modal:not(.visible)', { state: 'attached', timeout: 60000 });

console.log('dialog messages seen (should include a "Purchase complete" alert):', dialogMessages);
const purchaseCompleted = dialogMessages.some((message) => message.includes('Purchase complete'));

const pass = stripeAccountComplete && purchaseCompleted && errors.length === 0 && sellerErrors.length === 0;
await page.close();
await browser.close();
console.log('page errors:', errors.length || sellerErrors.length ? [...errors, ...sellerErrors] : 'none');
console.log(pass ? 'PASS: Real Stripe Elements: purchase-checkout drives a real payment via confirmCardPayment' : 'FAIL: Real Stripe Elements: purchase-checkout drives a real payment via confirmCardPayment');
process.exit(pass ? 0 : 1);
