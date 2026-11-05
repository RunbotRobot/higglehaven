// #3116: if the server's finalize call fails AFTER the card was charged
// (network drop, 5xx), the checkout modal must keep the buyer in a
// "payment received" state whose button retries only finalize -- never
// confirming the card a second time -- and must not let them dismiss the
// modal as if the purchase had been cancelled.
//
// Drives the real checkout modal (src/shop/productCheckout.js) through its
// e2e-only window.__testRunCheckoutFlow hook with a stubbed Stripe.js (so no
// real Stripe keys are needed) and a finalize endpoint that fails once and
// then succeeds. The card-declined and already-succeeded branches are
// covered at the unit level (src/shop/checkoutPayAttempt.test.js); this
// covers the DOM behaviour around them.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL = 'Checkout Finalize Retry Suite Shopper';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });
await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 15000 });

let finalizeCalls = 0;
await page.route('**/api/purchases/finalize', async (route) => {
  finalizeCalls += 1;
  if (finalizeCalls === 1) {
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'upstream exploded: raw provider text' }) });
  } else {
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ purchase: { purchaseId: 'checkout-retry-purchase' } }) });
  }
});

await page.evaluate(() => {
  window.__confirmCalls = 0;
  window.__flowResult = null;
  // loadStripeJs resolves immediately when window.Stripe already exists.
  window.Stripe = () => ({
    elements: () => ({ create: () => ({ mount() {}, unmount() {} }) }),
    confirmCardPayment: async () => { window.__confirmCalls += 1; return { paymentIntent: { status: 'succeeded' } }; },
  });
  window.__testRunCheckoutFlow(
    { clientSecret: 'cs_test', paymentIntentId: 'pi_test', publishableKey: 'pk_test' },
    { name: 'Retry Widget', totalCents: 1999 },
  ).then((result) => { window.__flowResult = { ok: true, result }; }, (err) => { window.__flowResult = { ok: false, message: err.message }; });
});

await page.waitForSelector('#checkout-modal.visible', { timeout: 10000 });
await page.waitForFunction(() => !document.getElementById('checkout-pay-btn').disabled, null, { timeout: 10000 });
const payLabelBefore = await page.textContent('#checkout-pay-btn');

// First attempt: the card is charged, finalize fails.
await page.click('#checkout-pay-btn');
await page.waitForFunction(() => /went through/.test(document.getElementById('checkout-status').textContent), null, { timeout: 10000 });
const status1 = await page.textContent('#checkout-status');
const payLabelAfter = await page.textContent('#checkout-pay-btn');
const payEnabled = await page.locator('#checkout-pay-btn').isEnabled();
const cancelDisabled = await page.locator('#checkout-cancel-btn').isDisabled();
const rawLeaked = /raw provider text|upstream exploded/.test(status1);
console.log('Pay button label before (should be "Pay"):', payLabelBefore);
console.log('status after the failed finalize:', status1);
console.log('Pay button now says (should be "Finish purchase"):', payLabelAfter);
console.log('Pay re-enabled (should be true):', payEnabled, '| Cancel disabled (should be true):', cancelDisabled);
console.log('raw server text leaked (should be false):', rawLeaked);

// Escape must not dismiss a charged, unfinalized checkout.
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
const stillOpen = await page.locator('#checkout-modal.visible').count();
const settledEarly = await page.evaluate(() => window.__flowResult);
console.log('modal still open after Escape (should be 1):', stillOpen, '| flow settled early (should be null):', JSON.stringify(settledEarly));

// Retry: only finalize runs again; the card is never confirmed twice.
await page.click('#checkout-pay-btn');
await page.waitForFunction(() => window.__flowResult !== null, null, { timeout: 10000 });
const flowResult = await page.evaluate(() => window.__flowResult);
const confirmCalls = await page.evaluate(() => window.__confirmCalls);
const modalClosed = (await page.locator('#checkout-modal.visible').count()) === 0;
console.log('flow result (should be ok):', JSON.stringify(flowResult));
console.log('confirmCardPayment calls (should be 1):', confirmCalls, '| finalize calls (should be 2):', finalizeCalls);
console.log('modal closed after success (should be true):', modalClosed);

const pass = payLabelBefore.trim() === 'Pay'
  && /went through/.test(status1)
  && !rawLeaked
  && payLabelAfter.trim() === 'Finish purchase'
  && payEnabled
  && cancelDisabled
  && stillOpen === 1
  && settledEarly === null
  && flowResult?.ok === true
  && confirmCalls === 1
  && finalizeCalls === 2
  && modalClosed
  // The one 503 is the stubbed failure itself: the browser logs it.
  && errors.every((e) => /status of 503/.test(e));
await finish(browser, {
  pass,
  label: '#3116: a finalize failure after the card is charged retries only finalize, keeps the modal open, and never double-confirms',
  errors,
});
