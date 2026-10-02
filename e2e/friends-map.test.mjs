// #1205 (owner idea, via Control Room, same conversation that resolved
// #1195): a single map plotting every accepted friend's lándlet at once,
// on top of the existing per-friend inline location text. Two independent
// browser pages stand in for two different builders, the same pattern
// e2e/friends.test.mjs already uses for a friend request.
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, waitForText, finish } from './helpers.mjs';

const ALICE = 'Friends Map Alice';
const BOB = 'Friends Map Bob';

const aliceSession = await launchPage({ promptAnswer: ALICE });
const bobSession = await launchPage({ promptAnswer: BOB });
const errors = [...aliceSession.errors, ...bobSession.errors];

const alicePage = aliceSession.page;
const bobPage = bobSession.page;

await chooseIdentity(alicePage, { mode: 'build', label: ALICE, isNew: true });
await claimLandlet(alicePage);
await chooseIdentity(bobPage, { mode: 'build', label: BOB, isNew: true });
await claimLandlet(bobPage);

async function fetchJson(page, path, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [path, options]);
}

const bobBuilder = (await fetchJson(bobPage, '/api/builders/me')).body.builder;

// Alice sends Bob a request and he accepts — same flow as
// e2e/friends.test.mjs's own first scenario, trimmed to just what this
// file needs (getting to "accepted" on both sides).
await openAccountMenu(alicePage);
await alicePage.click('#friends-btn');
await alicePage.waitForSelector('#friends-modal.visible', { timeout: 5000 });
alicePage.removeAllListeners('dialog');
alicePage.on('dialog', (dialog) => dialog.accept(BOB));
await alicePage.click('#friends-add-btn');
await waitForText(alicePage, '#friends-status', BOB);
await alicePage.waitForFunction(() => document.querySelectorAll('#friends-outgoing-list .friend-row').length === 1, { timeout: 5000 });
await alicePage.click('#friends-close-btn');

await openAccountMenu(bobPage);
await bobPage.click('#friends-btn');
await bobPage.waitForFunction(() => document.querySelectorAll('#friends-incoming-list .friend-row').length > 0, { timeout: 5000 });
await bobPage.locator('#friends-incoming-list .friend-row').filter({ hasText: ALICE }).locator('button', { hasText: 'Accept' }).click();
await bobPage.waitForFunction(() => document.querySelectorAll('#friends-accepted-list .friend-row').length > 0, { timeout: 5000 });
await bobPage.click('#friends-close-btn');

// Alice reopens Friends (no live polling while already open, same as
// friends.test.mjs's own comment) and now sees Bob as an accepted friend.
await openAccountMenu(alicePage);
await alicePage.click('#friends-btn');
await alicePage.waitForFunction(() => document.querySelectorAll('#friends-accepted-list .friend-row').length > 0, { timeout: 5000 });

// The map button opens a separate modal in place of the list one (see
// index.html's own comment on why it's a swap, not a stacked modal).
await alicePage.click('#friends-map-btn');
await alicePage.waitForSelector('#friends-map-modal.visible', { timeout: 5000 });
const friendsModalHiddenWhileMapOpen = !(await alicePage.locator('#friends-modal.visible').count());
console.log('friends list modal hidden while the map is open (should be true):', friendsModalHiddenWhileMapOpen);

await alicePage.waitForFunction(() => Array.isArray(window.__friendsMapPoints) && window.__friendsMapPoints.length > 0, { timeout: 5000 });
const points = await alicePage.evaluate(() => window.__friendsMapPoints);
console.log('points plotted on Alice\'s friends map (should include Bob, exactly once):', points);
const emptyMessageHidden = await alicePage.locator('#friends-map-empty').isHidden();
console.log('"no friends located" message hidden once a point exists (should be true):', emptyMessageHidden);

const bobPoints = points.filter((p) => p.builderId === bobBuilder.builderId);

await alicePage.click('#friends-map-close-btn');
await alicePage.waitForSelector('#friends-modal.visible', { timeout: 5000 });
const mapHiddenAfterClose = !(await alicePage.locator('#friends-map-modal.visible').count());
console.log('map modal hidden, friends list reshown after closing the map (should be true):', mapHiddenAfterClose);

const pass =
  friendsModalHiddenWhileMapOpen &&
  points.length === 1 &&
  bobPoints.length === 1 &&
  bobPoints[0].label === BOB &&
  typeof bobPoints[0].x === 'number' && typeof bobPoints[0].y === 'number' &&
  emptyMessageHidden &&
  mapHiddenAfterClose &&
  errors.length === 0;
await bobSession.browser.close();
await finish(aliceSession.browser, { pass, label: 'Friends map: plots every accepted friend\'s lándlet at once (#1205)', errors });
