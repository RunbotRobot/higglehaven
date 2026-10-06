// Regression test for #1348: drawFriendsMap had no load-token/supersede
// guard, unlike every sibling async-render panel in this file
// (renderFriends/renderSignPosts/renderCalendarEvents, each with their own
// *LoadToken). Closing the map and reopening it quickly fires a second
// drawFriendsMap() before the first call's own fetch has resolved — if the
// first (now-stale) response lands after the second (fresher) one, it would
// silently overwrite the canvas/window.__friendsMapPoints with outdated
// data.
//
// Delaying only the *delivery* of the first call's GET /api/world response
// (via route.fetch() then a sleep then route.fulfill(), the same idiom
// e2e/version-history-race.test.mjs already uses) lets that request capture
// real server state as of when it was actually sent, while arriving late
// enough that a second, fresher call's own render has already landed by
// the time it's delivered -- the exact reordering the issue describes.
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, waitForText, finish } from './helpers.mjs';

const ALICE = 'Friends Map Race Alice';
const BOB = 'Friends Map Race Bob';

const aliceSession = await launchPage({ promptAnswer: ALICE });
const bobSession = await launchPage({ promptAnswer: BOB });
const errors = [...aliceSession.errors, ...bobSession.errors];

const alicePage = aliceSession.page;
const bobPage = bobSession.page;

await chooseIdentity(alicePage, { mode: 'build', label: ALICE, isNew: true });
await claimLandlet(alicePage);
await chooseIdentity(bobPage, { mode: 'build', label: BOB, isNew: true });
await claimLandlet(bobPage);

async function fetchJson(page, pathAndQuery, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [pathAndQuery, options]);
}

// Alice and Bob become friends (same trimmed flow as e2e/friends-map.test.mjs).
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

await openAccountMenu(alicePage);
await alicePage.click('#friends-btn');
await alicePage.waitForFunction(() => document.querySelectorAll('#friends-accepted-list .friend-row').length > 0, { timeout: 5000 });

// Delay only the FIRST GET /api/world response's delivery -- it still gets
// sent (and genuinely answered by the server) right away, so it captures
// real state as of now (Bob still located); every later request to this
// same endpoint passes straight through unmodified.
let worldRequestCount = 0;
await alicePage.route('**/api/world', async (route) => {
  worldRequestCount++;
  if (worldRequestCount !== 1) {
    await route.continue();
    return;
  }
  const response = await route.fetch();
  await new Promise((resolve) => setTimeout(resolve, 2500));
  await route.fulfill({ response });
});

// Open #1 (fetch A): fires drawFriendsMap, whose GET /api/world is now
// in flight but held back for 2500ms by the route above.
await alicePage.click('#friends-map-btn');
await alicePage.waitForSelector('#friends-map-modal.visible', { timeout: 5000 });

// While A is still in flight, change the real server state it already
// captured a stale snapshot of: remove the friendship entirely, so Bob is
// no longer a located friend at all.
const { friendships: aliceFriendships } = (await fetchJson(alicePage, '/api/friendships')).body;
const friendshipWithBob = aliceFriendships.find((f) => f.otherLabel === BOB);
const removed = await fetchJson(alicePage, `/api/friendships/${friendshipWithBob.friendshipId}`, { method: 'DELETE' });
console.log('removed the Alice/Bob friendship while call #1 was still in flight (status should be 200/204):', removed.status);

// Close and reopen the map -- open #2 (fetch B): its own GET /api/world
// passes straight through (worldRequestCount is now 2), resolves quickly,
// and correctly renders zero located friends.
await alicePage.click('#friends-map-close-btn');
await alicePage.waitForSelector('#friends-modal.visible', { timeout: 5000 });
await alicePage.click('#friends-map-btn');
await alicePage.waitForSelector('#friends-map-modal.visible', { timeout: 5000 });
await alicePage.waitForFunction(() => Array.isArray(window.__friendsMapPoints) && window.__friendsMapPoints.length === 0, { timeout: 5000 });
const emptyShownRightAfterOpenTwo = await alicePage.locator('#friends-map-empty').isVisible();
console.log('map #2 correctly shows "no friends located" right after opening (should be true):', emptyShownRightAfterOpenTwo);

// Now let call #1's delayed response finally land. Without the fix, its
// stale "Bob is located" data would overwrite the canvas/points on top of
// call #2's already-correct empty render.
await alicePage.waitForTimeout(3000);

const pointsAfterStaleResponseLands = await alicePage.evaluate(() => window.__friendsMapPoints);
console.log('points after the stale call #1 response finally lands (should still be empty, was the #1348 bug):', pointsAfterStaleResponseLands);
const emptyStillShown = await alicePage.locator('#friends-map-empty').isVisible();
console.log('"no friends located" message still shown after the stale response lands (should be true):', emptyStillShown);

const pass =
  worldRequestCount >= 2 &&
  (removed.status === 200 || removed.status === 204) &&
  emptyShownRightAfterOpenTwo &&
  pointsAfterStaleResponseLands.length === 0 &&
  emptyStillShown &&
  errors.length === 0;
await bobSession.browser.close();
await finish(aliceSession.browser, { pass, label: 'drawFriendsMap discards a stale, superseded response instead of overwriting a fresher render (#1348)', errors });
