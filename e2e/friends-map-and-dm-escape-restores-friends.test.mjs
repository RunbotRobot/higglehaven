// #1679: the Friends-map and direct-messages modals are both reached by
// hiding the Friends list modal first, then showing the child modal in its
// place (see index.html's own comment on why it's a swap, not a stacked
// modal — same pattern e2e/friends-map.test.mjs already exercises for the
// map). The explicit "X" close button on each child modal re-shows the
// Friends modal afterward, but closeFriendsMapModal/closeDmModal — the
// functions openModalA11y registers as each child modal's Escape handler —
// used to only hide the child, never restoring Friends. Pressing Escape
// instead of clicking "X" left no modal open at all. Fixed by moving the
// restoration into the close functions themselves, so Escape and "X" now
// take the same path.
//
// Like e2e/dm-badge.test.mjs, this deployment never configures
// DIDIT_API_KEY, so there's no real way to drive an account to
// trust_tier === 'id_verified' — mocking /api/auth/me's own trustTier is
// the same approach that test already uses to reach the "Message" button.
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, waitForText, finish } from './helpers.mjs';

const ALICE = 'Escape Restore Suite Alice';
const BOB = 'Escape Restore Suite Bob';

const aliceSession = await launchPage({ promptAnswer: ALICE });
const bobSession = await launchPage({ promptAnswer: BOB });
const errors = [...aliceSession.errors, ...bobSession.errors];

const alicePage = aliceSession.page;
const bobPage = bobSession.page;

// Must be live before chooseIdentity ever runs — see dm-badge.test.mjs's
// own comment on why a later registration races the real bootstrap call.
await alicePage.route('**/api/auth/me', async (route) => {
  const response = await route.fetch();
  const body = await response.json();
  if (body.user) body.user.trustTier = 'id_verified';
  await route.fulfill({ response, contentType: 'application/json', body: JSON.stringify(body) });
});

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
// #2637 (sub-issue of #2635): waitForFunction's signature is (pageFunction,
// arg, options) -- a bare (fn, { timeout }) call puts the options object in
// the `arg` slot instead, so `options` stayed undefined and the real applied
// timeout was always Playwright's actual default (30000ms), never the
// smaller number written here. The explicit `null` arg reaches the options
// slot, and the timeout itself is widened to 30000ms for real headroom under
// CI load (this is a two-concurrent-page Alice/Bob test, same reasoning
// #2636's own sibling leaf used for single-page admin panels).
await bobPage.waitForFunction(() => document.querySelectorAll('#friends-incoming-list .friend-row').length > 0, null, { timeout: 30000 });
await bobPage.locator('#friends-incoming-list .friend-row').filter({ hasText: ALICE }).locator('button', { hasText: 'Accept' }).click();
await bobPage.waitForFunction(() => document.querySelectorAll('#friends-accepted-list .friend-row').length > 0, null, { timeout: 30000 });
await bobSession.browser.close();

await openAccountMenu(alicePage);
await alicePage.click('#friends-btn');
await alicePage.waitForFunction(() => document.querySelectorAll('#friends-accepted-list .friend-row').length > 0, null, { timeout: 30000 });

// --- Friends-map modal: Escape should restore the Friends modal, same as "X" ---
await alicePage.click('#friends-map-btn');
await alicePage.waitForSelector('#friends-map-modal.visible', { timeout: 5000 });
await alicePage.keyboard.press('Escape');
await alicePage.waitForSelector('#friends-map-modal:not(.visible)', { state: 'attached', timeout: 5000 });
const mapClosedByEscape = (await alicePage.locator('#friends-map-modal.visible').count()) === 0;
const friendsRestoredAfterMapEscape = (await alicePage.locator('#friends-modal.visible').count()) === 1;
console.log('Friends-map modal closed by Escape (should be true):', mapClosedByEscape);
console.log('Friends modal restored after Escape on the map (should be true):', friendsRestoredAfterMapEscape);

// --- Direct-messages modal: same check ---
await alicePage.waitForFunction(() => document.querySelectorAll('#friends-accepted-list .friend-row').length > 0, null, { timeout: 30000 });
const messageBtnCount = await alicePage.locator('#friends-accepted-list .friend-row').filter({ hasText: BOB }).locator('button', { hasText: 'Message' }).count();
console.log('"Message" button visible for Alice (id_verified) on Bob\'s row (should be 1):', messageBtnCount);
await alicePage.locator('#friends-accepted-list .friend-row').filter({ hasText: BOB }).locator('button', { hasText: 'Message' }).click();
await alicePage.waitForSelector('#dm-modal.visible', { timeout: 5000 });
await alicePage.keyboard.press('Escape');
await alicePage.waitForSelector('#dm-modal:not(.visible)', { state: 'attached', timeout: 5000 });
const dmClosedByEscape = (await alicePage.locator('#dm-modal.visible').count()) === 0;
const friendsRestoredAfterDmEscape = (await alicePage.locator('#friends-modal.visible').count()) === 1;
console.log('DM modal closed by Escape (should be true):', dmClosedByEscape);
console.log('Friends modal restored after Escape on the DM thread (should be true):', friendsRestoredAfterDmEscape);

await alicePage.unroute('**/api/auth/me');

const pass =
  mapClosedByEscape &&
  friendsRestoredAfterMapEscape &&
  messageBtnCount === 1 &&
  dmClosedByEscape &&
  friendsRestoredAfterDmEscape &&
  errors.length === 0;
await finish(aliceSession.browser, {
  pass,
  label: '#1679: Escape on the Friends-map or DM modal restores the Friends modal, matching the "X" button',
  errors,
});
