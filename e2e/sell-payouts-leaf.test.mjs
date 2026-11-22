// #3704 (Sell in the bud, 6/6, slice 1): the payout account lives in the bud's Payouts leaf.
// A petal in Sell opens it; the form is two short steps whose buttons stay on a 390x844 screen.
import { launchPage, chooseIdentity, openPayoutsLeaf, openPayoutsForm, finish } from './helpers.mjs';

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

// #4042: the leaf opens on what is owed, then why details are asked and one button; the form is not the first screen.
await openPayoutsLeaf(page);
await page.waitForSelector('#bud-leaf-payouts .payout-owed', { timeout: 30000 });
await page.waitForFunction(() => /owed to you so far/.test(document.querySelector('#bud-leaf-payouts .payout-owed')?.textContent || ''), null, { timeout: 15000 });
const first = await page.evaluate(() => ({
  owed: document.querySelector('#bud-leaf-payouts .payout-owed')?.textContent || '',
  formShown: !!document.querySelector('#bud-leaf-payouts .payout-form') && !document.querySelector('#bud-leaf-payouts .payout-form').hidden,
  ssnAsked: /SSN/.test(document.querySelector('#bud-leaf-payouts')?.innerText || ''),
  why: document.querySelector('#bud-leaf-payouts .payout-why')?.textContent || '',
  opener: document.querySelector('#bud-leaf-payouts .payout-open')?.textContent || '',
  firstChild: document.querySelector('#bud-leaf-payouts .bud-leaf-body')?.firstElementChild?.className || '',
}));
console.log('first screen:', JSON.stringify(first));
if (process.env.STILLS_DIR) await page.screenshot({ path: `${process.env.STILLS_DIR}/payouts-first.png` });
const firstScreenOk = /^\$0\.00 owed to you so far$/.test(first.owed) && !first.formShown && !first.ssnAsked
  && first.why.length > 0 && first.opener === 'Set up payouts' && first.firstChild.includes('payout-balance');
console.log('the leaf opens on what is owed, with no form and no SSN ask (should be true):', firstScreenOk);
await page.locator('#bud-leaf-payouts .payout-open').click();
await page.waitForSelector('#bud-leaf-payouts .payout-form', { state: 'visible', timeout: 5000 });
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

const pass = firstScreenOk && next && back && submit && firstName && errors.length === 0;
await finish(browser, { pass, label: '#3704: the Payouts leaf opens from the Sell bud and its two steps fit the phone screen', errors });
