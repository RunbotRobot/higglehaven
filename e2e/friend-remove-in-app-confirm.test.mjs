// #3278: removing a friend confirms in the shared in-app modal (opened over the
// friends list), never a native confirm(). This test refuses every native
// dialog and checks: the modal names the friend and focuses the safe choice,
// Never mind keeps the friendship and re-arms the friends list, and Remove
// ends it.
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, finish, acceptConfirmModal } from './helpers.mjs';

const ALICE = 'Remove Friend Alice';
const BOB = 'Remove Friend Bob';

const aliceSession = await launchPage({ promptAnswer: ALICE, viewport: { width: 390, height: 800 } });
const alicePage = aliceSession.page;
let nativeDialogs = 0;
alicePage.removeAllListeners('dialog');
alicePage.on('dialog', async (dialog) => { nativeDialogs += 1; await dialog.dismiss(); });
await chooseIdentity(alicePage, { mode: 'build', label: ALICE, isNew: true });
await claimLandlet(alicePage);

const bobSession = await launchPage({ promptAnswer: BOB });
const bobPage = bobSession.page;
await chooseIdentity(bobPage, { mode: 'build', label: BOB, isNew: true });
await claimLandlet(bobPage);

async function fetchJson(page, path, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [path, options]);
}

const bobBuilder = (await fetchJson(bobPage, '/api/builders/me')).body.builder;
const sent = await fetchJson(alicePage, '/api/friendships', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ recipientBuilderId: bobBuilder.builderId }),
});
await fetchJson(bobPage, `/api/friendships/${sent.body.friendship.friendshipId}`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ status: 'accepted' }),
});

await openAccountMenu(alicePage);
await alicePage.click('#friends-btn');
await alicePage.waitForSelector('#friends-modal.visible', { timeout: 5000 });
await alicePage.waitForFunction(() => document.querySelectorAll('#friends-accepted-list .friend-row').length === 1, null, { timeout: 30000 });
const row = () => alicePage.locator('#friends-accepted-list .friend-row').filter({ hasText: BOB });

// Remove -> a separate modal names Bob and focuses Never mind.
await row().locator('button', { hasText: 'Remove' }).click();
await alicePage.waitForSelector('#confirm-modal.visible', { timeout: 5000 });
const messageNamesFriend = (await alicePage.textContent('#confirm-modal-message')).includes(BOB);
const focusOnSafeChoice = await alicePage.evaluate(() => document.activeElement?.id === 'confirm-modal-cancel-btn');

// Never mind -> modal closes, friendship kept, friends list still open and armed.
await alicePage.click('#confirm-modal-cancel-btn');
await alicePage.waitForFunction(() => !document.getElementById('confirm-modal').classList.contains('visible'), null, { timeout: 5000 });
const stillFriends = (await fetchJson(alicePage, '/api/friendships')).body.friendships.length === 1;
const friendsModalStillOpen = (await alicePage.locator('#friends-modal.visible').count()) === 1;

// Remove -> confirm -> the friend is gone.
await row().locator('button', { hasText: 'Remove' }).click();
await acceptConfirmModal(alicePage);
await alicePage.waitForFunction(() => document.querySelectorAll('#friends-accepted-list .friend-row').length === 0, null, { timeout: 30000 });
const friendshipsAfter = (await fetchJson(alicePage, '/api/friendships')).body.friendships.length;

console.log('confirm modal names the friend:', messageNamesFriend);
console.log('focus lands on Never mind (the safe choice):', focusOnSafeChoice);
console.log('friendship kept after Never mind:', stillFriends);
console.log('friends list still open behind it:', friendsModalStillOpen);
console.log('friendships after confirming (should be 0):', friendshipsAfter);
console.log('native dialogs raised (should be 0):', nativeDialogs);

const errors = [...aliceSession.errors, ...bobSession.errors];
const pass = messageNamesFriend && focusOnSafeChoice && stillFriends && friendsModalStillOpen
  && friendshipsAfter === 0 && nativeDialogs === 0 && errors.length === 0;
await bobSession.browser.close();
await finish(aliceSession.browser, { pass, label: 'Remove friend confirms in its own in-app modal (#3278)', errors });
