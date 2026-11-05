// #3140 (sub-issue 1/2 of #3124): the Block control on a friend row and the
// "Blocked people" list with Unblock, driven through the real friends modal.
// Blocking also silently ends the friendship. (The per-surface filters that
// make a block take effect are #3143; the API itself is covered by
// worker/blocks.test.js.) launchPage's own dialog handler accepts every
// confirm()/alert() the Block flow raises.
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, finish } from './helpers.mjs';

const ALICE = 'Blocks Suite Alice';
const BOB = 'Blocks Suite Bob';

const aliceSession = await launchPage({ promptAnswer: ALICE });
const alicePage = aliceSession.page;
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

// Become friends through the API (the friend-request UI has its own suite).
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
const blockedEmptyBefore = await alicePage.locator('#friends-blocked-empty').isVisible();
console.log('"You haven\'t blocked anyone" shown before blocking (should be true):', blockedEmptyBefore);

// Block Bob from his friend row.
const bobNoteCountBefore = (await fetchJson(bobPage, '/api/notifications')).body.notifications.length;
await alicePage.locator('#friends-accepted-list .friend-row').filter({ hasText: BOB }).locator('button', { hasText: 'Block' }).click();
await alicePage.waitForFunction(() => document.querySelectorAll('#friends-blocked-list .friend-row').length === 1, null, { timeout: 30000 });
const friendRowsAfterBlock = await alicePage.locator('#friends-accepted-list .friend-row').count();
const blockedRowText = await alicePage.locator('#friends-blocked-list .friend-row').first().textContent();
console.log('Friends list is empty after blocking (should be 0):', friendRowsAfterBlock);
console.log('Blocked people lists Bob (should mention Bob):', blockedRowText);

// The friendship is gone on Bob's side too, and Bob was not told anything.
const bobFriendships = (await fetchJson(bobPage, '/api/friendships')).body.friendships;
const bobNoteCountAfter = (await fetchJson(bobPage, '/api/notifications')).body.notifications.length;
console.log('Bob has no friendship with Alice after being blocked (should be 0):', bobFriendships.length);
console.log('Bob\'s notification count is unchanged by the block (should be true):', bobNoteCountAfter === bobNoteCountBefore);

// Unblock.
await alicePage.locator('#friends-blocked-list .friend-row').first().locator('button', { hasText: 'Unblock' }).click();
await alicePage.waitForFunction(() => document.querySelectorAll('#friends-blocked-list .friend-row').length === 0, null, { timeout: 30000 });
const blockedEmptyAfter = await alicePage.locator('#friends-blocked-empty').isVisible();
console.log('"You haven\'t blocked anyone" shown again after unblocking (should be true):', blockedEmptyAfter);

const errors = [...aliceSession.errors, ...bobSession.errors];
const pass = blockedEmptyBefore &&
  friendRowsAfterBlock === 0 &&
  blockedRowText.includes(BOB) &&
  bobFriendships.length === 0 &&
  bobNoteCountAfter === bobNoteCountBefore &&
  blockedEmptyAfter &&
  errors.length === 0;
await bobSession.browser.close();
await finish(aliceSession.browser, { pass, label: '#3140: Block a friend, see them under Blocked people, unblock', errors });
