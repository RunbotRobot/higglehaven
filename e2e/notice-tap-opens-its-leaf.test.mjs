// #4498: a notice is a door to what it is about. Alice sends Bob a friend request, which also fires Bob a
// notice; tapping that notice in Bob's Notices marks it read and opens Friends (and closes Notices). A read
// notice still opens it. Phone viewport (the default).
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, finish, addFriendByName, waitForText } from './helpers.mjs';

const ALICE = 'Notice Door Suite Alice';
const BOB = 'Notice Door Suite Bob';

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
await addFriendByName(alicePage, BOB);
await waitForText(alicePage, '#friends-status', BOB);
await alicePage.click('#friends-close-btn');

await bobPage.reload({ waitUntil: 'domcontentloaded' });
await bobPage.waitForSelector('#bud-note:not([hidden])', { timeout: 60000 });
await openAccountMenu(bobPage);
await bobPage.click('#notifications-btn');
await bobPage.waitForSelector('#notifications-modal.visible', { timeout: 5000 });
const row = bobPage.locator('.notification-row', { hasText: 'sent you a friend request' });
await row.waitFor({ timeout: 10000 });
console.log('the notice reads as a door (aria-label starts with Open):', (await row.getAttribute('aria-label')).startsWith('Open'));

await row.click();
const friendsOpened = await bobPage.waitForSelector('#friends-modal.visible', { timeout: 5000 }).then(() => true, () => false);
const noticesClosed = await bobPage.evaluate(() => !document.getElementById('notifications-modal').classList.contains('visible'));
console.log('tapping it opens Friends (should be true):', friendsOpened, '; Notices closed (should be true):', noticesClosed);

// It is read now, and a read notice still opens Friends.
await bobPage.click('#friends-close-btn');
await openAccountMenu(bobPage);
await bobPage.click('#notifications-btn');
await bobPage.waitForSelector('#notifications-modal.visible', { timeout: 5000 });
const readRow = bobPage.locator('.notification-row:not(.unread)', { hasText: 'sent you a friend request' });
await readRow.waitFor({ timeout: 10000 });
await readRow.click();
const reopened = await bobPage.waitForSelector('#friends-modal.visible', { timeout: 5000 }).then(() => true, () => false);
console.log('a read notice still opens Friends (should be true):', reopened);

await finish(bobSession.browser, {
  pass: friendsOpened && noticesClosed && reopened,
  label: '#4498: a tap on a friend-request notice opens Friends, read or not',
  errors: [],
});
