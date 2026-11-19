// #3774: the word beside the head is a door for a friend request and for a notice too. Alice sends Bob a
// friend request, which also fires Bob a notice; after Bob's page loads, the note beside his head says
// one of the two ("Friend request" or "Notice") and tapping it opens the matching panel (Friends or
// Notices), never something else. Phone viewport (the default).
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, finish, addFriendByName, waitForText } from './helpers.mjs';

const ALICE = 'Bud Note Suite Alice';
const BOB = 'Bud Note Suite Bob';

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

// Bob's page reads its counts when it loads.
await bobPage.reload({ waitUntil: 'domcontentloaded' });
await bobPage.waitForSelector('#bud-note:not([hidden])', { timeout: 60000 });
const noteText = (await bobPage.locator('#bud-note').textContent()).trim();
const noteHeight = await bobPage.evaluate(() => document.getElementById('bud-note').getBoundingClientRect().height);
console.log('the note beside the head says (should be Friend request or Notice):', noteText);
console.log('the note is at least 44px tall (should be true):', noteHeight >= 44);

await bobPage.click('#bud-note');
const expected = /friend request/i.test(noteText) ? '#friends-modal.visible' : '#notifications-modal.visible';
const opened = await bobPage.waitForSelector(expected, { timeout: 5000 }).then(() => true, () => false);
console.log('tapping the note opens the matching panel (should be true):', opened);

const pass = /^(Friend request|Notice)$/.test(noteText) && noteHeight >= 44 && opened;
await finish(bobSession.browser, {
  pass,
  label: '#3774: the note beside the head for a friend request or a notice is a door to Friends or Notices',
  errors: [],
});
