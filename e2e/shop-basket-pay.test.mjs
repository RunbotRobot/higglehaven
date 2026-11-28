// #4666 slice 2 (part of #4604): the Basket leaf's Pay step. The basket routes are mocked (the real ones need a seller
// with card payments, which the e2e server does not have): with a quote that cannot be paid, Pay is drawn disabled with
// its reason; with one that can, Pay names the total, asks for an address because a line is shipped, sends the prices the
// person saw and the address to POST /api/basket/checkout, and opens the same payment sheet Buy uses, for "Your basket".
// A refusal from the server (409 with lines) says it in words and charges nothing.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL = 'Basket Pay Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
const json = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const LINES = [
  { instanceId: 'bp-1', quantity: 1, productName: 'Pay Crate', sellerId: 's-a', sellerName: 'Seller A', templateId: 't-a' },
  { instanceId: 'bp-2', quantity: 2, productName: 'Pay Lamp', sellerId: 's-b', sellerName: 'Seller B', templateId: 't-b' },
];
const quoteLine = (line, price, extra = {}) => ({ instanceId: line.instanceId, quantity: line.quantity, productName: line.productName, sellerId: line.sellerId,
  unitPriceCents: price, lineTotalCents: price * line.quantity, commissionCents: 0, paysWithCard: true, requiresShippingAddress: true, status: 'ok', ...extra });
let payable = false;
let checkoutBodies = [];
let checkoutAnswer = null;
await page.route('**/api/basket-config', (route) => route.fulfill(json({ checkoutEnabled: true })));
await page.route('**/api/basket', (route) => (route.request().method() === 'GET'
  ? route.fulfill(json({ lines: LINES, maxQuantity: 20, maxLines: 20 })) : route.continue()));
await page.route('**/api/basket/quote*', (route) => route.fulfill(json({
  lines: [quoteLine(LINES[0], 1000), payable ? quoteLine(LINES[1], 1500) : quoteLine(LINES[1], 1500, { status: 'sold_out', code: 'sold_out' })],
  sellers: [], totals: { goodsCents: 4000, shippingCents: 0, totalCents: 4000 }, payable,
})));
await page.route('**/api/basket/checkout', async (route) => {
  checkoutBodies.push(JSON.parse(route.request().postData() || '{}'));
  if (checkoutAnswer) return route.fulfill(json(checkoutAnswer.body, checkoutAnswer.status));
  return route.fulfill(json({ requiresPayment: true, basketOrderId: 'bko_x', totalCents: 4000, clientSecret: 'cs_x', paymentIntentId: 'pi_x', publishableKey: 'pk_test_x' }));
});
await page.reload();
await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });
await page.waitForSelector('body.shop-ready', { timeout: 30000 });

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };
const openLeaf = async () => {
  const expanded = await page.evaluate(() => document.getElementById('account-menu-panel')?.classList.contains('expanded'));
  if (!expanded) await page.click('#account-menu-toggle');
  await page.waitForSelector('#bud-petal-shop-basket', { timeout: 8000 });
  await page.click('#bud-petal-shop-basket');
  await page.waitForSelector('#bud-leaf-basket .basket-row', { timeout: 8000 });
  await page.waitForSelector('#bud-leaf-basket .basket-pay', { timeout: 8000 });
};

// A quote with a line that cannot be bought: Pay is drawn, disabled, and its reason is beside it.
await openLeaf();
check(await page.isDisabled('#bud-leaf-basket .basket-pay-button'), 'Pay is disabled while a line cannot be bought');
const reason = await page.textContent('#bud-leaf-basket .basket-pay-reason');
check(/marked above/i.test(reason), `the reason sits beside Pay (${reason})`);
await page.keyboard.press('Escape');
await page.waitForTimeout(500);

// A payable quote: Pay names the total, asks for the address, and sends what the person saw.
payable = true;
await openLeaf();
const label = (await page.textContent('#bud-leaf-basket .basket-pay-button')).trim();
check(label === 'Pay $40.00', `Pay names the total (${label})`);
check(!(await page.isDisabled('#bud-leaf-basket .basket-pay-button')), 'Pay is usable when every line can be bought');
await page.click('#bud-leaf-basket .basket-pay-button');
await page.waitForSelector('#shipping-address-modal.visible', { timeout: 8000 });
check(checkoutBodies.length === 0, 'the address is asked before any payment is started');
await page.fill('#shipping-address-name', 'Pay Tester');
await page.fill('#shipping-address-line1', '12 Orchard Lane');
await page.fill('#shipping-address-city', 'Portland');
await page.fill('#shipping-address-region', 'OR');
await page.fill('#shipping-address-postal', '97201');
await page.click('#shipping-address-continue-btn');
await page.waitForSelector('#checkout-modal.visible', { timeout: 8000 });
const summary = (await page.textContent('#checkout-summary')).trim();
check(summary === 'Your basket — $40.00', `the sheet is for the basket (${summary})`);
check(checkoutBodies.length === 1 && checkoutBodies[0].shippingAddress?.line1 === '12 Orchard Lane', 'the address is sent with the checkout');
check(checkoutBodies[0]?.expected?.['bp-1'] === 1000 && checkoutBodies[0]?.expected?.['bp-2'] === 1500, 'the prices the person saw are sent');
const payLabel = (await page.textContent('#checkout-pay-btn')).trim();
check(payLabel === 'Pay $40.00', `the sheet's Pay names the amount (${payLabel})`);
await page.click('#checkout-cancel-btn');
await page.waitForFunction(() => !document.getElementById('checkout-modal').classList.contains('visible'), null, { timeout: 5000 });

// A refusal from the server says so in words, and nothing is charged.
checkoutAnswer = { status: 409, body: { error: 'Some items in your basket cannot be bought right now. You were not charged.', code: 'not_for_sale', lines: [] } };
await page.click('#bud-leaf-basket .basket-pay-button');
await page.waitForSelector('#shipping-address-modal.visible', { timeout: 8000 });
await page.click('#shipping-address-continue-btn');
await page.waitForSelector('#notice-modal.visible', { timeout: 8000 });
const notice = (await page.textContent('#notice-modal')).trim();
check(/You were not charged/.test(notice), `a refusal says nothing was charged (${notice.slice(0, 120)})`);

await finish(browser, { pass: pass && errors.filter((e) => !/Failed to load resource/.test(e)).length === 0, label: '#4666: the Basket leaf pays the basket through the same payment sheet Buy uses', errors });
