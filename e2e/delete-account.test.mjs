// #1149 (sub-issue of #1145, real account deletion): covers the real
// Delete Account flow now wired into the Account panel (#auth-modal), as
// distinct from the Settings > Build/Sell "Reset Profile" buttons (see
// delete-builder-stale-id.test.mjs and friends), which only ever reset a
// builder/seller profile, never the login itself.
//
// Deliberately does NOT exercise the wrong-password-rejected path or the
// post-deletion "can the old email still log in" check through the UI --
// both are real 401s, and auth.test.mjs's own comment already documents
// why deliberately triggering one through the UI trips this suite's
// errors.length === 0 check (Chrome logs "Failed to load resource" for any
// non-2xx fetch regardless of whether the app handled it gracefully).
// Both are already covered at the API level by
// worker/account-deletion.test.js. This test covers what's genuinely
// UI-specific: the collapsed-behind-its-own-trigger reveal/cancel, and the
// full happy path flipping the panel back to logged-out.
import {
  launchPage, finish, waitForText, clearVerifyModalIfShown,
} from './helpers.mjs';

const { browser, page, errors } = await launchPage({ promptAnswer: 'Delete Account Suite' });
const email = `delete-account-suite-${Date.now()}@example.com`;
const password = 'a fine long password';

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
await page.fill('#auth-signup-username', 'Delete Account Suite');
await page.fill('#auth-signup-email', email);
await page.fill('#auth-signup-password', password);
await page.check('#auth-signup-age-attest');
await page.click('#auth-signup-form button[type="submit"]');
await waitForText(page, '#account-auth-btn', 'Delete Account Suite');
// #556: same gate chooseIdentity's own signup clears (see its own
// comment) -- this fresh account is logged in but not yet age/card-
// verified, and Shop mode's own concurrent gate (ensureShopperIdentity)
// opens #verify-modal for it right on top of everything else, blocking
// every later click in this test until cleared.
await clearVerifyModalIfShown(page);

// --- Open the account panel; Delete Account starts collapsed ---
await openAuthModal(page);
const deleteBtnVisibleBefore = await page.locator('#auth-delete-account-btn').isVisible();
const formHiddenBefore = await page.locator('#auth-delete-account-form').isHidden();
console.log('Delete Account trigger visible before any click (should be true):', deleteBtnVisibleBefore);
console.log('Confirmation form hidden before any click (should be true):', formHiddenBefore);

// --- Clicking it reveals the confirmation form, not an immediate action ---
await page.click('#auth-delete-account-btn');
await page.waitForSelector('#auth-delete-account-form:not([hidden])', { timeout: 5000 });
const triggerHiddenAfterOpen = await page.locator('#auth-delete-account-btn').isHidden();
console.log('Trigger hidden once the form is open (should be true):', triggerHiddenAfterOpen);

// --- Cancel backs out with no network call and no account change ---
await page.click('#auth-delete-account-cancel-btn');
// state: 'attached' (not the default 'visible') -- the form is always
// attached to the DOM and this selector specifically matches it once
// HIDDEN, which Playwright's default "wait for visible" can never
// satisfy (same gotcha chooseIdentity's own #auth-modal:not(.visible)
// wait documents avoiding).
await page.waitForSelector('#auth-delete-account-form[hidden]', { state: 'attached', timeout: 5000 });
const triggerVisibleAfterCancel = await page.locator('#auth-delete-account-btn').isVisible();
console.log('Trigger visible again after Cancel (should be true):', triggerVisibleAfterCancel);
const stillLoggedInAfterCancel = await waitForText(page, '#account-auth-btn', 'Delete Account Suite');
console.log('Still logged in after Cancel (should still show the username):', stillLoggedInAfterCancel);

// --- The real happy path: confirm with the correct password ---
await page.click('#auth-delete-account-btn');
await page.waitForSelector('#auth-delete-account-form:not([hidden])', { timeout: 5000 });
await page.fill('#auth-delete-account-password', password);
await page.click('#auth-delete-account-form button[type="submit"]');
const deletedStatus = await waitForText(page, '#auth-status', 'deleted', { timeout: 8000 });
console.log('Status after deleting (should confirm deletion):', deletedStatus);
const loggedOutLabel = await waitForText(page, '#account-auth-btn', 'Log In / Sign Up');
console.log('Account button after deletion (should be "Log In / Sign Up"):', loggedOutLabel);
const loggedOutViewVisible = await page.locator('#auth-logged-out').isVisible();
console.log('Panel flipped back to the logged-out login/signup view (should be true):', loggedOutViewVisible);

const pass = deleteBtnVisibleBefore &&
  formHiddenBefore &&
  triggerHiddenAfterOpen &&
  triggerVisibleAfterCancel &&
  stillLoggedInAfterCancel.includes('Delete Account Suite') &&
  deletedStatus.toLowerCase().includes('deleted') &&
  loggedOutLabel.includes('Log In / Sign Up') &&
  loggedOutViewVisible &&
  errors.length === 0;
await finish(browser, { pass, label: 'Delete Account in the Account panel revokes login end-to-end (#1146/#1149)', errors });
