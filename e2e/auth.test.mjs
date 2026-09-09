// Real account login (docs/API.md's "Authentication") — the first
// genuinely unforgeable identity in this app, deliberately independent of
// the dev-mode builder/seller identity picker covered elsewhere. Covers
// the full real-UI signup -> verify-email-link -> logout -> login and
// forgot-password -> reset-link -> reset -> login-with-new-password loops,
// driven entirely through #account-auth-btn/#auth-modal, the same way a
// real visitor would use it. The test environment never configures
// RESEND_API_KEY (see sendEmail's own comment in worker/index.js), so
// every verify/reset link is read back from the UI's own dev-mode status
// text (`devVerifyUrl`/`devResetUrl`) rather than a real inbox. The old
// password being rejected after a reset is intentionally NOT re-checked
// here — worker/reviews-auth.test.js's own "Authentication" describe block
// already covers it, and deliberately triggering a real 401 through the
// UI would trip this file's own errors.length === 0 check (Chrome logs
// "Failed to load resource" for any non-2xx fetch response, regardless of
// whether the app itself handled it gracefully) — the same reasoning
// other rejection-path tests already document avoiding elsewhere in this
// suite.
import {
  launchPage, finish, waitForText, clearVerifyModalIfShown,
} from './helpers.mjs';

const { browser, page, errors } = await launchPage({ promptAnswer: 'Auth Suite' });
const email = `auth-suite-${Date.now()}@example.com`;
const password = 'a fine long password';

async function openAuthModal(page) {
  await page.click('#account-menu-toggle');
  await page.waitForSelector('#account-menu-panel.expanded', { timeout: 5000 });
  await page.click('#account-auth-btn');
  await page.waitForSelector('#auth-modal.visible', { timeout: 5000 });
}

// --- Sign up (dev-mode fallback surfaces the verify link in #auth-status) ---
await openAuthModal(page);
await page.click('.auth-tab-btn[data-auth-view="signup"]');
await page.fill('#auth-signup-username', 'Ada Suite');
await page.fill('#auth-signup-email', email);
await page.fill('#auth-signup-password', password);
await page.check('#auth-signup-age-attest');
await page.click('#auth-signup-form button[type="submit"]');
const signupStatus = await waitForText(page, '#auth-status', 'dev mode');

console.log('signup dev-mode status (should mention a verify link):', signupStatus);
const verifyUrlMatch = signupStatus.match(/(http\S+verifyEmail=[0-9a-f]+)/);
const btnLabelAfterSignup = await waitForText(page, '#account-auth-btn', 'Ada Suite');
console.log('account button after signup (should be "Ada Suite"):', btnLabelAfterSignup);
await page.click('#auth-close-btn');
await page.waitForTimeout(200);

// --- Visiting the verify-email link marks the account verified ---
await page.goto(verifyUrlMatch[1]);
const verifyStatus = await waitForText(page, '#auth-status', 'Email verified!');
console.log('status after visiting the verify link (should say Email verified!):', verifyStatus);
const urlAfterVerify = page.url();
console.log('URL stripped of the verifyEmail query param (should have no "?"):', urlAfterVerify);
await page.click('#auth-close-btn');
await page.waitForTimeout(200);

await openAuthModal(page);
const verifiedText = await page.textContent('#auth-account-verified');
console.log('verified status shown in the account panel (should say verified):', verifiedText);
await page.click('#auth-logout-btn');
const btnLabelAfterLogout = await waitForText(page, '#account-auth-btn', 'Log In / Sign Up');
console.log('account button after logout (should be "Log In / Sign Up"):', btnLabelAfterLogout);

// --- Log back in with the real password ---
await openAuthModal(page);
await page.fill('#auth-login-email', email);
await page.fill('#auth-login-password', password);
await page.click('#auth-login-form button[type="submit"]');
const btnLabelAfterLogin = await waitForText(page, '#account-auth-btn', 'Ada Suite');
console.log('account button after logging back in (should be "Ada Suite"):', btnLabelAfterLogin);
// Login success closes the modal (see the login form's own submit
// handler), so it needs reopening before the logout button is reachable.
await openAuthModal(page);
await page.click('#auth-logout-btn');
await waitForText(page, '#account-auth-btn', 'Log In / Sign Up');

// --- Forgot password -> reset link -> new password works, old one doesn't ---
await openAuthModal(page);
await page.click('#auth-forgot-btn');
await page.fill('#auth-forgot-email', email);
await page.click('#auth-forgot-form button[type="submit"]');
const forgotStatus = await waitForText(page, '#auth-status', 'dev mode');
console.log('forgot-password dev-mode status (should mention a reset link):', forgotStatus);
const resetUrlMatch = forgotStatus.match(/(http\S+resetPassword=[0-9a-f]+)/);
await page.click('#auth-close-btn');
await page.waitForTimeout(200);

await page.goto(resetUrlMatch[1]);
await page.waitForTimeout(1000);
const resetFormVisible = await page.locator('#auth-reset-form').isVisible();
console.log('reset-password form visible after following the link (should be true):', resetFormVisible);
const newPassword = 'a totally new password';
await page.fill('#auth-reset-password', newPassword);
await page.click('#auth-reset-form button[type="submit"]');
const resetStatus = await waitForText(page, '#auth-status', 'Password reset!');
console.log('status after resetting (should say Password reset!):', resetStatus);

// The old password now being rejected is covered by worker/reviews-auth.test.js's
// own "Authentication" describe block instead of here — a real 401 from a
// deliberately-wrong login attempt would trip this suite's shared
// errors.length === 0 check (Chrome logs "Failed to load resource" for any
// non-2xx fetch, whether or not the app handled it gracefully), the same
// reason "Product reviews"/purchase-refund rejection paths document
// avoiding this elsewhere in the e2e suite (see docs/API.md).
await page.fill('#auth-login-email', email);
await page.fill('#auth-login-password', newPassword);
await page.click('#auth-login-form button[type="submit"]');
const btnLabelAfterNewPasswordLogin = await waitForText(page, '#account-auth-btn', 'Ada Suite');
console.log('account button after logging in with the NEW password (should be "Ada Suite"):', btnLabelAfterNewPasswordLogin);

// --- #432: logging out must not leave a stale sellerId cached for the
// next account that logs in ---
// #540 made Sell a genuine currentMode (a real reload + bootstrap() on
// entry, like Build/Shop always had) rather than a modal overlay with no
// mode transition at all — so this logout, right after visiting Sell,
// takes the reload-into-Shop path (see authLogoutBtn's own comment)
// rather than #432's original no-reload Shop-mode case. Either way the
// same identity-reset guarantee is what's under test here.
const firstSellerFetch = page.waitForResponse((r) => r.url().includes('/api/sellers/me') && r.request().method() === 'GET');
await page.click('.mode-nav-btn[data-mode="sell"]');
// #556: this account signed up through the auth modal directly above, not
// through chooseIdentity — clear the age/credit-card verify gate the same
// way that helper does, or the /sellers/me fetch below never fires.
await clearVerifyModalIfShown(page);
await firstSellerFetch;
const sellerStatusForFirstAccount = await waitForText(page, '#seller-status', 'No custom products yet');
console.log('seller status for the first account (should say no products yet):', sellerStatusForFirstAccount);
await page.click('#seller-close-btn');
await page.waitForTimeout(200);

await openAuthModal(page);
await page.click('#auth-logout-btn');
await waitForText(page, '#account-auth-btn', 'Log In / Sign Up');

const secondEmail = `auth-suite-second-${Date.now()}@example.com`;
await openAuthModal(page);
await page.click('.auth-tab-btn[data-auth-view="signup"]');
await page.fill('#auth-signup-username', 'Bea Suite');
await page.fill('#auth-signup-email', secondEmail);
await page.fill('#auth-signup-password', 'a different fine password');
await page.check('#auth-signup-age-attest');
await page.click('#auth-signup-form button[type="submit"]');
const btnLabelAfterSecondSignup = await waitForText(page, '#account-auth-btn', 'Bea Suite');
console.log('account button after the second account signs up (should be "Bea Suite"):', btnLabelAfterSecondSignup);
await page.click('#auth-close-btn');
await page.waitForTimeout(200);

// If sellerId were still cached from the first account, ensureSellerIdentity
// would short-circuit and this second GET would never fire at all.
// Registered before the click (not after clearVerifyModalIfShown) so
// there's no gap where the real fetch could fire before this is listening
// — #556's verify-modal round trip (confirmCard() resolving, then
// notifyVerifyResult letting ensureSellerIdentity's own fetchMySeller()
// proceed) happens between page.click() returning and the modal actually
// closing, entirely inside clearVerifyModalIfShown, so a promise
// registered only after it returns could already have missed the fetch.
// Timeout bumped from the original 5000ms to comfortably cover that round
// trip on top of the fetch itself.
const secondSellerFetch = page.waitForResponse((r) => r.url().includes('/api/sellers/me') && r.request().method() === 'GET', { timeout: 10000 });
await page.click('.mode-nav-btn[data-mode="sell"]');
await clearVerifyModalIfShown(page);
let sellerRefetchedForSecondAccount = true;
try {
  await secondSellerFetch;
} catch {
  sellerRefetchedForSecondAccount = false;
}
console.log('a fresh /sellers/me GET fired for the second account (should be true — a stale cache would skip it):', sellerRefetchedForSecondAccount);
const sellerStatusForSecondAccount = await waitForText(page, '#seller-status', 'No custom products yet');
console.log('seller status for the second account (should say no products yet, not the first account\'s list):', sellerStatusForSecondAccount);
await page.click('#seller-close-btn');

const pass = signupStatus.includes('dev mode') && !!verifyUrlMatch &&
  btnLabelAfterSignup === 'Ada Suite' &&
  verifyStatus.includes('Email verified!') &&
  !urlAfterVerify.includes('?') &&
  verifiedText.includes('verified') && !verifiedText.includes('not verified') &&
  btnLabelAfterLogout === 'Log In / Sign Up' &&
  btnLabelAfterLogin === 'Ada Suite' &&
  !!resetUrlMatch && resetFormVisible &&
  resetStatus.includes('Password reset!') &&
  btnLabelAfterNewPasswordLogin === 'Ada Suite' &&
  sellerStatusForFirstAccount.includes('No custom products yet') &&
  btnLabelAfterSecondSignup === 'Bea Suite' &&
  sellerRefetchedForSecondAccount &&
  sellerStatusForSecondAccount.includes('No custom products yet') &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: 'Authentication: signup + verify-email link + logout/login + forgot/reset password + no stale sellerId leak across a Shop-mode logout (#432)',
  errors,
});
