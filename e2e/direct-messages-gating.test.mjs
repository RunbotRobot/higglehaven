// #1637 (resolves #1002): direct messages between two id_verified,
// already-friended builders. The full send/receive/mark-read happy path is
// already covered end-to-end against the real handler in
// worker/direct-messages.test.js (SELF.fetch, same in-process pool-workers
// environment every other worker/*.test.js integration test uses) — this
// file covers what's left that only a real browser can show: the "Message"
// button's own visibility gate on the Friends panel.
//
// Like e2e/didit-verification.test.mjs (see its own top comment), this
// deployment never configures DIDIT_API_KEY, so there is no way to drive a
// real account to trust_tier === 'id_verified' through the actual app here
// — only the credit-card floor is reachable. That's exactly the state this
// test exercises: two credit-card-verified (not id_verified) friends should
// never see a "Message" button at all, since sending would be rejected
// either way. A real POST against the live dev server (not the vitest
// in-process pool) confirms the backend gate holds even if a button
// existed.
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, waitForText, finish } from './helpers.mjs';

const ALICE = 'DM Gating Suite Alice';
const BOB = 'DM Gating Suite Bob';

const aliceSession = await launchPage({ promptAnswer: ALICE });
const bobSession = await launchPage({ promptAnswer: BOB });
const errors = [...aliceSession.errors, ...bobSession.errors];

const alicePage = aliceSession.page;
const bobPage = bobSession.page;

await chooseIdentity(alicePage, { mode: 'build', label: ALICE, isNew: true });
await claimLandlet(alicePage);
await chooseIdentity(bobPage, { mode: 'build', label: BOB, isNew: true });
await claimLandlet(bobPage);

// Same real "+ Add Friend" flow as e2e/friends.test.mjs.
await openAccountMenu(alicePage);
await alicePage.click('#friends-btn');
await alicePage.waitForSelector('#friends-modal.visible', { timeout: 5000 });
alicePage.removeAllListeners('dialog');
alicePage.on('dialog', (dialog) => dialog.accept(BOB));
await alicePage.click('#friends-add-btn');
await waitForText(alicePage, '#friends-status', BOB);
await alicePage.click('#friends-close-btn');

await openAccountMenu(bobPage);
await bobPage.click('#friends-btn');
await bobPage.waitForSelector('#friends-modal.visible', { timeout: 5000 });
await bobPage.waitForFunction(() => document.querySelectorAll('#friends-incoming-list .friend-row').length > 0, { timeout: 5000 });
await bobPage.locator('#friends-incoming-list .friend-row').filter({ hasText: ALICE }).locator('button', { hasText: 'Accept' }).click();
await bobPage.waitForFunction(() => document.querySelectorAll('#friends-accepted-list .friend-row').length > 0, { timeout: 5000 });

const bobAcceptedRowText = await bobPage.locator('#friends-accepted-list .friend-row').first().textContent();
const bobMessageBtnCount = await bobPage.locator('#friends-accepted-list .friend-row').filter({ hasText: ALICE }).locator('button', { hasText: 'Message' }).count();
console.log('Bob\'s accepted row (should mention Alice):', bobAcceptedRowText);
console.log('"Message" button count on Bob\'s now-accepted-friend row, neither side id_verified (should be 0):', bobMessageBtnCount);

await bobPage.click('#friends-close-btn');
await openAccountMenu(alicePage);
await alicePage.click('#friends-btn');
await alicePage.waitForFunction(() => document.querySelectorAll('#friends-accepted-list .friend-row').length > 0, { timeout: 5000 });
const aliceMessageBtnCount = await alicePage.locator('#friends-accepted-list .friend-row').filter({ hasText: BOB }).locator('button', { hasText: 'Message' }).count();
console.log('"Message" button count on Alice\'s accepted-friend row (should also be 0):', aliceMessageBtnCount);

// A real POST against the live dev server, bypassing the (correctly absent)
// button entirely — confirms handleDirectMessages' own id_verified gate
// holds against this exact deployment's real HTTP stack, not just the
// vitest pool-workers simulation.
const directSendAttempt = await alicePage.evaluate(async () => {
  const friendships = await (await fetch('/api/friendships')).json();
  const bob = friendships.friendships.find((f) => f.status === 'accepted');
  const res = await fetch('/api/direct-messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ recipientBuilderId: bob.otherBuilderId, text: 'should be rejected' }),
  });
  return { status: res.status, body: await res.json() };
});
console.log('Direct POST /api/direct-messages status for a credit-card-only (not id_verified) sender (should be 403):', directSendAttempt.status, directSendAttempt.body);

const pass =
  bobAcceptedRowText.includes(ALICE) &&
  bobMessageBtnCount === 0 &&
  aliceMessageBtnCount === 0 &&
  directSendAttempt.status === 403 &&
  directSendAttempt.body.idVerificationRequired === true &&
  errors.length === 0;
await bobSession.browser.close();
await finish(aliceSession.browser, { pass, label: 'Direct messages (#1637): "Message" button hidden and send rejected for non-id_verified friends', errors });
