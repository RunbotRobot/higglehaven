// Regression test for #1732: unlike renderLandCapField/renderRedeemHigglesField/
// renderAuctionSection (the #905 fix), renderSellSettingsSection never captured
// settingsRenderToken at all -- so a tab switch (or modal reopen) during its
// own `await fetchSellerStripeAccount()` could land the real-money Payouts
// field (balance text + "Cash out" button) on whatever tab was showing by the
// time that await resolved, instead of silently vanishing with the superseded
// render the way every sibling Settings-tab renderer already does. Same
// "delay one endpoint, switch tabs during the gap" technique as
// settings-tab-switch-race.test.mjs (#905) and seller-modal-reopen-race.test.mjs.
import { launchPage, chooseIdentity, openAccountMenu, finish } from './helpers.mjs';

const LABEL = 'Sell Settings Tab Race Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 10000 });
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

await openAccountMenu(page);
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
await page.click('.settings-tab-btn[data-section="sell"]');
await page.waitForTimeout(200);

await page.click('.settings-tab-btn[data-section="general"]');
await page.waitForTimeout(200);
const generalTabHtmlRightAfterSwitch = await page.locator('#settings-section').innerHTML();
console.log('General tab content right after switching away (should not yet mention Payout Account/Cash out):',
  /Payout Account|Cash out/.test(generalTabHtmlRightAfterSwitch) ? 'MENTIONS THEM' : 'clean');

// Wait past the delayed GET's own delay so the superseded Sell-tab render
// actually resolves and (pre-fix) would have appended the Payouts field --
// and, before that, the Payout Account field itself -- onto this tab.
await page.waitForTimeout(2500);

const stillOnGeneralTab = await page.locator('.settings-tab-btn[data-section="general"]').evaluate((el) => el.classList.contains('active'));
console.log('still showing the General tab (should be true -- no tab-switch happened on our own):', stillOnGeneralTab);

const generalTabHtmlAfterDelay = await page.locator('#settings-section').innerHTML();
const leaked = /Payout Account|Cash out|Set up payout account/.test(generalTabHtmlAfterDelay);
console.log('General tab content after the delayed stripe-account fetch resolves (should still be clean, not leaked):', leaked ? 'LEAKED' : 'clean');

await page.unroute('**/api/sellers/me/stripe-account');

// Switching back to Sell afterward should still work normally -- the fix
// only skips a superseded render, not a fresh, current one.
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
await page.click('.settings-tab-btn[data-section="sell"]');
await page.waitForFunction(
  () => [...document.querySelectorAll('button')].some((b) => b.textContent.includes('Cash out')),
  { timeout: 10000 },
);
const sellTabWorksNormally = await page.locator('button', { hasText: 'Cash out' }).count();
console.log('Sell tab still renders the Payouts field normally on a fresh, non-superseded switch (should be 1):', sellTabWorksNormally);

const pass = !/Payout Account|Cash out/.test(generalTabHtmlRightAfterSwitch) &&
  stillOnGeneralTab &&
  !leaked &&
  sellTabWorksNormally === 1 &&
  errors.length === 0;
await finish(browser, { pass, label: '#1732: a Settings Sell-tab render superseded mid-load does not leak the Payout Account/Payouts fields onto another tab', errors });
