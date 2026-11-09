// Regression test for #740: renderBuilderIdentityField's Delete Account
// confirm() dialog never disclosed that a real-money-backed higgles balance
// is forfeited along with the account -- DELETE /api/builders/:id hard-
// deletes the builder row (and its higgles_balance_cents) with no guard and
// no warning specific to that loss. Fixed by making deleteWarning a function
// of the current profile, appending a "you'll also forfeit your $X.XX
// higgles balance" note whenever the balance is nonzero.
//
// Verified here by capturing the real window.confirm() dialog's own message
// text (a second `page.on('dialog', ...)` listener alongside launchPage's
// own auto-accepting one -- see helpers.mjs) rather than anything on-screen,
// since the dialog text itself is exactly what the fix changes.
import {
  launchPage, chooseIdentity, claimLandlet, openAccountMenu, grantHigglesAsAdmin, finish, acceptConfirmModal } from './helpers.mjs';

const LABEL = 'Delete Balance Warning Tester';
const GRANTED_CENTS = 12345; // $123.45

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

const builderId = await page.evaluate(() =>
  fetch('/api/builders/me').then((r) => r.json()).then((d) => d.builder.builderId));
await grantHigglesAsAdmin(builderId, GRANTED_CENTS);

let dialogMessage = null; // #3278: now the in-app confirm modal's own message text

await openAccountMenu(page);
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
// #1149 renamed this button from "Delete Account" to "Reset Profile" --
// the confirm() dialog text this test checks (via dialogMessage below) is
// unaffected since the balance-forfeit note is appended after the
// (now-updated) opening sentence either way.
await page.click('#settings-section button:has-text("Reset Profile")');
// #3278: the confirm is the shared in-app modal now; read its message, then
// accept it, and give the delete's own async follow-up (fetchProfile/
// renderName) time to settle.
dialogMessage = await acceptConfirmModal(page);
await page.waitForTimeout(1200);

console.log(`Delete-account confirm dialog text (should mention the $${(GRANTED_CENTS / 100).toFixed(2)} higgles balance):`, dialogMessage);

const pass = dialogMessage !== null &&
  dialogMessage.includes(`$${(GRANTED_CENTS / 100).toFixed(2)}`) &&
  dialogMessage.toLowerCase().includes('forfeit') &&
  errors.length === 0;
await finish(browser, { pass, label: "Deleting a builder account with a real higgles balance discloses the amount forfeited (#740)", errors });
