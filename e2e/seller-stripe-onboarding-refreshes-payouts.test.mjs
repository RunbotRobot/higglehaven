// Regression test for #1373 (now the bud's Payouts leaf, #3704; it was Settings > Sell): the Payouts field
// (balance text + "Cash out" button) was only ever built once, during
// renderSellSettingsSection's own initial render, gated on account.connected
// as it stood at that moment. A first-time "Set up payout account" submit
// flips account.connected from false to true and updates the status text,
// but nothing re-evaluated that gate afterward -- the Payouts field (and the
// submit button's own "Update payout account" relabel) never appeared until
// the Sell tab was closed and reopened.
//
// Real Stripe is never configured in this test environment (no
// STRIPE_SECRET_KEY in .dev.vars, same limitation
// e2e/redeem-higgles-settings.test.mjs's own comment documents for the
// builder side) -- POST /api/sellers/me/stripe-account always 503s before
// ever flipping `connected`. So the one piece that needs mocking is the
// stripe-account GET/POST responses themselves (the same route.fulfill()
// idiom e2e/saved-layouts-load-more.test.mjs already uses for a response
// shape otherwise unreachable in this environment) -- everything else under
// test (the actual DOM rebuild behavior) is the real, unmodified app code.
import { launchPage, chooseIdentity, openPayoutsLeaf, openPayoutsForm, finish } from './helpers.mjs';

const LABEL = 'Seller Stripe Onboarding Refresh Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.click('#seller-close-btn');

// The real GET starts out correctly "not connected" (Stripe isn't
// configured here) -- only the POST (first-time submit) and every GET
// *after* it get mocked, so the initial render below is exercising the
// real, un-mocked "nothing set up yet" state.
let connected = false;
await page.route('**/api/sellers/me/stripe-account', async (route) => {
  const request = route.request();
  if (request.method() === 'GET') {
    if (!connected) {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ configured: true, connected: true, status: 'complete', requirementsCurrentlyDue: [], updatedAt: new Date().toISOString() }),
    });
    return;
  }
  if (request.method() === 'POST') {
    connected = true;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ configured: true, connected: true, status: 'complete', requirementsCurrentlyDue: [], updatedAt: new Date().toISOString() }),
    });
    return;
  }
  await route.continue();
});
await page.route('**/api/sellers/me/payouts', async (route) => {
  if (route.request().method() !== 'GET') {
    await route.continue();
    return;
  }
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ availableCents: 0, heldCents: 0, nextEligibleAt: null }),
  });
});

// #3704: the payout account is the bud's Payouts leaf now, not Settings > Sell; the form is two
// short steps (About you, then Where you live and Your bank).
await openPayoutsForm(page);
const leaf = page.locator('#bud-leaf-payouts');
const submitBtn = leaf.locator('button', { hasText: 'Set up payout account' });
// Anchored on the "Cash out" button itself: the not-configured-yet status text ("Stripe payouts
// aren't set up...") case-insensitively contains "payouts", so a text match on it would
// false-positive before onboarding even starts.
const payoutsFieldBeforeSubmit = await page.locator('button', { hasText: 'Cash out' }).count();
console.log('Cash out button not present before onboarding (should be 0):', payoutsFieldBeforeSubmit);

await leaf.locator('label', { hasText: 'First name' }).locator('input').fill('Grace');
await leaf.locator('label', { hasText: 'Last name' }).locator('input').fill('Hopper');
await leaf.locator('input[aria-label="Birth day"]').fill('9');
await leaf.locator('input[aria-label="Birth month"]').fill('12');
await leaf.locator('input[aria-label="Birth year"]').fill('1980');
await leaf.locator('label', { hasText: 'SSN' }).locator('input').fill('1234');
await leaf.locator('label', { hasText: 'Phone number' }).locator('input').fill('2025550100'); // required by the server, and now asked for before Next (#4339)
await leaf.locator('button', { hasText: 'Next' }).click();
await leaf.locator('label', { hasText: 'Street address' }).locator('input').fill('1 Compiler Lane');
await leaf.locator('label', { hasText: 'City' }).locator('input').fill('Arlington');
await leaf.locator('label', { hasText: 'State' }).locator('input').fill('VA');
await leaf.locator('label', { hasText: 'ZIP code' }).locator('input').fill('22201');
await leaf.locator('label', { hasText: 'Bank routing number' }).locator('input').fill('110000000');
await leaf.locator('label', { hasText: 'Bank account number' }).locator('input').fill('000123456789');

await submitBtn.click();

// The submit redraws the whole leaf -- wait for the real Cash out button to actually exist rather
// than a fixed sleep.
await page.waitForFunction(
  () => [...document.querySelectorAll('#bud-leaf-payouts button')].some((b) => b.textContent.includes('Cash out')),
  null,
  { timeout: 30000 },
);
const cashOutBtnPresentAfterSubmit = await page.locator('button', { hasText: 'Cash out' }).count();
console.log('Cash out button appears right after the first successful submit, no reopening needed (should be 1 -- was the #1373 bug):', cashOutBtnPresentAfterSubmit);

const relabeled = await page.locator('#bud-leaf-payouts button', { hasText: 'Update payout account' }).count();
console.log('Submit button relabeled to "Update payout account" after the first successful submit (should be 1):', relabeled);

const pass =
  payoutsFieldBeforeSubmit === 0 &&
  cashOutBtnPresentAfterSubmit === 1 &&
  relabeled === 1 &&
  errors.length === 0;
await finish(browser, { pass, label: 'Payouts field appears immediately after first-time Stripe onboarding, no tab switch needed (#1373)', errors });
