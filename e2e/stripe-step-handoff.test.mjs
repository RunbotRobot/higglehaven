// #2928: when Stripe needs something our own payout form never collects (a
// full SSN/ITIN, an ID document), the seller's payout panel shows a plain
// "Continue with Stripe" step instead of listing the raw requirement, and the
// button asks the server for Stripe's single-use onboarding link and sends the
// browser there. Real Stripe is never configured in this environment, so the
// account GET and the link POST are mocked with route.fulfill (same idiom as
// e2e/seller-stripe-onboarding-refreshes-payouts.test.mjs); the DOM behaviour
// under test is the real, unmodified app code.
import { launchPage, chooseIdentity, openAccountMenu, finish } from './helpers.mjs';

const LABEL = 'Stripe Step Handoff Tester';
const STRIPE_URL = 'https://connect.stripe.test/setup/e/handoff';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.click('#seller-close-btn');

await page.route('**/api/sellers/me/stripe-account*', async (route) => {
  if (route.request().method() !== 'GET') { await route.continue(); return; }
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      configured: true, connected: true, status: 'requirements_due',
      requirementsCurrentlyDue: ['individual.phone', 'individual.id_number'],
      stripeStepRequirements: ['individual.id_number'],
      updatedAt: new Date().toISOString(),
    }),
  });
});
await page.route('**/api/sellers/me/payouts', async (route) => {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ availableCents: 0, heldCents: 0, nextEligibleAt: null }) });
});
let linkRequests = 0;
await page.route('**/api/sellers/me/stripe-onboarding-link', async (route) => {
  linkRequests += 1;
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ url: STRIPE_URL, expiresAt: null }) });
});
// The destination is not a real host: answer it locally so the navigation completes.
await page.route(`${STRIPE_URL}*`, async (route) => {
  await route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>stripe</body></html>' });
});

await openAccountMenu(page);
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
await page.click('.settings-tab-btn[data-section="sell"]');
await page.waitForSelector('.stripe-step-prompt', { timeout: 30000 });

const field = page.locator('.settings-field', { hasText: 'Payout Account' });
const fieldText = await field.first().textContent();
const showsRawRequirement = fieldText.includes('id_number');
const listsOwnRequirement = fieldText.includes('individual.phone');
const promptText = await page.locator('.stripe-step-prompt').first().textContent();
console.log('Prompt text:', promptText.trim());
console.log('Raw Stripe-only requirement hidden (should be false):', showsRawRequirement);
console.log('Own-form requirement still listed (should be true):', listsOwnRequirement);

await Promise.all([
  page.waitForURL(`${STRIPE_URL}*`, { timeout: 15000 }),
  page.click('.stripe-step-prompt button'),
]);
console.log('Link requests made (should be 1):', linkRequests);

const pass =
  promptText.includes('Stripe needs a bit more information') &&
  !showsRawRequirement &&
  listsOwnRequirement &&
  linkRequests === 1 &&
  errors.length === 0;
await finish(browser, { pass, label: 'Stripe-only requirements hand off to Stripe via a Continue button (#2928)', errors });
