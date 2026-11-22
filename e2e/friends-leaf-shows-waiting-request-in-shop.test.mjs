// #4041 (part of #3539, found by the job walk on #3887): in Shop the head wore a dot and a note for a waiting friend
// request, but the open Friends leaf said "No friends yet" and showed none, because the list stopped for a missing
// builder identity (Shop has none of its own) while the dot read the same friendships by account. The two now agree:
// the waiting request is in the leaf with Accept, and the empty line is not shown while one waits.
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, goToMode, waitForText, finish, addFriendByName } from './helpers.mjs';

const ALICE = 'Shop Friends Alice';
const BOB = 'Shop Friends Bob';

const alice = await launchPage({ promptAnswer: ALICE });
const alicePage = alice.page;
await chooseIdentity(alicePage, { mode: 'build', label: ALICE, isNew: true });
await claimLandlet(alicePage);
const bob = await launchPage({ promptAnswer: BOB });
const bobPage = bob.page;
await chooseIdentity(bobPage, { mode: 'build', label: BOB, isNew: true });
await claimLandlet(bobPage);

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

// Bob asks Alice (from Build, where both have a builder).
await openAccountMenu(bobPage);
await bobPage.click('#friends-btn');
await bobPage.waitForSelector('#friends-modal.visible', { timeout: 5000 });
await addFriendByName(bobPage, ALICE);
await waitForText(bobPage, '#friends-status', ALICE);

// Alice is in Shop, with no builder identity loaded.
await goToMode(alicePage, 'shop');
await alicePage.waitForSelector('body[data-mode="shop"][data-bud="on"]', { timeout: 30000 });
await alicePage.waitForSelector('body.shop-ready', { timeout: 30000 }).catch(() => {});
await alicePage.waitForFunction(() => !document.getElementById('friends-badge').hidden, null, { timeout: 30000 });
check(true, 'the dot is there');
await openAccountMenu(alicePage);
await alicePage.click('#friends-btn');
await alicePage.waitForSelector('#friends-modal.visible', { timeout: 5000 });
await alicePage.waitForFunction(() => document.querySelectorAll('#friends-incoming-list .friend-row').length === 1, null, { timeout: 15000 })
  .catch(() => check(false, 'the waiting request is drawn in the Friends leaf in Shop'));
const state = await alicePage.evaluate(() => ({
  rows: document.querySelectorAll('#friends-incoming-list .friend-row').length,
  label: document.querySelector('#friends-incoming-list .friend-row-label')?.textContent || '',
  accept: [...document.querySelectorAll('#friends-incoming-list button')].some((b) => /accept/i.test(b.textContent)),
  emptyShown: !!document.getElementById('friends-panel-empty') && !document.getElementById('friends-panel-empty').hidden,
}));
console.log('Alice in Shop:', JSON.stringify(state));
check(state.rows === 1 && state.label.includes(BOB), `the request from Bob is listed (${state.label})`);
check(state.accept, 'it can be accepted from there');
check(!state.emptyShown, '"No friends yet" is not shown while a request waits');

// The same for Notices: its dot counts the notice Bob's request raised, and the leaf lists it (not "Nothing new").
await alicePage.click('#friends-close-btn');
await openAccountMenu(alicePage);
await alicePage.click('#notifications-btn');
await alicePage.waitForSelector('#notifications-modal.visible', { timeout: 5000 });
await alicePage.waitForFunction(() => document.querySelectorAll('#notifications-list .notification-row').length >= 1, null, { timeout: 15000 })
  .catch(() => check(false, 'the notice the dot counts is listed in the Notices leaf in Shop'));
const notices = await alicePage.evaluate(() => ({
  rows: document.querySelectorAll('#notifications-list .notification-row').length,
  emptyShown: !!document.getElementById('notifications-empty') && !document.getElementById('notifications-empty').hidden,
}));
console.log('Notices in Shop:', JSON.stringify(notices));
check(notices.rows >= 1 && !notices.emptyShown, '"Nothing new" is not shown while a notice waits');

await bob.browser.close();
await finish(alice.browser, { pass, label: '#4041: the Friends leaf in Shop shows the request its dot counts', errors: alice.errors });
