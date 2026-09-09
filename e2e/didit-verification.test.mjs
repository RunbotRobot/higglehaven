// docs/SPEC.md §6, #589 (sub-issue of #556): government-ID verification
// via Didit, the higher trust tier above the credit-card tier. This
// deployment (the e2e wrangler dev server, like the vitest suite) never
// configures DIDIT_API_KEY, so this only covers the UI surfacing the
// correct state and the 503-unconfigured path through the real button,
// not a real Didit round trip — that has no test double to drive here.
import { launchPage, finish, waitForText } from './helpers.mjs';

const { browser, page, errors } = await launchPage({ promptAnswer: 'Didit Suite' });
const email = `didit-suite-${Date.now()}@example.com`;

await page.click('#account-menu-toggle');
await page.waitForSelector('#account-menu-panel.expanded', { timeout: 5000 });
await page.click('#account-auth-btn');
await page.waitForSelector('#auth-modal.visible', { timeout: 5000 });
await page.click('.auth-tab-btn[data-auth-view="signup"]');
await page.fill('#auth-signup-username', 'Didit Suite');
await page.fill('#auth-signup-email', email);
await page.fill('#auth-signup-password', 'a fine long password');
await page.check('#auth-signup-age-attest');
await page.click('#auth-signup-form button[type="submit"]');
await waitForText(page, '#account-auth-btn', 'Didit Suite');

const trustTierBeforeVerify = await page.textContent('#auth-account-trust-tier');
console.log('trust-tier text for a fresh account (should say not ID-verified):', trustTierBeforeVerify);
const verifyBtnVisible = await page.locator('#auth-verify-id-btn').isVisible();
console.log('"Verify with Government ID" button visible for a fresh account (should be true):', verifyBtnVisible);

await page.click('#auth-verify-id-btn');
const statusAfterClick = await waitForText(page, '#auth-status', 'not configured');
console.log('status after clicking Verify with Government ID (should mention "not configured" — Didit is unconfigured in this deployment):', statusAfterClick);

// The 503 above is a real, deliberate HTTP error response — Chromium logs
// it to the console as "Failed to load resource" independent of anything
// this app's own code does, the same expected fallout
// connectivity-indicator.test.mjs's own comment documents filtering out.
const unexpectedErrors = errors.filter((e) => !e.includes('Failed to load resource'));

const pass = trustTierBeforeVerify.includes('Not ID-verified') &&
  verifyBtnVisible &&
  statusAfterClick.includes('not configured') &&
  unexpectedErrors.length === 0;
await finish(browser, {
  pass,
  label: 'Didit government-ID verification (#589): account panel shows trust-tier status + Verify button, which surfaces the unconfigured-Didit error correctly',
  errors,
});
