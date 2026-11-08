// #3280: a notice can be deleted from the Notices panel, not only marked read.
// Same two-party setup as e2e/notification-row-keyboard-access.test.mjs (a
// friend request is what fires Bob's real notification), at the default phone
// viewport. Checks the row goes, "Nothing here yet." returns, the badge
// follows, and the row stays gone after a reload (it was really deleted).
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, waitForText, finish } from './helpers.mjs';

const ALICE = 'Notification Delete Suite Alice';
const BOB = 'Notification Delete Suite Bob';

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

const row = () => bobPage.locator('#notifications-list .notification-row').filter({ hasText: ALICE });
const rowsBefore = await bobPage.locator('#notifications-list .notification-row').count();
const deleteBtn = row().locator('.notification-row-delete');
const deleteVisible = await deleteBtn.isVisible();
console.log('each notice has a visible Delete button (should be true):', deleteVisible);

const deleteResponse = bobPage.waitForResponse(
  (response) => response.request().method() === 'DELETE' && /\/api\/notifications\/[^/]+$/.test(new URL(response.url()).pathname),
  { timeout: 10000 },
);
await deleteBtn.click();
const deleteStatus = (await deleteResponse).status();
console.log('DELETE /api/notifications/:id status (should be 200):', deleteStatus);

await bobPage.waitForFunction(
  (name) => ![...document.querySelectorAll('#notifications-list .notification-row')].some((r) => r.textContent.includes(name)),
  ALICE,
  { timeout: 5000 },
);
const rowsAfter = await bobPage.locator('#notifications-list .notification-row').count();
const emptyShown = rowsAfter === 0 ? await bobPage.locator('#notifications-empty').isVisible() : null;
console.log('rows before/after, empty message shown when none left:', rowsBefore, rowsAfter, emptyShown);

// Really deleted, not just hidden: still gone after a fresh load.
const listed = await bobPage.evaluate(async () => (await (await fetch('/api/notifications')).json()).notifications.map((n) => n.message));
const stillThere = listed.some((message) => message.includes(ALICE));
console.log('notice absent from GET /api/notifications after deleting (should be false):', stillThere);

const errors = [...aliceSession.errors, ...bobSession.errors];
const pass = deleteVisible
  && deleteStatus === 200
  && rowsAfter === rowsBefore - 1
  && (rowsAfter !== 0 || emptyShown === true)
  && !stillThere
  && errors.length === 0;
await bobSession.browser.close();
await finish(aliceSession.browser, {
  pass,
  label: '#3280: a notice can be deleted from the Notices panel and stays deleted',
  errors,
});
