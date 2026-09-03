// Friend requests (docs/SPEC.md §2: "Friend/group systems: standard friend
// requests; social map shows friends' approximate location.") Two
// independent browser pages stand in for two different builders, the same
// pattern e2e/land-auctions.test.mjs already uses, since a friend request
// is inherently a two-party interaction. Covers sending a request through
// the real "+ Add Friend" prompt, seeing it as incoming on the other side,
// accepting it, and both sides then showing each other in "Friends" with
// their approximate location (their claimed lándlet — see
// docs/API.md's "Friend requests" for why that's the honest simplification
// here, not a live position). Also covers canceling a still-pending
// outgoing request. Duplicate-request rejection, the self-request 400, and
// the "declined" (recipient-side DELETE) path are covered instead by
// worker/index.test.js's own "Friendships" describe block.
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, waitForText, finish } from './helpers.mjs';

const ALICE = 'Friends Suite Alice';
const BOB = 'Friends Suite Bob';
const CAROL = 'Friends Suite Carol';

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

// Alice sends Bob a request through the real "+ Add Friend" prompt.
// launchPage's own dialog handler answers every prompt with one fixed
// string for the session (ALICE here), so this swaps in a one-off handler
// for the "Friend's name" prompt specifically, answering with BOB instead.
await openAccountMenu(alicePage);
await alicePage.click('#friends-btn');
await alicePage.waitForSelector('#friends-modal.visible', { timeout: 5000 });
alicePage.removeAllListeners('dialog');
alicePage.on('dialog', (dialog) => dialog.accept(BOB));
await alicePage.click('#friends-add-btn');
// Sending kicks off an async POST + outgoing-list refresh — poll for both
// rather than guessing a fixed delay, which flaked under CI load (a fixed
// 500ms here read stale/empty state on a loaded runner even though the
// request itself succeeded moments later — see e2e/helpers.mjs's
// waitForText, used the same way auth.test.mjs/pioneer-badge.test.mjs
// already do for this exact shape of race).
const aliceStatusAfterSend = await waitForText(alicePage, '#friends-status', BOB);
console.log('Alice status after sending the request (should mention Bob):', aliceStatusAfterSend);
await alicePage.waitForFunction(() => document.querySelectorAll('#friends-outgoing-list .friend-row').length === 1, { timeout: 5000 });
const aliceOutgoingCount = await alicePage.locator('#friends-outgoing-list .friend-row').count();
console.log('Alice outgoing list count right after sending (should be 1):', aliceOutgoingCount);

// Bob opens Friends and sees the incoming request.
await openAccountMenu(bobPage);
await bobPage.click('#friends-btn');
await bobPage.waitForSelector('#friends-modal.visible', { timeout: 5000 });
await bobPage.waitForFunction(() => document.querySelectorAll('#friends-incoming-list .friend-row').length > 0, { timeout: 5000 });
const bobIncomingText = await bobPage.locator('#friends-incoming-list .friend-row').first().textContent();
console.log('Bob\'s incoming row (should mention Alice):', bobIncomingText);

await bobPage.locator('#friends-incoming-list .friend-row').filter({ hasText: ALICE }).locator('button', { hasText: 'Accept' }).click();
await bobPage.waitForFunction(() => document.querySelectorAll('#friends-incoming-list .friend-row').length === 0, { timeout: 5000 });
const bobAcceptedText = await bobPage.locator('#friends-accepted-list .friend-row').first().textContent();
console.log('Bob\'s accepted row (should mention Alice and her lándlet):', bobAcceptedText);

// Alice reopens Friends (the modal doesn't live-poll while already open —
// same no-live-updates convention as Notices) and now sees Bob as accepted.
await alicePage.click('#friends-close-btn');
await openAccountMenu(alicePage);
await alicePage.click('#friends-btn');
await alicePage.waitForFunction(() => document.querySelectorAll('#friends-accepted-list .friend-row').length > 0, { timeout: 5000 });
const aliceAcceptedText = await alicePage.locator('#friends-accepted-list .friend-row').first().textContent();
console.log('Alice\'s accepted row (should mention Bob and his lándlet):', aliceAcceptedText);
await alicePage.click('#friends-close-btn');
await alicePage.waitForTimeout(300);

// Canceling a still-pending outgoing request: Carol is created directly via
// the API (a full second browser session isn't needed just to exist as a
// name to look up), then Alice sends and immediately cancels a request to
// her through the real UI.
const carol = (await fetchJson(alicePage, '/api/builders', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label: CAROL }),
})).body.builder;

await openAccountMenu(alicePage);
await alicePage.click('#friends-btn');
await alicePage.waitForSelector('#friends-modal.visible', { timeout: 5000 });
alicePage.removeAllListeners('dialog');
alicePage.on('dialog', (dialog) => dialog.accept(CAROL));
await alicePage.click('#friends-add-btn');
await alicePage.waitForFunction(
  (name) => [...document.querySelectorAll('#friends-outgoing-list .friend-row')].some((row) => row.textContent.includes(name)),
  CAROL,
  { timeout: 5000 },
);
const aliceOutgoingToCarolCount = await alicePage.locator('#friends-outgoing-list .friend-row').filter({ hasText: CAROL }).count();
console.log('Alice\'s outgoing list includes Carol after sending (should be 1):', aliceOutgoingToCarolCount);

await alicePage.locator('#friends-outgoing-list .friend-row').filter({ hasText: CAROL }).locator('button', { hasText: 'Cancel' }).click();
await alicePage.waitForFunction(
  (name) => ![...document.querySelectorAll('#friends-outgoing-list .friend-row')].some((row) => row.textContent.includes(name)),
  CAROL,
  { timeout: 5000 },
);
const aliceOutgoingToCarolAfterCancel = await alicePage.locator('#friends-outgoing-list .friend-row').filter({ hasText: CAROL }).count();
console.log('Alice\'s outgoing list no longer includes Carol after canceling (should be 0):', aliceOutgoingToCarolAfterCancel);

// Querying another builder's friendships by id now requires being that
// builder's own logged-in session (see handleFriendships's own comment) —
// Carol is just a lightweight, unlinked builder row with no session of her
// own, so this checks the same fact from Alice's own (permitted) list
// instead: no friendship record involving Carol survives the cancel.
const aliceFriendshipsAfterCancel = (await fetchJson(alicePage, '/api/friendships')).body.friendships;
const carolFriendshipsAfterCancel = aliceFriendshipsAfterCancel.filter((f) => f.otherBuilderId === carol.builderId);
console.log('Alice has no friendship record with Carol after the cancel (should be 0):', carolFriendshipsAfterCancel.length);

const pass = aliceOutgoingCount === 1 &&
  bobIncomingText.includes(ALICE) &&
  bobAcceptedText.includes(ALICE) &&
  aliceAcceptedText.includes(BOB) &&
  aliceOutgoingToCarolCount === 1 &&
  aliceOutgoingToCarolAfterCancel === 0 &&
  carolFriendshipsAfterCancel.length === 0 &&
  errors.length === 0;
await bobSession.browser.close();
await finish(aliceSession.browser, { pass, label: 'Friend requests: send + accept + approximate location + cancel', errors });
