// #3704 (Sell in the bud, 6/6, slice 1): the payout account lives in the bud's Payouts leaf.
// A petal in Sell opens it; the form is two short steps whose buttons stay on a 390x844 screen.
import { launchPage, chooseIdentity, openPayoutsLeaf, finish } from './helpers.mjs';

const LABEL = 'Payouts Leaf Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });
await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#account-menu-toggle', { state: 'visible', timeout: 30000 });

await page.route('**/api/sellers/me/stripe-account*', async (route) => {
  if (route.request().method() !== 'GET') { await route.continue(); return; }
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ configured: true, connected: false, status: 'not_started', requirementsCurrentlyDue: [] }) });
});
await page.route('**/api/sellers/me/payouts', async (route) => {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ availableCents: 0, heldCents: 0, nextEligibleAt: null }) });
});

await openPayoutsLeaf(page);
await page.waitForSelector('#bud-leaf-payouts .payout-form', { timeout: 30000 });
const leaf = page.locator('#bud-leaf-payouts');
const inView = async (text) => leaf.locator('button', { hasText: text }).first().evaluate((el) => {
  const r = el.getBoundingClientRect();
  return r.top >= 0 && r.bottom <= window.innerHeight;
});
const next = await inView('Next');
console.log('Next is on screen at 390x844 (should be true):', next);
await leaf.locator('button', { hasText: 'Next' }).click();
const back = await inView('Back');
const submit = await inView('Set up payout account');
console.log('Back and submit are on screen on step 2 (should be true, true):', back, submit);
await leaf.locator('button', { hasText: 'Back' }).click();
const firstName = await leaf.locator('label', { hasText: 'First name' }).locator('input').isVisible();
console.log('Back returns to About you (should be true):', firstName);

const pass = next && back && submit && firstName && errors.length === 0;
await finish(browser, { pass, label: '#3704: the Payouts leaf opens from the Sell bud and its two steps fit the phone screen', errors });
