// #1661: GET /api/direct-messages/unread-count and its frontend fetcher
// (fetchUnreadDirectMessageCount, src/api.js) already existed, but nothing
// ever called the fetcher -- no #dm-badge element, no refreshDmBadge().
// This verifies the newly-added wiring (dm-badge markup + refreshDmBadge +
// its call sites) actually reflects a real response into the DOM.
//
// Like e2e/direct-messages-gating.test.mjs's own header comment explains,
// this deployment never configures DIDIT_API_KEY, so there's no way to
// drive a real account to trust_tier === 'id_verified' -- the real
// unread-count endpoint (requireIdVerifiedSessionBuilder-gated) would
// always 403 here. refreshDmBadge() itself is gated client-side on
// currentAuthUser.trustTier === 'id_verified' (same check the "Message"
// button's own visibility uses, per #1637), to avoid ever making a request
// that would always 403 for any non-id_verified account -- so reaching it
// at all needs /api/auth/me's own trustTier patched to 'id_verified' too,
// not just mocking the unread-count response in isolation. Mocking both
// (same approach e2e/community-sign-truncation.test.mjs already uses for
// an analogous hard-to-reach-for-real case) tests the frontend wiring in
// isolation from that unrelated reachability gap.
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, finish } from './helpers.mjs';

const LABEL = 'DM Badge Suite Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await page.route('**/api/auth/me', async (route) => {
  const response = await route.fetch();
  const body = await response.json();
  if (body.user) body.user.trustTier = 'id_verified';
  await route.fulfill({ response, contentType: 'application/json', body: JSON.stringify(body) });
});

async function mockUnreadCount(count) {
  await page.route('**/api/direct-messages/unread-count', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count }) });
  });
}

// Both mocks must be live before chooseIdentity/claimLandlet ever run --
// refreshDmBadge() fires from real, already-reachable bootstrap call sites
// (not just the Friends-panel one triggerDmBadgeRefresh uses below) the
// moment login completes and currentAuthUser.trustTier reads 'id_verified',
// so registering either mock any later leaves that first real call racing
// the real (always-403) backend endpoint before this test is ready for it.
await mockUnreadCount(0);

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
// A fresh Build-mode signup opens #claim-modal, which overlays #account-menu-toggle
// (per #1368) until a landlet is claimed -- every other Build-mode test calls this
// right after chooseIdentity for the same reason.
await claimLandlet(page);

// closeFriendsModal (src/main.js) calls refreshDmBadge() alongside its own
// refreshFriendsBadge() -- opening then closing the Friends panel is a
// real, already-reachable trigger for it, no need to reach Shop mode's
// own bootstrap call.
async function triggerDmBadgeRefresh() {
  await openAccountMenu(page);
  await page.click('#friends-btn');
  await page.waitForSelector('#friends-modal.visible', { timeout: 5000 });
  await page.click('#friends-close-btn');
  await page.waitForTimeout(300);
}

// #account-menu-panel (the badge's own ancestor) auto-collapses to
// display:none the moment #friends-btn is clicked (see openAccountMenu's own
// comment in helpers.mjs), so Playwright's isVisible() -- which also checks
// every ancestor's rendering -- is never a meaningful signal here regardless
// of the badge's own hidden attribute. Checking .hidden directly matches
// what refreshDmBadge actually controls.
await mockUnreadCount(3);
await triggerDmBadgeRefresh();
const badgeTextWithUnread = await page.locator('#dm-badge').textContent();
const badgeHiddenWithUnread = await page.locator('#dm-badge').evaluate((el) => el.hidden);
console.log('#dm-badge text after a mocked count of 3 (should be "3"):', badgeTextWithUnread);
console.log('#dm-badge hidden after a mocked count of 3 (should be false):', badgeHiddenWithUnread);

await mockUnreadCount(0);
await triggerDmBadgeRefresh();
const badgeHiddenAfterClearing = await page.locator('#dm-badge').evaluate((el) => el.hidden);
console.log('#dm-badge hidden after a mocked count of 0 (should be true):', badgeHiddenAfterClearing);

await page.unroute('**/api/direct-messages/unread-count');
await page.unroute('**/api/auth/me');

const pass =
  badgeTextWithUnread === '3' &&
  badgeHiddenWithUnread === false &&
  badgeHiddenAfterClearing === true &&
  errors.length === 0;
await finish(browser, { pass, label: '#1661: #dm-badge reflects fetchUnreadDirectMessageCount via refreshDmBadge', errors });
