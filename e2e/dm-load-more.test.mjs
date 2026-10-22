// #1677: the DM thread (src/main.js's renderDmThread) always fetched
// fetchDirectMessages(dmOtherBuilderId) with no cursor and never read the
// response's own nextCursor -- anything before the first ~100 messages in a
// thread was permanently invisible, even though GET /api/direct-messages
// already fully supports cursor pagination (the same shape
// GET /api/builders/me/saved-layouts uses, fixed for its own frontend gap
// by #1215). Fixed by mirroring that Load More pattern, with one twist:
// older messages belong visually *above* what's already rendered (a chat
// thread reads oldest-to-newest top-to-bottom), so "Load more" prepends
// instead of appending.
//
// Driving this with REAL messages isn't practical in one test run the same
// way #1215's own e2e/saved-layouts-load-more.test.mjs explains for saved
// layouts: DIRECT_MESSAGE_SEND_RATE_LIMIT_MAX (worker/index.js) caps real
// sends at 20 per window, nowhere near the ~100 needed to reach a second
// page, and this deployment never configures DIDIT_API_KEY so there's no
// way to drive a real account to id_verified (required to even send) in
// the first place -- see e2e/direct-messages-gating.test.mjs's own header
// comment. The bug being tested is purely frontend (renderDmThread never
// reading nextCursor at all), so this mocks every DM-related endpoint
// (page.route(), same technique #1215's own test and e2e/dm-badge.test.mjs
// already use) rather than fighting either real limit.
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, finish } from './helpers.mjs';

const LABEL = 'DM Pagination Tester';
const FRIEND_LABEL = 'DM Pagination Friend';
const FRIEND_BUILDER_ID = 'fake-dm-friend';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

// Message button visibility (#1637) is gated on this viewer's own
// trustTier alone -- same mock e2e/dm-badge.test.mjs already uses to reach
// it without a real DIDIT-verified account.
await page.route('**/api/auth/me', async (route) => {
  const response = await route.fetch();
  const body = await response.json();
  if (body.user) body.user.trustTier = 'id_verified';
  await route.fulfill({ response, contentType: 'application/json', body: JSON.stringify(body) });
});

// A fake already-accepted friendship, so the Friends panel renders a real
// row with a real "Message" button -- avoids needing a second full builder
// signup+friend-request round trip just to reach openDmModal.
await page.route('**/api/friendships*', async (route) => {
  const friendships = [{
    friendshipId: 'fake-friendship-1',
    otherBuilderId: FRIEND_BUILDER_ID,
    otherLabel: FRIEND_LABEL,
    status: 'accepted',
    direction: 'outgoing',
    otherLandlet: null,
  }];
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ friendships, nextCursor: null }) });
});

function fakeMessage(i) {
  return {
    messageId: `fake-msg-${i}`,
    senderBuilderId: FRIEND_BUILDER_ID,
    text: `Msg ${i}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
  };
}

// Registered as three separate, mutually-exclusive patterns rather than one
// handler dispatching on pathname -- a single trailing `*` (Playwright glob,
// unlike `**`) never matches a `/`, so '**/api/direct-messages*' alone would
// never catch '.../direct-messages/mark-read' or '.../unread-count' anyway;
// splitting them out is both correct and clearer than relying on that.
await page.route('**/api/direct-messages/unread-count', async (route) => {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0 }) });
});
await page.route('**/api/direct-messages/mark-read', async (route) => {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) });
});

const requestedCursors = [];
await page.route('**/api/direct-messages*', async (route) => {
  const url = new URL(route.request().url());
  const cursor = url.searchParams.get('cursor');
  requestedCursors.push(cursor);
  if (!cursor) {
    // First (newest) page -- newest-first, same as the real backend.
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ messages: [fakeMessage(3), fakeMessage(2)], nextCursor: 'fake-cursor-page-2' }),
    });
    return;
  }
  if (cursor === 'fake-cursor-page-2') {
    // Second (older, last) page -- also newest-first within itself.
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ messages: [fakeMessage(1), fakeMessage(0)], nextCursor: null }),
    });
    return;
  }
  await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'unexpected cursor in test mock' }) });
});

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
// A fresh Build-mode signup opens #claim-modal, overlaying #account-menu-toggle
// (#1368) until a landlet is claimed.
await claimLandlet(page);

await openAccountMenu(page);
await page.click('#friends-btn');
await page.waitForSelector('#friends-modal.visible', { timeout: 5000 });
// #2637 (sub-issue of #2635): waitForFunction's signature is (pageFunction,
// arg, options) -- a bare (fn, { timeout }) call puts the options object in
// the `arg` slot instead, so `options` stayed undefined and the real applied
// timeout was always Playwright's actual default (30000ms), never the
// smaller number written here. The explicit `null` arg reaches the options
// slot, and the timeouts themselves are widened for real headroom under CI
// load, same margins #2636's own sibling leaf used.
await page.waitForFunction(() => document.querySelectorAll('#friends-accepted-list .friend-row').length > 0, null, { timeout: 30000 });
await page.locator('#friends-accepted-list .friend-row').filter({ hasText: FRIEND_LABEL }).locator('button', { hasText: 'Message' }).click();
await page.waitForSelector('#dm-modal.visible', { timeout: 5000 });

// First (mocked) page: 2 messages, chronologically ascending (Msg 2 above
// Msg 3), Load More visible since the mock reported a next page.
await page.waitForFunction(() => document.querySelectorAll('#dm-list .dm-row').length === 2, null, { timeout: 60000 });
const rowTextsFirstPage = await page.locator('#dm-list .dm-row').allTextContents();
const loadMoreVisibleFirstPage = await page.locator('#dm-load-more-btn').isVisible();
console.log('row texts after first (mocked) page (should be ["Msg 2...", "Msg 3..."]):', rowTextsFirstPage);
console.log('Load More ("Load older messages") visible after first page (should be true):', loadMoreVisibleFirstPage);

requestedCursors.length = 0;

// Click Load More: the two older messages appear ABOVE the already-shown
// ones (prepended, not appended) in correct chronological order, and since
// the mock's second page had no nextCursor, the button hides again.
await page.click('#dm-load-more-btn');
await page.waitForFunction(() => document.querySelectorAll('#dm-list .dm-row').length === 4, null, { timeout: 60000 });
const rowTextsAfterLoadMore = await page.locator('#dm-list .dm-row').allTextContents();
const loadMoreHiddenAfterLastPage = !(await page.locator('#dm-load-more-btn').isVisible());
console.log('row texts after Load More (should read oldest-to-newest, "Msg 0..." through "Msg 3..."):', rowTextsAfterLoadMore);
console.log('Load More hidden once there are no more pages (should be true):', loadMoreHiddenAfterLastPage);
console.log('cursor requested by the Load More click (should be ["fake-cursor-page-2"]):', requestedCursors);

const pass =
  rowTextsFirstPage.length === 2 &&
  rowTextsFirstPage[0].startsWith('Msg 2') &&
  rowTextsFirstPage[1].startsWith('Msg 3') &&
  loadMoreVisibleFirstPage &&
  rowTextsAfterLoadMore.length === 4 &&
  rowTextsAfterLoadMore[0].startsWith('Msg 0') &&
  rowTextsAfterLoadMore[1].startsWith('Msg 1') &&
  rowTextsAfterLoadMore[2].startsWith('Msg 2') &&
  rowTextsAfterLoadMore[3].startsWith('Msg 3') &&
  loadMoreHiddenAfterLastPage &&
  requestedCursors.length === 1 &&
  requestedCursors[0] === 'fake-cursor-page-2' &&
  errors.length === 0;
await finish(browser, { pass, label: 'DM thread paginates past the first page via Load More, prepended in order (#1677)', errors });
