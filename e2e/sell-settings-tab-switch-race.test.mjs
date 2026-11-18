// Regression test for #1732: unlike renderLandCapField/renderRedeemHigglesField/
// renderAuctionSection (the #905 fix), renderSellSettingsSection never captured
// settingsRenderToken at all -- so a tab switch (or modal reopen) during its
// own `await fetchSellerStripeAccount()` could land the real-money Payouts
// field (balance text + "Cash out" button) on whatever tab was showing by the
// time that await resolved, instead of silently vanishing with the superseded
// render the way every sibling Settings-tab renderer already does. Same
// "delay one endpoint, switch tabs during the gap" technique as
// settings-tab-switch-race.test.mjs (#905) and seller-modal-reopen-race.test.mjs.
import { launchPage, chooseIdentity, openPayoutsLeaf, finish } from './helpers.mjs';

const LABEL = 'Sell Settings Tab Race Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.click('#seller-close-btn');

// Real Stripe is never configured in this test environment (no
// STRIPE_SECRET_KEY in .dev.vars) -- mock the stripe-account GET to report a
// fully connected account (same route.fulfill() idiom
// seller-stripe-onboarding-refreshes-payouts.test.mjs already uses for this
// response shape) so the Payouts field actually gets built, with a delay
// long enough to reliably switch tabs before it resolves.
await page.route('**/api/sellers/me/stripe-account', async (route) => {
  if (route.request().method() !== 'GET') {
    await route.continue();
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ configured: true, connected: true, status: 'complete', requirementsCurrentlyDue: [], updatedAt: new Date().toISOString() }),
  });
});
await page.route('**/api/sellers/me/payouts', async (route) => {
  if (route.request().method() !== 'GET') {
    await route.continue();
    return;
  }
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ availableCents: 500, heldCents: 0, nextEligibleAt: null }),
  });
});

// #3704: the payout account is the bud's Payouts leaf now, so the race is "close the leaf while its
// account fetch is still in flight": the superseded render must not paint into anything.
await openPayoutsLeaf(page);
await page.waitForTimeout(200);
await page.click('#bud-leaf-payouts .bud-leaf-close');
await page.waitForSelector('#bud-leaf-payouts', { state: 'detached', timeout: 5000 });
await page.waitForTimeout(2800);
const leaked = await page.evaluate(() => /Payout Account|Cash out|Set up payout account/.test(document.body.innerText));
console.log('After the delayed stripe-account fetch resolves, nothing on screen mentions payouts (should be clean):', leaked ? 'LEAKED' : 'clean');
const leafBack = await page.locator('#bud-leaf-payouts').count();
console.log('Closed leaf did not come back (should be 0):', leafBack);

await page.unroute('**/api/sellers/me/stripe-account');
await page.route('**/api/sellers/me/stripe-account', async (route) => {
  if (route.request().method() !== 'GET') {
    await route.continue();
    return;
  }
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ configured: true, connected: true, status: 'complete', requirementsCurrentlyDue: [], updatedAt: new Date().toISOString() }),
  });
});
await openPayoutsLeaf(page);
await page.waitForFunction(
  () => [...document.querySelectorAll('#bud-leaf-payouts button')].some((b) => b.textContent.includes('Cash out')),
  null,
  { timeout: 60000 },
);
const sellTabWorksNormally = await page.locator('#bud-leaf-payouts button', { hasText: 'Cash out' }).count();
console.log('A fresh, non-superseded open still renders the balance and Cash out (should be 1):', sellTabWorksNormally);

const pass = !leaked && leafBack === 0 && sellTabWorksNormally === 1 && errors.length === 0;
await finish(browser, { pass, label: '#1732/#3704: a Payouts leaf closed mid-load does not leak the payout fields onto the world', errors });
