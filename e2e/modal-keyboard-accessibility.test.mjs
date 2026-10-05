// #1316: modals get real keyboard accessibility via the shared
// openModalA11y/closeModalA11y helpers in src/main.js (role="dialog"/
// aria-modal="true" are set in index.html) — focus moves into the dialog
// on open, Escape closes it, Tab/Shift+Tab is trapped inside it, and focus
// is restored to whatever opened it once it closes. Exercised through the
// Settings modal: reachable with no login required (openAccountMenu +
// #settings-btn), unlike most of the other modals this fix touches.
import { launchPage, finish, openAccountMenu, chooseIdentity } from './helpers.mjs';

const LABEL = 'Modal A11y Suite';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

// Shop mode (the default landing mode) now gates entry behind a real
// account too (N44) — a fresh page load opens #auth-modal before
// #account-menu-toggle is reachable at all.
await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });
await openAccountMenu(page);
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });

const role = await page.getAttribute('#settings-modal', 'role');
const ariaModal = await page.getAttribute('#settings-modal', 'aria-modal');
console.log('Settings modal role (should be dialog):', role);
console.log('Settings modal aria-modal (should be true):', ariaModal);

const focusInsideModalOnOpen = await page.evaluate(() =>
  document.getElementById('settings-modal').contains(document.activeElement));
console.log('Focus moved inside the modal on open (should be true):', focusInsideModalOnOpen);

await page.keyboard.press('Escape');
await page.waitForSelector('#settings-modal:not(.visible)', { state: 'attached', timeout: 5000 });
const closedViaEscape = (await page.locator('#settings-modal.visible').count()) === 0;
console.log('Escape closed the modal (should be true):', closedViaEscape);

// Not #settings-btn itself: clicking it also auto-collapses the
// account-menu panel it lives in (see openAccountMenu's own comment
// above), hiding that exact button the instant it's clicked — so the
// real, useful landing spot once the modal closes is the toggle that
// controls the panel, which closeModalA11y falls back to for exactly
// this reason.
const focusRestoredToTrigger = await page.evaluate(() => document.activeElement?.id === 'account-menu-toggle');
console.log('Focus restored to the account-menu toggle after closing (should be true):', focusRestoredToTrigger);

// Reopen to check the Tab focus trap wraps around rather than escaping
// into the page behind the modal. The account menu panel auto-collapses
// on the first #settings-btn click (see openAccountMenu's own comment), so
// it needs expanding again before that button is clickable a second time.
await openAccountMenu(page);
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
// Focus should already be on the modal's first focusable element (per
// openModalA11y) — Shift+Tab from there should wrap to the LAST focusable
// element inside the modal, never escape to something behind it.
await page.keyboard.press('Shift+Tab');
const wrappedInsideModal = await page.evaluate(() =>
  document.getElementById('settings-modal').contains(document.activeElement));
console.log('Shift+Tab from the first focusable element stays trapped inside the modal (should be true):', wrappedInsideModal);

const pass = role === 'dialog' &&
  ariaModal === 'true' &&
  focusInsideModalOnOpen &&
  closedViaEscape &&
  focusRestoredToTrigger &&
  wrappedInsideModal &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: 'Modals get real keyboard accessibility: role/aria-modal, focus management, Escape-to-close, Tab trap (#1316)',
  errors,
});
