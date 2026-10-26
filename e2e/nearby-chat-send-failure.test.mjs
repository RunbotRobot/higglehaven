// #2796: src/shop/nearbyChat.js's submit handler used to clear the input
// optimistically, before the server confirmed the send -- any rejection
// (rate limit, stale presence, network) hit an empty `.catch(() => {})` and
// the typed message simply vanished with no trace and no way to retry it,
// same silent-drop shape the credit-orb rate-limit bug (#2774) had. Fixed
// to mirror src/account/menu.js's own dmComposeForm submit handler, the
// structurally identical DM-send case, which already gets this right:
// don't clear the input until the send resolves, and surface err.message
// in a visible status element on failure.
//
// This deployment never configures DIDIT_API_KEY, so there's no real way
// to drive an account to trust_tier === 'id_verified' (required for nearby
// chat at all, per #1637's own stricter gate) -- same reachability gap
// e2e/dm-badge.test.mjs/e2e/dm-load-more.test.mjs already document and
// work around by mocking GET /api/auth/me's own trustTier field. Mocking
// the send endpoint itself to reject lets this test exercise the frontend
// failure-handling in isolation, without needing to actually exhaust
// NEARBY_CHAT_SEND_RATE_LIMIT_MAX for real.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL = 'Nearby Chat Send Failure Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

// chooseIdentity signs up fresh (POST /api/auth/signup) and sets
// currentAuthUser straight from that response (src/account/auth.js) --
// nothing re-fetches /api/auth/me afterward in Shop mode's own flow (no
// account-menu-opening step the way e2e/dm-badge.test.mjs's Build-mode
// path has), so the signup response itself needs the same trustTier patch
// as /api/auth/me, not just that endpoint alone.
async function patchTrustTierToIdVerified(route) {
  const response = await route.fetch();
  const body = await response.json();
  if (body.user) body.user.trustTier = 'id_verified';
  await route.fulfill({ response, contentType: 'application/json', body: JSON.stringify(body) });
}
await page.route('**/api/auth/me', patchTrustTierToIdVerified);
await page.route('**/api/auth/signup', patchTrustTierToIdVerified);

await page.route('**/api/nearby-chat?*', async (route) => {
  // The poll loop -- always report an empty, going-nowhere log so this
  // test's own failed send is the only thing ever rendered to it.
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ messages: [], nextCursor: null }) });
});

await page.route('**/api/nearby-chat', async (route) => {
  if (route.request().method() !== 'POST') {
    await route.fallback();
    return;
  }
  await route.fulfill({
    status: 429,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'Too many attempts. Please wait a while and try again.' }),
  });
});

await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 10000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });

await page.waitForSelector('#shop-nearby-chat-btn.visible', { timeout: 10000 });
await page.click('#shop-nearby-chat-btn');
await page.waitForSelector('#shop-nearby-chat-panel.open', { timeout: 5000 });

const MESSAGE_TEXT = 'hello from a failed send';
await page.fill('#shop-nearby-chat-input', MESSAGE_TEXT);
await page.click('#shop-nearby-chat-form button[type="submit"]');

// Poll for the real end state -- the rejected send's own .catch() can
// legitimately take a tick to land, same "poll, don't fixed-wait" idiom
// e2e/credit-orb-survives-rate-limit.test.mjs's own comment already
// documents for an analogous 429-after-submit case.
const statusShowsError = await page.waitForFunction(
  () => document.querySelector('#shop-nearby-chat-status')?.classList.contains('error'),
  null,
  { timeout: 5000 },
).then(() => true).catch(() => false);
console.log('visible error shown after the rejected send (should be true, was the #2796 bug -- used to show nothing):', statusShowsError);

const statusText = await page.locator('#shop-nearby-chat-status').textContent();
console.log('error text (should mention the rate-limit message):', statusText);

const inputPreserved = await page.inputValue('#shop-nearby-chat-input');
console.log('typed message preserved in the input after the failed send (should be true, was lost before #2796):', inputPreserved === MESSAGE_TEXT);

const logIsEmpty = (await page.locator('#shop-nearby-chat-log .shop-nearby-chat-message').count()) === 0;
console.log('nothing appended to the chat log for the failed send (should be true):', logIsEmpty);

// The deliberate 429 above, and the real backend correctly rejecting
// requests from other endpoints that check trust_tier server-side (this
// test only spoofs trustTier client-side, via the signup/me response
// patch above, not the real account record) are both expected fallout
// from this test's own setup -- the same "Failed to load resource" noise
// e2e/seller-feedback.test.mjs's own comment already documents filtering
// out for an analogous deliberate-rejection case.
const unexpectedErrors = errors.filter((e) => !e.includes('Failed to load resource'));

const pass =
  statusShowsError &&
  /Too many attempts/i.test(statusText || '') &&
  inputPreserved === MESSAGE_TEXT &&
  logIsEmpty &&
  unexpectedErrors.length === 0;
await finish(browser, { pass, label: 'Nearby chat preserves the typed message and shows a visible error on a rejected send, instead of silently dropping it (#2796)', errors });
