// Regression test for #1403: the Settings > Build tab's "Redeem Higgles"
// field (#723) builds its submit button's label ("Set up payout account" vs.
// "Update payout account") once, during renderRedeemHigglesField's own
// initial render, gated on redeemStatus.connected as it stood at that
// moment. A first-time "Set up payout account" submit flips connected from
// false to true, but nothing re-evaluated that gate afterward -- the button
// kept reading "Set up payout account" until the Build tab was closed and
// reopened. Same bug class as #1373 (the sibling Sell tab's own Payouts
// field), fixed the same way: a renderSettingsSection() redraw right after
// a successful submit.
//
// Real Stripe is never configured in this test environment (no
// STRIPE_SECRET_KEY in .dev.vars, same limitation
// e2e/redeem-higgles-settings.test.mjs's own comment documents), so
// POST /api/builders/me/stripe-account always 503s before ever flipping
// `connected` for real -- the one piece that needs mocking is the
// stripe-account POST and the redeem GET it feeds (same route.fulfill()
// idiom e2e/seller-stripe-onboarding-refreshes-payouts.test.mjs already
// uses for its own sibling case); everything else under test (the actual
// DOM rebuild behavior) is the real, unmodified app code.
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, finish } from './helpers.mjs';

const LABEL = 'Redeem Higgles Relabel Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

// The real GET starts out correctly "not connected" -- only the POST
// (first-time submit) and every GET *after* it get mocked, so the initial
// render below is exercising the real, un-mocked "nothing set up yet" state.
let connected = false;
await page.route('**/api/builders/me/redeem', async (route) => {
  if (route.request().method() !== 'GET') {
    await route.continue();
    return;
  }
  if (!connected) {
    await route.continue();
    return;
  }
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ configured: true, connected: true, status: 'complete', requirementsCurrentlyDue: [], availableCents: 0, updatedAt: new Date().toISOString() }),
  });
});
await page.route('**/api/builders/me/stripe-account', async (route) => {
  if (route.request().method() !== 'POST') {
    await route.continue();
    return;
  }
  connected = true;
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ configured: true, connected: true, status: 'complete', requirementsCurrentlyDue: [], updatedAt: new Date().toISOString() }),
  });
});

await openAccountMenu(page);
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
await page.click('.settings-tab-btn[data-section="build"]');
await page.waitForFunction(
  () => [...document.querySelectorAll('.settings-field')].some((f) => f.textContent.includes('Redeem Higgles')),
  { timeout: 10000 },
);

// "Redeem Higgles" label and the actual form live in separate sibling
// .settings-field divs (per e2e/redeem-higgles-settings.test.mjs's own
// comment) -- the submit button is found by its own exact text rather
// than scoped under the label's field.
const submitBtn = page.getByRole('button', { name: 'Set up payout account' });
await submitBtn.waitFor({ timeout: 10000 });

const formField = page.locator('.settings-field').filter({ has: submitBtn });
await formField.locator('label', { hasText: 'First name' }).locator('input').fill('Grace');
await formField.locator('label', { hasText: 'Last name' }).locator('input').fill('Hopper');
await formField.locator('label', { hasText: 'Birth day' }).locator('input').fill('9');
await formField.locator('label', { hasText: 'Birth month' }).locator('input').fill('12');
await formField.locator('label', { hasText: 'Birth year' }).locator('input').fill('1980');
await formField.locator('label', { hasText: 'SSN' }).locator('input').fill('1234');
await formField.locator('label', { hasText: 'Street address' }).locator('input').fill('1 Compiler Lane');
await formField.locator('label', { hasText: 'City' }).locator('input').fill('Arlington');
await formField.locator('label', { hasText: 'State' }).locator('input').fill('VA');
await formField.locator('label', { hasText: 'ZIP code' }).locator('input').fill('22201');
await formField.locator('label', { hasText: 'Bank routing number' }).locator('input').fill('110000000');
await formField.locator('label', { hasText: 'Bank account number' }).locator('input').fill('000123456789');

await submitBtn.click();

// The fix's own renderSettingsSection() redraw tears down and rebuilds the
// whole tab -- wait for the real relabeled button to actually exist, same
// as any other async-render assertion in this suite, rather than a fixed
// sleep.
await page.waitForFunction(
  () => [...document.querySelectorAll('button')].some((b) => b.textContent.includes('Update payout account')),
  { timeout: 10000 },
);
const relabeledBtnPresent = await page.getByRole('button', { name: 'Update payout account' }).count();
console.log('Submit button relabeled to "Update payout account" right after the first successful submit, no tab switch needed (should be 1 -- was the #1403 bug):', relabeledBtnPresent);

const staleSetUpBtnStillPresent = await page.getByRole('button', { name: 'Set up payout account' }).count();
console.log('Old "Set up payout account" label no longer present (should be 0):', staleSetUpBtnStillPresent);

// Land Cap is a sibling field rendered by the same renderBuildSettingsSection
// redraw -- confirm the redraw completed cleanly, not left mid-teardown.
const landCapStillShowing = (await page.locator('#land-cap-field').textContent()).includes('cap');
console.log('Land Cap field still showing loaded text after the redraw (should be true):', landCapStillShowing);

const pass =
  relabeledBtnPresent === 1 &&
  staleSetUpBtnStillPresent === 0 &&
  landCapStillShowing &&
  errors.length === 0;
await finish(browser, { pass, label: 'Build tab\'s Redeem Higgles submit button relabels immediately after first-time Stripe onboarding, no tab switch needed (#1403)', errors });
