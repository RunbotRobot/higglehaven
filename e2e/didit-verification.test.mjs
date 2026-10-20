// docs/SPEC.md §6, #589 (sub-issue of #556): government-ID verification
// via Didit, the higher trust tier above the credit-card tier. This
// deployment (the e2e wrangler dev server, like the vitest suite) never
// configures DIDIT_API_KEY, so this only covers the UI surfacing the
// correct state and the 503-unconfigured path through the real button,
// not a real Didit round trip — that has no test double to drive here.
import {
  launchPage, finish, waitForText, openAccountMenu, clearVerifyModalIfShown,
} from './helpers.mjs';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';

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
// #1067: refreshAccountAuthUI (re-run on every account-auth-btn click,
// see that handler's own comment) now reconciles a stalled-pending Didit
// session on open instead of only ever picking one up via the
// ?diditReturn=1 redirect or a fresh poll — proven here by the status
// endpoint actually being called, not by a real approval (no Didit
// config in this deployment to drive one, per this file's own top
// comment).
const diditStatusRequest = page.waitForRequest('**/api/auth/didit-verification-status', { timeout: 5000 });
await page.click('#account-auth-btn');
await waitForText(page, '#account-auth-btn', 'Didit Suite');
await diditStatusRequest;

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

// #2405: the ?diditReturn=1 return leg assumed the browser landing on it
// still carries the session that started verification -- not guaranteed,
// since Didit's hosted flow supports a "continue on your phone" handoff.
// A fresh, cookie-free context (not the signed-in `page` above) stands in
// for that case: no session, landing directly on the return URL.
const returnContext = await browser.newContext({ viewport: { width: 420, height: 860 } });
const returnPage = await returnContext.newPage();
const returnErrors = [];
returnPage.on('pageerror', (err) => returnErrors.push(err.message));
returnPage.on('console', (msg) => { if (msg.type() === 'error') returnErrors.push(msg.text()); });
let diditStatusRequestedWithoutSession = false;
returnPage.on('request', (req) => {
  if (req.url().includes('/api/auth/didit-verification-status')) diditStatusRequestedWithoutSession = true;
});
await returnPage.goto(`${BASE_URL}/?diditReturn=1`, { waitUntil: 'networkidle' });
await returnPage.waitForSelector('#auth-modal.visible', { timeout: 8000 });
const loggedOutFormVisible = await returnPage.locator('#auth-logged-out').isVisible();
console.log('login form shown for a session-less ?diditReturn=1 landing (should be true):', loggedOutFormVisible);
const returnStatusText = await returnPage.textContent('#auth-status');
console.log('auth-status text for a session-less return (should ask the user to log in, not say "Checking..."):', returnStatusText.trim());
console.log('a poll of the session-gated status endpoint was skipped entirely (should be true):', !diditStatusRequestedWithoutSession);
await returnContext.close();

const pass = trustTierBeforeVerify.includes('Credit-card verified') &&
  verifyBtnVisible &&
  statusAfterClick.includes('not configured') &&
  loggedOutFormVisible &&
  returnStatusText.includes('Log in') &&
  !returnStatusText.includes('Checking verification status') &&
  !diditStatusRequestedWithoutSession &&
  unexpectedErrors.length === 0 &&
  returnErrors.length === 0;
await finish(browser, {
  pass,
  label: 'Didit government-ID verification (#589): account panel shows trust-tier status + Verify button, which surfaces the unconfigured-Didit error correctly; a session-less ?diditReturn=1 landing prompts login instead of polling forever (#2405)',
  errors: [...errors, ...returnErrors],
});
