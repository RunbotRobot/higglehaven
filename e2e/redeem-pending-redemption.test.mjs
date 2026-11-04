// #3077: after a redemption's transfer succeeded but its payout failed (#3068)
// the builder's debit stands, so "available to redeem" is 0 -- and the Redeem
// button used to render only when that was > 0, leaving no way to finish it.
// The server now reports the pending redemption on GET /api/builders/me/redeem.
// Stripe isn't configured on this dev server, so that GET response is faked
// here; what this covers is the Settings > Build UI reacting to it.
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, finish } from './helpers.mjs';

const LABEL = 'Pending Redemption Tester';
const PENDING_CENTS = 2500;

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

await page.route('**/api/builders/me/redeem', async (route) => {
  if (route.request().method() !== 'GET') return route.continue();
  const real = await route.fetch();
  const body = await real.json();
  return route.fulfill({
    response: real,
    json: { ...body, availableCents: 0, pendingRedemption: { amountCents: PENDING_CENTS } },
  });
});

await openAccountMenu(page);
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
await page.click('.settings-tab-btn[data-section="build"]');

await page.waitForFunction(
  () => [...document.querySelectorAll('.settings-field')].some((f) => f.textContent.includes('Redeem Higgles') && f.textContent.includes('Available to redeem')),
  null,
  { timeout: 60000 },
);

const statusText = await page.locator('.settings-field', { hasText: 'Redeem Higgles' }).locator('.settings-empty-note').first().textContent();
const finishBtn = page.getByRole('button', { name: `Finish pending redemption of $${(PENDING_CENTS / 100).toFixed(2)}` });
const finishBtnVisible = await finishBtn.isVisible();
const plainRedeemVisible = await page.getByRole('button', { name: 'Redeem', exact: true }).isVisible();
console.log('Status note:', statusText);
console.log('Finish button visible (should be true):', finishBtnVisible);
console.log('Plain Redeem button visible (should be false, nothing else is available):', plainRedeemVisible);

const pass = finishBtnVisible &&
  !plainRedeemVisible &&
  statusText.includes('has not been sent to your bank yet') &&
  !/#\d+|docs\/|API\.md/.test(statusText) &&
  errors.filter((e) => !e.includes('Failed to load resource')).length === 0;
await finish(browser, { pass, label: 'Settings > Build shows a way to finish a pending redemption when nothing else is available (#3077)', errors });
