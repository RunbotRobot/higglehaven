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
// here — worker/index.test.js's own "Authentication" describe block
// already covers it, and deliberately triggering a real 401 through the
// UI would trip this file's own errors.length === 0 check (Chrome logs
// "Failed to load resource" for any non-2xx fetch response, regardless of
// whether the app itself handled it gracefully) — the same reasoning
// other rejection-path tests already document avoiding elsewhere in this
// suite.
import { launchPage, finish } from './helpers.mjs';

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
await page.click('#auth-signup-form button[type="submit"]');
await page.waitForTimeout(500);

const signupStatus = await page.textContent('#auth-status');
console.log('signup dev-mode status (should mention a verify link):', signupStatus);
const verifyUrlMatch = signupStatus.match(/(http\S+verifyEmail=[0-9a-f]+)/);
const btnLabelAfterSignup = await page.textContent('#account-auth-btn');
console.log('account button after signup (should be "Ada Suite"):', btnLabelAfterSignup);
await page.click('#auth-close-btn');
await page.waitForTimeout(200);

// --- Visiting the verify-email link marks the account verified ---
await page.goto(verifyUrlMatch[1]);
await page.waitForTimeout(1200);
const verifyStatus = await page.textContent('#auth-status');
console.log('status after visiting the verify link (should say Email verified!):', verifyStatus);
const urlAfterVerify = page.url();
console.log('URL stripped of the verifyEmail query param (should have no "?"):', urlAfterVerify);
await page.click('#auth-close-btn');
await page.waitForTimeout(200);

await openAuthModal(page);
const verifiedText = await page.textContent('#auth-account-verified');
console.log('verified status shown in the account panel (should say verified):', verifiedText);
await page.click('#auth-logout-btn');
await page.waitForTimeout(300);
const btnLabelAfterLogout = await page.textContent('#account-auth-btn');
console.log('account button after logout (should be "Log In"):', btnLabelAfterLogout);

// --- Log back in with the real password ---
await openAuthModal(page);
await page.fill('#auth-login-email', email);
await page.fill('#auth-login-password', password);
await page.click('#auth-login-form button[type="submit"]');
await page.waitForTimeout(500);
const btnLabelAfterLogin = await page.textContent('#account-auth-btn');
console.log('account button after logging back in (should be "Ada Suite"):', btnLabelAfterLogin);
// Login success closes the modal (see the login form's own submit
// handler), so it needs reopening before the logout button is reachable.
await openAuthModal(page);
await page.click('#auth-logout-btn');
await page.waitForTimeout(300);

// --- Forgot password -> reset link -> new password works, old one doesn't ---
await openAuthModal(page);
await page.click('#auth-forgot-btn');
await page.fill('#auth-forgot-email', email);
await page.click('#auth-forgot-form button[type="submit"]');
await page.waitForTimeout(500);
const forgotStatus = await page.textContent('#auth-status');
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
await page.waitForTimeout(500);
const resetStatus = await page.textContent('#auth-status');
console.log('status after resetting (should say Password reset!):', resetStatus);

// The old password now being rejected is covered by worker/index.test.js's
// own "Authentication" describe block instead of here — a real 401 from a
// deliberately-wrong login attempt would trip this suite's shared
// errors.length === 0 check (Chrome logs "Failed to load resource" for any
// non-2xx fetch, whether or not the app handled it gracefully), the same
// reason "Product reviews"/purchase-refund rejection paths document
// avoiding this elsewhere in the e2e suite (see docs/API.md).
await page.fill('#auth-login-email', email);
await page.fill('#auth-login-password', newPassword);
await page.click('#auth-login-form button[type="submit"]');
await page.waitForTimeout(400);
const btnLabelAfterNewPasswordLogin = await page.textContent('#account-auth-btn');
console.log('account button after logging in with the NEW password (should be "Ada Suite"):', btnLabelAfterNewPasswordLogin);

const pass = signupStatus.includes('dev mode') && !!verifyUrlMatch &&
  btnLabelAfterSignup === 'Ada Suite' &&
  verifyStatus.includes('Email verified!') &&
  !urlAfterVerify.includes('?') &&
  verifiedText.includes('verified') && !verifiedText.includes('not verified') &&
  btnLabelAfterLogout === 'Log In' &&
  btnLabelAfterLogin === 'Ada Suite' &&
  !!resetUrlMatch && resetFormVisible &&
  resetStatus.includes('Password reset!') &&
  btnLabelAfterNewPasswordLogin === 'Ada Suite' &&
  errors.length === 0;
await finish(browser, { pass, label: 'Authentication: signup + verify-email link + logout/login + forgot/reset password', errors });
