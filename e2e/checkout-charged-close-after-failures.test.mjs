// #4457: after the card is charged, Cancel stays locked (#3116) so a paid buyer is never told "Checkout cancelled."
// But when recording the order keeps failing (a rate limit shared by a whole office, a configuration fault) the
// buyer is not trapped: after three failed tries the sheet offers Close, and the notice says the payment went
// through and the order will appear in My purchases. A rate limit names its limit and when it lifts.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL = 'Checkout Charged Close Shopper';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });
await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });
await page.waitForSelector('body.shop-ready', { timeout: 15000 });

await page.route('**/api/purchases/finalize', (route) => route.fulfill({
  status: 429,
  contentType: 'application/json',
  body: JSON.stringify({ error: 'Too many attempts', limit: 10, windowSeconds: 900, retryAfterSeconds: 420 }),
}));
await page.evaluate(() => {
  window.__flowResult = null;
  window.Stripe = () => ({
    elements: () => ({ create: () => ({ mount() {}, unmount() {} }) }),
    confirmCardPayment: async () => ({ paymentIntent: { status: 'succeeded' } }),
  });
  window.__testRunCheckoutFlow(
    { clientSecret: 'cs_test', paymentIntentId: 'pi_test', publishableKey: 'pk_test' },
    { name: 'Closing Widget', totalCents: 1999 },
  ).then((result) => { window.__flowResult = { ok: true, result }; }, (err) => { window.__flowResult = { ok: false, message: err.message, chargedClosed: !!err.chargedClosed }; });
});
await page.waitForSelector('#checkout-modal.visible', { timeout: 10000 });
await page.waitForFunction(() => !document.getElementById('checkout-pay-btn').disabled, null, { timeout: 10000 });

const cancelState = () => page.evaluate(() => ({
  disabled: document.getElementById('checkout-cancel-btn').disabled,
  label: document.getElementById('checkout-cancel-btn').textContent.trim(),
}));
const tries = [];
for (let i = 0; i < 3; i++) {
  await page.click('#checkout-pay-btn');
  await page.waitForFunction(() => /My purchases/.test(document.getElementById('checkout-status').textContent), null, { timeout: 10000 });
  await page.waitForFunction(() => !document.getElementById('checkout-pay-btn').disabled, null, { timeout: 10000 });
  tries.push(await cancelState());
}
const status = await page.textContent('#checkout-status');
console.log('Cancel after tries 1, 2 and 3:', JSON.stringify(tries));
console.log('status:', status);

await page.click('#checkout-cancel-btn');
await page.waitForFunction(() => window.__flowResult !== null, null, { timeout: 10000 });
const flow = await page.evaluate(() => window.__flowResult);
console.log('flow result:', JSON.stringify(flow));

const pass = tries[0].disabled && tries[1].disabled
  && !tries[2].disabled && tries[2].label === 'Close'
  && /10 every 15 minutes/.test(status) && /about 7 minutes/.test(status) && /My purchases/.test(status)
  && flow?.ok === false && flow.chargedClosed === true && /My purchases/.test(flow.message)
  && (await page.locator('#checkout-modal.visible').count()) === 0
  && errors.every((e) => /status of 429/.test(e));
await finish(browser, { pass, label: '#4457: a paid buyer whose order cannot be recorded can close after three tries, and is told what happened', errors });
