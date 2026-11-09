// #3280: "Clear read" in the Notices panel removes every notice already read,
// after a confirmation in the in-app modal (#3278), and never touches unread
// ones. Same two-party setup as e2e/notification-delete.test.mjs (Alice's
// friend request fires Bob's real notification), at the default phone viewport.
// Steps: the notice starts unread, so Clear read + confirm leaves it (and
// removes nothing); after it is marked read, Never mind keeps it; confirming
// removes it, the empty message returns, and it is gone server-side.
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, waitForText, finish } from './helpers.mjs';

const ALICE = 'Notification Clear Suite Alice';
const BOB = 'Notification Clear Suite Bob';

const aliceSession = await launchPage({ promptAnswer: ALICE });
const bobSession = await launchPage({ promptAnswer: BOB });
const alicePage = aliceSession.page;
const bobPage = bobSession.page;

await chooseIdentity(alicePage, { mode: 'build', label: ALICE, isNew: true });
await claimLandlet(alicePage);
await chooseIdentity(bobPage, { mode: 'build', label: BOB, isNew: true });
await claimLandlet(bobPage);

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
  null,
  { timeout: 60000 },
);

const rowCount = () => bobPage.locator('#notifications-list .notification-row').count();
const serverCount = () => bobPage.evaluate(async () => (await (await fetch('/api/notifications')).json()).notifications.length);
const confirmVisible = () => bobPage.locator('#confirm-modal.visible').count();

// 1. Unread notice: Clear read confirms, then removes nothing.
const initial = await rowCount();
await bobPage.click('#notifications-clear-read-btn');
await bobPage.waitForSelector('#confirm-modal.visible', { timeout: 5000 });
const titleText = await bobPage.textContent('#confirm-modal-title');
const messageText = await bobPage.textContent('#confirm-modal-message');
console.log('confirm modal title/message:', titleText, '|', messageText);
await bobPage.click('#confirm-modal-confirm-btn');
await bobPage.waitForFunction(() => !document.getElementById('confirm-modal').classList.contains('visible'), null, { timeout: 5000 });
const afterUnreadClear = await rowCount();
console.log('rows before/after clearing while all unread (should match):', initial, afterUnreadClear);

// 2. Mark it read (click the row), then Never mind keeps it.
await bobPage.locator('#notifications-list .notification-row.unread').first().click();
await bobPage.waitForFunction(
  () => document.querySelectorAll('#notifications-list .notification-row.unread').length === 0,
  null,
  { timeout: 10000 },
);
await bobPage.click('#notifications-clear-read-btn');
await bobPage.waitForSelector('#confirm-modal.visible', { timeout: 5000 });
await bobPage.click('#confirm-modal-cancel-btn');
await bobPage.waitForFunction(() => !document.getElementById('confirm-modal').classList.contains('visible'), null, { timeout: 5000 });
const afterCancel = await rowCount();
const serverAfterCancel = await serverCount();
console.log('rows after Never mind (should be unchanged):', afterCancel, 'server:', serverAfterCancel);

// 3. Confirm: the read notice goes.
await bobPage.click('#notifications-clear-read-btn');
await bobPage.waitForSelector('#confirm-modal.visible', { timeout: 5000 });
const clearResponse = bobPage.waitForResponse(
  (response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/notifications/clear-read',
  { timeout: 10000 },
);
await bobPage.click('#confirm-modal-confirm-btn');
const clearStatus = (await clearResponse).status();
// The panel empties first and shows its "Nothing here yet." line once the
// re-fetch lands, so wait for that line rather than the empty list.
await bobPage.waitForFunction(
  () => document.querySelectorAll('#notifications-list .notification-row').length === 0
    && !document.getElementById('notifications-empty').hidden,
  null,
  { timeout: 10000 },
);
const emptyShown = await bobPage.locator('#notifications-empty').isVisible();
const serverAfterClear = await serverCount();
const modalGone = (await confirmVisible()) === 0;
console.log('clear-read status / empty message / server rows / modal closed:', clearStatus, emptyShown, serverAfterClear, modalGone);

const errors = [...aliceSession.errors, ...bobSession.errors];
const pass = initial >= 1
  && /clear/i.test(titleText)
  && /unread/i.test(messageText)
  && afterUnreadClear === initial
  && afterCancel === initial
  && serverAfterCancel === initial
  && clearStatus === 200
  && emptyShown
  && serverAfterClear === 0
  && modalGone
  && errors.length === 0;
await bobSession.browser.close();
await finish(aliceSession.browser, {
  pass,
  label: '#3280: Clear read confirms in the in-app modal, keeps unread notices, and removes read ones',
  errors,
});
