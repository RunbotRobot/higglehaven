// #1149 (last leaf of #1145's "real full account deletion" tracking issue):
// wires the previously backend-only POST /api/auth/delete-account (#1146)
// up to a real "Delete Account" button under the Account menu, distinct
// from the pre-existing "Reset Builder/Seller Profile" buttons under
// Build/Sell Settings (renamed from "Delete Account" by this same issue,
// to stop the two very different actions sharing a label) — those only
// reset an in-world identity and leave the login active; this one revokes
// the login itself.
//
// Covers the frontend happy path: the button is behind its own password
// confirmation form (the backend itself requires the current password),
// submitting it signs the account out everywhere and leaves it unable to
// log back in. The wrong-password-rejection and can't-log-in-afterward
// cases are deliberately NOT exercised here the same way auth.test.mjs's
// own comment explains for its password-reset flow: a real 401 driven
// through the UI trips this suite's shared errors.length === 0 check
// (Chrome logs "Failed to load resource" for any non-2xx fetch, handled
// or not) — both are already covered server-side by
// worker/account-deletion.test.js.
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

// --- Sign up a real account to delete ---
await openAuthModal(page);
await page.click('.auth-tab-btn[data-auth-view="signup"]');
await page.fill('#auth-signup-username', 'Carla Suite');
await page.fill('#auth-signup-email', email);
await page.fill('#auth-signup-password', password);
await page.check('#auth-signup-age-attest');
await page.click('#auth-signup-form button[type="submit"]');
const btnLabelAfterSignup = await waitForText(page, '#account-auth-btn', 'Carla Suite');
console.log('account button after signup (should be "Carla Suite"):', btnLabelAfterSignup);
await clearVerifyModalIfShown(page);
await page.waitForTimeout(200);

await openAuthModal(page);
const deleteBtnVisibleBeforeClick = await page.locator('#auth-delete-account-btn').isVisible();
console.log('Delete Account button visible in the Account panel (should be true):', deleteBtnVisibleBeforeClick);

// --- Reveal the password-confirmation form ---
await page.click('#auth-delete-account-btn');
await page.waitForSelector('#auth-delete-account-form:not([hidden])', { timeout: 5000 });
const formVisibleAfterClick = await page.locator('#auth-delete-account-form').isVisible();
const plainBtnHiddenAfterClick = await page.locator('#auth-delete-account-btn').isHidden();
console.log('confirmation form visible after clicking Delete Account (should be true):', formVisibleAfterClick);
console.log('plain Delete Account button hidden once the form is up (should be true):', plainBtnHiddenAfterClick);

// --- Cancel brings back the plain button, not a dead end ---
await page.click('#auth-delete-account-cancel-btn');
const formHiddenAfterCancel = await page.locator('#auth-delete-account-form').isHidden();
const plainBtnVisibleAfterCancel = await page.locator('#auth-delete-account-btn').isVisible();
console.log('form hidden again after Cancel (should be true):', formHiddenAfterCancel);
console.log('plain Delete Account button back after Cancel (should be true):', plainBtnVisibleAfterCancel);

// --- For real this time: confirm with the correct password ---
await page.click('#auth-delete-account-btn');
await page.waitForSelector('#auth-delete-account-form:not([hidden])', { timeout: 5000 });
await page.fill('#auth-delete-account-password', password);
// launchPage's own dialog handler (helpers.mjs) auto-accepts the alert()
// the success path raises.
await page.click('#auth-delete-account-confirm-btn');
const btnLabelAfterDelete = await waitForText(page, '#account-auth-btn', 'Log In / Sign Up', { timeout: 10000 });
console.log('account button after real deletion (should be "Log In / Sign Up"):', btnLabelAfterDelete);

const pass = btnLabelAfterSignup === 'Carla Suite' &&
  deleteBtnVisibleBeforeClick &&
  formVisibleAfterClick && plainBtnHiddenAfterClick &&
  formHiddenAfterCancel && plainBtnVisibleAfterCancel &&
  btnLabelAfterDelete === 'Log In / Sign Up' &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: 'Real account deletion (#1149): the Account menu\'s own Delete Account button, behind a password-confirmation form, signs the account out for good',
  errors,
});
