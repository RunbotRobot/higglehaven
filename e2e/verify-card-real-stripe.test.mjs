// #2859 (follow-up from #2857, merged): the only e2e coverage of the
// age/card-verification step (src/account/auth.js's enterVerifyCardStep +
// verifyContinueBtn's click handler, worker/lib/stripe.js's
// handleCardSetupIntent/handleConfirmCard) ran the `simulated: true`
// dev-mode fallback — this environment never configures STRIPE_SECRET_KEY,
// so the real Stripe.js/Stripe Elements/confirmCardSetup branch never ran
// in CI at all. That's exactly how #2857's bug (calling `Stripe(publishableKey)`
// twice — once in enterVerifyCardStep, again in the click handler — which
// Stripe.js rejects at confirmCardSetup time with "Please use the same
// instance of `Stripe`...") shipped unnoticed: every other test file
// exercises the simulated branch on purpose (see
// worker/lib/purchase-creation.js's own E2E_SIMULATE_PAID_PURCHASES
// comment), so nothing anywhere actually drove a real card through
// Stripe.js until now.
//
// Deliberately NOT covered here: the purchase-checkout call site
// (src/shop/productCheckout.js's runCheckoutFlow / worker/lib/purchase-
// creation.js's createPurchaseCheckout) also uses real Stripe.js, but only
// once a seller has a REAL, capability-enabled Stripe Connect test account
// (`stripe_account_id` + `stripe_onboarding_status = 'complete'`,
// worker/lib/purchase-creation.js's own `seller?.stripe_account_id &&
// seller.stripe_onboarding_status === 'complete'` gate) — provisioning one
// of those needs Stripe Connect's own test-mode instant-verification
// fixture values (https://docs.stripe.com/connect/testing), not just a
// card number, and is a meaningfully different, harder-to-validate-
// without-live-Stripe-access problem than this file's scope. Filed
// separately (see #2859's own closing comment) rather than guessed at here.
//
// Skips (not fails) when E2E_STRIPE_SECRET_KEY/E2E_STRIPE_PUBLISHABLE_KEY
// aren't set — e2e/run-all.mjs only ever passes these through (via its own
// REAL_STRIPE_TEST_FILES gate) when CI's E2E_STRIPE_SECRET_KEY/
// E2E_STRIPE_PUBLISHABLE_KEY repo secrets are configured; a local run
// without them exported falls back to the same "nothing to test here yet"
// skip rather than a hard failure.
import { launchPage, emailForLabel, finish } from './helpers.mjs';

const LABEL = 'Real Stripe Verify Card Tester';

if (!process.env.E2E_STRIPE_SECRET_KEY || !process.env.E2E_STRIPE_PUBLISHABLE_KEY) {
  console.log('SKIP: verify-card-real-stripe.test.mjs (E2E_STRIPE_SECRET_KEY/E2E_STRIPE_PUBLISHABLE_KEY not set)');
  process.exit(0);
}

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

// N44: Shop mode gates its own entry the same way Build/Sell do, and a
// fresh page load already lands on Shop by default -- #auth-modal is
// already open by the time this runs, same race chooseIdentity's own
// comment in e2e/helpers.mjs documents (an earlier version of this test
// clicked a mode-nav button first, which the modal was already
// intercepting pointer events for). No click needed; this test only
// cares about the account/verification flow, not which mode it lands in.
await page.waitForSelector('#auth-modal.visible', { timeout: 8000 });

await page.click('.auth-tab-btn[data-auth-view="signup"]');
await page.fill('#auth-signup-username', LABEL);
await page.fill('#auth-signup-email', emailForLabel(LABEL));
await page.fill('#auth-signup-password', 'e2e-test-password-123');
// Age-attest only — leaving the verify-card step itself to run for real
// below, rather than chooseIdentity's own clearVerifyModalIfShown (which
// assumes `simulated: true` and clicks Continue with no card filled in —
// exactly wrong here, since this run has real Stripe configured).
await page.check('#auth-signup-age-attest');
const [signupResponse] = await Promise.all([
  page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().endsWith('/api/auth/signup'),
    { timeout: 300000 },
  ),
  page.click('#auth-signup-form button[type="submit"]'),
]);
if (!signupResponse.ok()) {
  throw new Error(`signup failed with HTTP ${signupResponse.status()}`);
}
await page.waitForSelector('#auth-modal:not(.visible)', { state: 'attached', timeout: 10000 });

// Age was already attested at signup, so #verify-modal opens straight into
// enterVerifyCardStep() (src/account/auth.js) — real Stripe configured
// means verifyStripeSetup.simulated is false, so #verify-card-step becomes
// visible with a real Stripe Elements `card` Element mounted into
// #verify-card-element, instead of staying hidden.
await page.waitForSelector('#verify-modal.visible', { timeout: 15000 });
await page.waitForSelector('#verify-card-step:not([hidden])', { timeout: 30000 });
await page.waitForFunction(() => !document.getElementById('verify-continue-btn').disabled, null, { timeout: 30000 });

// Stripe's own combined `card` Element renders every sub-field (number,
// expiry, cvc, postal — postal is on by default since
// enterVerifyCardStep's elements.create('card') call passes no options to
// hide it) inside one same-origin-named iframe. `cardnumber`/`exp-date`/
// `cvc`/`postal` are Stripe.js's own stable internal input `name`
// attributes for this Element, unrelated to this app's own markup.
const stripeFrame = page.frameLocator('iframe[name^="__privateStripeFrame"]').first();
await stripeFrame.locator('[name="cardnumber"]').fill('4242424242424242');
await stripeFrame.locator('[name="exp-date"]').fill('12/34');
await stripeFrame.locator('[name="cvc"]').fill('123');
await stripeFrame.locator('[name="postal"]').fill('42424');

await page.click('#verify-continue-btn');
// #confirmCardSetup (real Stripe round trip) + POST /auth/confirm-card —
// genuinely slower than the simulated path's instant local DB write, same
// "network-cost margin, not a click-actionability margin" reasoning
// clearVerifyModalIfShown's own #2544 comment documents for the simulated
// case.
await page.waitForSelector('#verify-modal:not(.visible)', { state: 'attached', timeout: 60000 });

const { user } = await page.evaluate(async () => {
  const res = await fetch('/api/auth/me');
  return res.json();
});
console.log('verified user trustTier/cardFunding (should be credit_card/credit):', user?.trustTier, user?.cardFunding);

const pass = user?.trustTier === 'credit_card' && user?.cardFunding === 'credit' && errors.length === 0;
await finish(browser, { pass, label: 'Real Stripe Elements: verify-card step confirms a real test card via confirmCardSetup', errors });
