// #1960: appendNotificationRow (src/main.js) attached a "mark read on
// click" listener only when a notification started unread, but never
// removed that listener once the click succeeded -- a second click on the
// same now-read row (double-click, re-clicking out of habit) re-fired
// markNotificationRead's own PATCH against the server. The server itself
// handles the repeat idempotently, but it still counts against
// NOTIFICATION_MUTATE_RATE_LIMIT_MAX (worker/index.js) the same as a
// genuinely new mutation, so repeated clicks could burn through that
// budget for no real reason.
//
// Two independent browser pages stand in for two different builders (same
// pattern e2e/friends.test.mjs already uses), since a real notification
// needs a real second party to trigger it -- Alice sending Bob a friend
// request is the simplest existing seam that fires one (fireNotification,
// worker/index.js), with no claimed landlet or accepted friendship needed
// first.
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, waitForText, finish } from './helpers.mjs';

const ALICE = 'Notification Listener Suite Alice';
const BOB = 'Notification Listener Suite Bob';

const aliceSession = await launchPage({ promptAnswer: ALICE });
const bobSession = await launchPage({ promptAnswer: BOB });
const errors = [...aliceSession.errors, ...bobSession.errors];

const alicePage = aliceSession.page;
const bobPage = bobSession.page;

await chooseIdentity(alicePage, { mode: 'build', label: ALICE, isNew: true });
await claimLandlet(alicePage);
await chooseIdentity(bobPage, { mode: 'build', label: BOB, isNew: true });
await claimLandlet(bobPage);

// Alice sends Bob a friend request through the real "+ Add Friend" prompt
// -- fires a real notification for Bob (same flow as e2e/friends.test.mjs).
await openAccountMenu(alicePage);
await alicePage.click('#friends-btn');
await alicePage.waitForSelector('#friends-modal.visible', { timeout: 5000 });
alicePage.removeAllListeners('dialog');
alicePage.on('dialog', (dialog) => dialog.accept(BOB));
await alicePage.click('#friends-add-btn');
await waitForText(alicePage, '#friends-status', BOB);
await alicePage.click('#friends-close-btn');

// Count every PATCH to /api/notifications/:id Bob's page sends, so a
// second click's redundant request is visible even though the server
// itself answers it idempotently either way.
let markReadRequestCount = 0;
await bobPage.route('**/api/notifications/*', async (route) => {
  if (route.request().method() === 'PATCH') markReadRequestCount += 1;
  await route.continue();
});

await openAccountMenu(bobPage);
await bobPage.click('#notifications-btn');
await bobPage.waitForSelector('#notifications-modal.visible', { timeout: 5000 });
// #2637 (sub-issue of #2635): waitForFunction's signature is (pageFunction,
// arg, options) -- a bare (fn, { timeout }) call puts the options object in
// the `arg` slot instead, so `options` stayed undefined and the real applied
// timeout was always Playwright's actual default (30000ms), never the
// smaller number written here. The explicit `null` arg reaches the options
// slot, and the timeout itself is widened to 60000ms for real headroom under
// CI load, same margin #2636's own sibling leaf used for its own 10000ms cases.
await bobPage.waitForFunction(
  () => document.querySelectorAll('#notifications-list .notification-row.unread').length > 0,
  null,
  { timeout: 60000 },
);
const notificationRow = () => bobPage.locator('#notifications-list .notification-row').filter({ hasText: ALICE });
const unreadCountBefore = await notificationRow().count();
console.log("Bob has an unread notification about Alice's friend request before any click (should be 1):", unreadCountBefore);

await notificationRow().click();
await bobPage.waitForFunction(
  (name) => {
    const row = [...document.querySelectorAll('#notifications-list .notification-row')].find((r) => r.textContent.includes(name));
    return !!row && !row.classList.contains('unread');
  },
  ALICE,
  { timeout: 5000 },
);
console.log('mark-read PATCH requests sent after the first click (should be 1):', markReadRequestCount);

// Second click on the now-read row: before the fix this re-fired the same
// listener (never removed) and sent a second PATCH; with the fix, the
// listener was removed right after the first click succeeded, so this
// click is now plain and inert.
await notificationRow().click();
await bobPage.waitForTimeout(500);
console.log('mark-read PATCH requests sent after a second click on the already-read row (should still be 1):', markReadRequestCount);

const pass = unreadCountBefore === 1 &&
  markReadRequestCount === 1 &&
  errors.length === 0;
await bobSession.browser.close();
await finish(aliceSession.browser, {
  pass,
  label: "#1960: a read notification row's click listener is removed, not left to re-fire on a second click",
  errors,
});
