// docs/SPEC.md §6, #589 (sub-issue of #556): government-ID verification
// via Didit, the higher trust tier above the credit-card tier. This
// deployment (the e2e wrangler dev server, like the vitest suite) never
// configures DIDIT_API_KEY, so this only covers the UI surfacing the
// correct state and the 503-unconfigured path through the real button,
// not a real Didit round trip — that has no test double to drive here.
import {
  launchPage, finish, waitForText, openAccountMenu, clearVerifyModalIfShown,
} from './helpers.mjs';

const { browser, page, errors } = await launchPage({ promptAnswer: 'Didit Suite' });
const email = `didit-suite-${Date.now()}@example.com`;

// N44 (owner, 2026-09-12): Shop mode's own entry now gates on login +
// age/card-or-ID verification (ensureShopperIdentity, src/main.js) — a
// fresh page load already has #auth-modal open before this test clicks
// anything, so sign up directly through it rather than reaching it via
// the account menu's own #account-auth-btn (that path only exists once
// already logged out cleanly, which a fresh visit no longer is).
await page.waitForSelector('#auth-modal.visible', { timeout: 8000 });
await page.click('.auth-tab-btn[data-auth-view="signup"]');
await page.fill('#auth-signup-username', 'Didit Suite');
await page.fill('#auth-signup-email', email);
await page.fill('#auth-signup-password', 'a fine long password');
await page.check('#auth-signup-age-attest');
await page.click('#auth-signup-form button[type="submit"]');
// #556's age/card gate has no "just dismiss it" escape while staying
// logged in (see requireVerification's own comment) — Shop's own entry
// now requires clearing it (at least the credit-card tier) before the
// world, or anything else on the page, becomes reachable at all. So a
// "fresh" account here means fresh above the credit-card floor, not
// fresh above `none` the way a pre-N44 signup was.
await clearVerifyModalIfShown(page);
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 10000 });

await openAccountMenu(page);
await page.click('#account-auth-btn');
await waitForText(page, '#account-auth-btn', 'Didit Suite');

const trustTierBeforeVerify = await page.textContent('#auth-account-trust-tier');
console.log('trust-tier text for an account that has only cleared the credit-card floor (should say credit-card verified, not yet ID-verified):', trustTierBeforeVerify);
const verifyBtnVisible = await page.locator('#auth-verify-id-btn').isVisible();
console.log('"Verify with Government ID" button visible while still below the id_verified tier (should be true):', verifyBtnVisible);

await page.click('#auth-verify-id-btn');
const statusAfterClick = await waitForText(page, '#auth-status', 'not configured');
console.log('status after clicking Verify with Government ID (should mention "not configured" — Didit is unconfigured in this deployment):', statusAfterClick);

// The 503 above is a real, deliberate HTTP error response — Chromium logs
// it to the console as "Failed to load resource" independent of anything
// this app's own code does, the same expected fallout
// connectivity-indicator.test.mjs's own comment documents filtering out.
const unexpectedErrors = errors.filter((e) => !e.includes('Failed to load resource'));

const pass = trustTierBeforeVerify.includes('Credit-card verified') &&
  verifyBtnVisible &&
  statusAfterClick.includes('not configured') &&
  unexpectedErrors.length === 0;
await finish(browser, {
  pass,
  label: 'Didit government-ID verification (#589): account panel shows trust-tier status + Verify button, which surfaces the unconfigured-Didit error correctly',
  errors,
});
