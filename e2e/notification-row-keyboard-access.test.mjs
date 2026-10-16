// #2329: appendNotificationRow (src/main.js) rendered each unread
// notification as a plain click-only <div> with no role, tabindex, or
// keydown handler -- the only such element in this file reachable by mouse
// but not by keyboard, unlike every other interactive control (including
// the adjacent "Mark all read" button), which are real <button>s. Fixed by
// adding role="button"/tabindex="0" plus an Enter/Space keydown handler
// that calls the same mark-read logic the click listener already uses.
//
// Two independent browser pages stand in for two different builders (same
// pattern e2e/notification-row-mark-read-listener.test.mjs already uses),
// since a real notification needs a real second party to trigger it.
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, waitForText, finish } from './helpers.mjs';

const ALICE = 'Notification Keyboard Suite Alice';
const BOB = 'Notification Keyboard Suite Bob';

const aliceSession = await launchPage({ promptAnswer: ALICE });
const bobSession = await launchPage({ promptAnswer: BOB });
const errors = [...aliceSession.errors, ...bobSession.errors];

const alicePage = aliceSession.page;
const bobPage = bobSession.page;

await chooseIdentity(alicePage, { mode: 'build', label: ALICE, isNew: true });
await claimLandlet(alicePage);
await chooseIdentity(bobPage, { mode: 'build', label: BOB, isNew: true });
await claimLandlet(bobPage);

// Alice sends Bob a friend request -- fires a real notification for Bob
// (same flow as e2e/friends.test.mjs / notification-row-mark-read-listener).
await openAccountMenu(alicePage);
await alicePage.click('#friends-btn');
await alicePage.waitForSelector('#friends-modal.visible', { timeout: 5000 });
alicePage.removeAllListeners('dialog');
alicePage.on('dialog', (dialog) => dialog.accept(BOB));
await alicePage.click('#friends-add-btn');
await waitForText(alicePage, '#friends-status', BOB);
await alicePage.click('#friends-close-btn');

await openAccountMenu(bobPage);
await bobPage.click('#notifications-btn');
await bobPage.waitForSelector('#notifications-modal.visible', { timeout: 5000 });
await bobPage.waitForFunction(
  () => document.querySelectorAll('#notifications-list .notification-row.unread').length > 0,
  { timeout: 10000 },
);

const notificationRow = () => bobPage.locator('#notifications-list .notification-row').filter({ hasText: ALICE });

const roleBeforeAttrs = await notificationRow().evaluate((el) => ({
  role: el.getAttribute('role'),
  tabindex: el.getAttribute('tabindex'),
  ariaLabel: el.getAttribute('aria-label'),
}));
console.log('unread row exposes role="button"/tabindex="0"/an aria-label before any interaction:', roleBeforeAttrs);

// Focus the row directly (real Tab-order traversal through the whole
// notifications panel is brittle across unrelated DOM changes -- the same
// reasoning other keyboard-access tests in this suite use) and activate it
// with Enter, exactly as a keyboard-only user would once focused.
await notificationRow().focus();
const isFocused = await notificationRow().evaluate((el) => el === document.activeElement);
console.log('row is focusable via its tabindex (should be true):', isFocused);

await bobPage.keyboard.press('Enter');
await bobPage.waitForFunction(
  (name) => {
    const row = [...document.querySelectorAll('#notifications-list .notification-row')].find((r) => r.textContent.includes(name));
    return !!row && !row.classList.contains('unread');
  },
  ALICE,
  { timeout: 5000 },
);
console.log('row marked read via keyboard Enter alone, no click (should be true by now -- waited above)');

const roleAfterAttrs = await notificationRow().evaluate((el) => ({
  role: el.getAttribute('role'),
  tabindex: el.getAttribute('tabindex'),
}));
console.log('role/tabindex removed once read, matching the click path\'s own listener cleanup:', roleAfterAttrs);

const unexpectedErrors = errors;
const pass = roleBeforeAttrs.role === 'button' &&
  roleBeforeAttrs.tabindex === '0' &&
  !!roleBeforeAttrs.ariaLabel &&
  isFocused === true &&
  roleAfterAttrs.role === null &&
  roleAfterAttrs.tabindex === null &&
  unexpectedErrors.length === 0;
await bobSession.browser.close();
await finish(aliceSession.browser, {
  pass,
  label: '#2329: an unread notification row is keyboard-focusable and Enter marks it read, not mouse-only',
  errors,
});
