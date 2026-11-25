// #4317: the head's note for a friend request or a notice rests on two counts asked for once at start-up.
// When that one ask failed, the note stayed missing for the whole visit. Here Bob's first asks for both
// counts are made to fail; the note must still appear by itself, without a reload, once they are asked again.
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, finish, addFriendByName, waitForText } from './helpers.mjs';

const ALICE = 'Count Retry Alice';
const BOB = 'Count Retry Bob';

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

// The first asks for each count fail; later ones go through.
const FAIL_FIRST = 2;
const failures = { notices: 0, friends: 0 };
await bobPage.route('**/api/notifications/unread-count', (route) => {
  if (failures.notices < FAIL_FIRST) { failures.notices += 1; return route.abort('failed'); }
  return route.continue();
});
await bobPage.route('**/api/friendships?*', (route) => {
  if (failures.friends < FAIL_FIRST) { failures.friends += 1; return route.abort('failed'); }
  return route.continue();
});

await bobPage.reload({ waitUntil: 'domcontentloaded' });
// (The suite's clock runs ahead of real time; the wait is a few seconds at most, the headroom is for a loaded shard.)
const shown = await bobPage.waitForSelector('#bud-note:not([hidden])', { timeout: 90000 }).then(() => true, () => false);
console.log('failed asks so far (notices, friends):', failures.notices, failures.friends);
console.log('the note appears without a reload after the first asks failed (should be true):', shown);

const pass = shown && (failures.notices > 0 || failures.friends > 0);
await finish(bobSession.browser, {
  pass,
  label: '#4317: a failed start-up ask for the head\'s counts is asked again, and the note appears',
  errors: bobSession.errors.filter((e) => !e.includes('Failed to load resource') && !e.includes('net::ERR_FAILED')),
});
