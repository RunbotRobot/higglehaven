// #1182 (sub-issue of #1126): covers the real in-session Change Email form
// in the Account panel. Modeled directly on delete-account.test.mjs's own
// structure -- same collapsed-behind-its-own-trigger reveal/cancel check,
// plus the happy path confirming the displayed email and verified badge
// both update. Deliberately does NOT exercise the wrong-password-rejected
// or already-registered-email paths through the UI, for the same reason
// delete-account.test.mjs's own comment gives (a real 401/409 trips Chrome's
// "Failed to load resource" console-error regardless of handling) -- both
// are already covered at the API level by worker/account-change-email.test.js.
import {
  launchPage, finish, waitForText, clearVerifyModalIfShown,
} from './helpers.mjs';

const { browser, page, errors } = await launchPage({ promptAnswer: 'Change Email Suite' });
const email = `change-email-suite-${Date.now()}@example.com`;
const newEmail = `change-email-suite-new-${Date.now()}@example.com`;
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
await page.fill('#auth-signup-username', 'Change Email Suite');
await page.fill('#auth-signup-email', email);
await page.fill('#auth-signup-password', password);
await page.check('#auth-signup-age-attest');
await page.click('#auth-signup-form button[type="submit"]');
await waitForText(page, '#account-auth-btn', 'Change Email Suite');
await clearVerifyModalIfShown(page);

// --- Open the account panel; Change Email starts collapsed ---
await openAuthModal(page);
const changeBtnVisibleBefore = await page.locator('#auth-change-email-btn').isVisible();
const formHiddenBefore = await page.locator('#auth-change-email-form').isHidden();
console.log('Change Email trigger visible before any click (should be true):', changeBtnVisibleBefore);
console.log('Change Email form hidden before any click (should be true):', formHiddenBefore);
const emailBeforeChange = await page.locator('#auth-account-email').textContent();
console.log('Displayed email before change (should be the signup email):', emailBeforeChange);

// --- Clicking it reveals the form, not an immediate action ---
await page.click('#auth-change-email-btn');
await page.waitForSelector('#auth-change-email-form:not([hidden])', { timeout: 5000 });
const triggerHiddenAfterOpen = await page.locator('#auth-change-email-btn').isHidden();
console.log('Trigger hidden once the form is open (should be true):', triggerHiddenAfterOpen);

// --- Cancel backs out with no account change ---
await page.click('#auth-change-email-cancel-btn');
await page.waitForSelector('#auth-change-email-form[hidden]', { state: 'attached', timeout: 5000 });
const triggerVisibleAfterCancel = await page.locator('#auth-change-email-btn').isVisible();
console.log('Trigger visible again after Cancel (should be true):', triggerVisibleAfterCancel);
const emailAfterCancel = await page.locator('#auth-account-email').textContent();
console.log('Displayed email unchanged after Cancel (should match the original):', emailAfterCancel);

// --- The real happy path: confirm with the correct password ---
await page.click('#auth-change-email-btn');
await page.waitForSelector('#auth-change-email-form:not([hidden])', { timeout: 5000 });
await page.fill('#auth-change-email-new', newEmail);
await page.fill('#auth-change-email-password', password);
await page.click('#auth-change-email-form button[type="submit"]');
const changedStatus = await waitForText(page, '#auth-status', 'changed', { timeout: 8000 });
console.log('Status after changing (should confirm the change):', changedStatus);
const emailAfterChange = await waitForText(page, '#auth-account-email', newEmail);
console.log('Displayed email after change (should be the new address):', emailAfterChange);
const verifiedBadgeAfterChange = await page.locator('#auth-account-verified').textContent();
console.log('Verified badge after change (should read not-yet-verified):', verifiedBadgeAfterChange);

const pass = changeBtnVisibleBefore &&
  formHiddenBefore &&
  emailBeforeChange.includes(email) &&
  triggerHiddenAfterOpen &&
  triggerVisibleAfterCancel &&
  emailAfterCancel.includes(email) &&
  changedStatus.toLowerCase().includes('changed') &&
  emailAfterChange.includes(newEmail) &&
  !verifiedBadgeAfterChange.includes('✓') &&
  errors.length === 0;
await finish(browser, { pass, label: 'Change Email in the Account panel updates the displayed email end-to-end (#1182)', errors });
