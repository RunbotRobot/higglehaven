// #1181 (sub-issue of #1126): covers the real Change Password flow now
// wired into the Account panel (#auth-modal), separate from the
// forgot-password email-link flow (auth.test.mjs already covers that).
//
// Deliberately does NOT exercise the wrong-password-rejected path through
// the UI -- a real 401, which Chrome logs as "Failed to load resource"
// regardless of whether the app handled it gracefully, tripping this
// suite's errors.length === 0 check (same reasoning delete-account.test.mjs's
// own comment documents). That path is already covered at the API level by
// worker/change-password.test.js. This test covers what's genuinely
// UI-specific: the collapsed-behind-its-own-trigger reveal/cancel, and the
// happy path's status message.
import {
  launchPage, finish, waitForText, clearVerifyModalIfShown,
} from './helpers.mjs';

const { browser, page, errors } = await launchPage({ promptAnswer: 'Change Password Suite' });
const email = `change-password-suite-${Date.now()}@example.com`;
const password = 'a fine long password';
const newPassword = 'a different fine long password';

async function openAuthModal(page) {
  if ((await page.locator('#auth-modal.visible').count()) > 0) return;
  await page.click('#account-menu-toggle');
  await page.waitForSelector('#account-menu-panel.expanded', { timeout: 5000 });
  await page.click('#account-auth-btn');
  await page.waitForSelector('#auth-modal.visible', { timeout: 5000 });
}

// --- Sign up ---
await openAuthModal(page);
await page.click('.auth-tab-btn[data-auth-view="signup"]');
await page.fill('#auth-signup-username', 'Change Password Suite');
await page.fill('#auth-signup-email', email);
await page.fill('#auth-signup-password', password);
await page.check('#auth-signup-age-attest');
await page.click('#auth-signup-form button[type="submit"]');
await waitForText(page, '#account-auth-btn', 'Change Password Suite');
await clearVerifyModalIfShown(page);

// --- Open the account panel; Change Password starts collapsed ---
await openAuthModal(page);
const changeBtnVisibleBefore = await page.locator('#auth-change-password-btn').isVisible();
const formHiddenBefore = await page.locator('#auth-change-password-form').isHidden();
console.log('Change Password trigger visible before any click (should be true):', changeBtnVisibleBefore);
console.log('Change Password form hidden before any click (should be true):', formHiddenBefore);

// --- Clicking it reveals the form, not an immediate action ---
await page.click('#auth-change-password-btn');
await page.waitForSelector('#auth-change-password-form:not([hidden])', { timeout: 5000 });
const triggerHiddenAfterOpen = await page.locator('#auth-change-password-btn').isHidden();
console.log('Trigger hidden once the form is open (should be true):', triggerHiddenAfterOpen);

// --- Cancel backs out with no network call and no account change ---
await page.click('#auth-change-password-cancel-btn');
await page.waitForSelector('#auth-change-password-form[hidden]', { state: 'attached', timeout: 5000 });
const triggerVisibleAfterCancel = await page.locator('#auth-change-password-btn').isVisible();
console.log('Trigger visible again after Cancel (should be true):', triggerVisibleAfterCancel);
const stillLoggedInAfterCancel = await waitForText(page, '#account-auth-btn', 'Change Password Suite');
console.log('Still logged in after Cancel (should still show the username):', stillLoggedInAfterCancel);

// --- The real happy path: confirm with the correct current password ---
await page.click('#auth-change-password-btn');
await page.waitForSelector('#auth-change-password-form:not([hidden])', { timeout: 5000 });
await page.fill('#auth-change-password-current', password);
await page.fill('#auth-change-password-new', newPassword);
await page.click('#auth-change-password-form button[type="submit"]');
const changedStatus = await waitForText(page, '#auth-status', 'changed', { timeout: 8000 });
console.log('Status after changing (should confirm the change):', changedStatus);
// Changing the password keeps the current session logged in (see
// worker/index.js's handleChangePassword comment on why) -- unlike
// delete-account, the panel should still show the logged-in view.
const stillLoggedInAfterChange = await page.locator('#account-auth-btn').textContent();
console.log('Still logged in after changing password (should show the username):', stillLoggedInAfterChange);

const pass = changeBtnVisibleBefore &&
  formHiddenBefore &&
  triggerHiddenAfterOpen &&
  triggerVisibleAfterCancel &&
  stillLoggedInAfterCancel.includes('Change Password Suite') &&
  changedStatus.toLowerCase().includes('changed') &&
  stillLoggedInAfterChange.includes('Change Password Suite') &&
  errors.length === 0;
await finish(browser, { pass, label: 'Change Password in the Account panel updates login in-session (#1181)', errors });
