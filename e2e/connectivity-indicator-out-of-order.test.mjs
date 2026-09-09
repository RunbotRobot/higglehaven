// Backlog audit, follow-up to #545: the six sync* functions in src/main.js
// fire fire-and-forget (never awaited by their own callers), so several can
// be in flight at once with no guarantee they RESOLVE in the order they were
// ISSUED -- especially not during the exact connectivity blip this indicator
// exists to show. This reproduces that: the FIRST create request is delayed
// and eventually fails, while a SECOND create request (issued right after,
// before the first has resolved) succeeds quickly. The straggling failure
// must not overwrite the more recent success -- the indicator should end up
// hidden, not stuck showing "unreachable" for a server that just proved it's
// reachable.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Out-of-Order Sync Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

async function placeTreeAt(x, y) {
  await page.click('#add-item-btn');
  await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
  await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
  await page.waitForTimeout(300);
  await page.mouse.click(x, y);
}

const indicatorHiddenInitially = await page.locator('#connectivity-indicator').isHidden();
console.log('indicator hidden before any sync (should be true):', indicatorHiddenInitially);

// First POST /api/instances is held open, then aborted (a genuine network-
// level failure) well after the second one below has already succeeded.
// Every later POST goes through untouched.
let postCount = 0;
await page.route('**/api/instances', async (route) => {
  if (route.request().method() !== 'POST') {
    await route.continue();
    return;
  }
  postCount += 1;
  if (postCount === 1) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.abort('failed');
    return;
  }
  await route.continue();
});

// Two placements issued back-to-back, well within the first request's own
// 1500ms delay -- the second one's request reaches the server and succeeds
// before the first one's failure ever lands.
await placeTreeAt(160, 400);
await page.waitForTimeout(150);
await placeTreeAt(260, 400);

// Long enough for the second (fast, successful) request to land AND for the
// first (slow, failing) request's 1500ms delay to fully elapse afterward --
// exercising the exact out-of-order-resolution window this test targets.
await page.waitForTimeout(2200);

const indicatorHiddenAfterStaleFailureArrives = await page.locator('#connectivity-indicator').isHidden();
console.log(
  'indicator hidden once a newer success has landed, even after an older, slower failure arrives later (should be true):',
  indicatorHiddenAfterStaleFailureArrives,
);

await page.unroute('**/api/instances');

const unexpectedErrors = errors.filter((e) => !e.includes('net::ERR_FAILED'));

const pass = indicatorHiddenInitially && indicatorHiddenAfterStaleFailureArrives && unexpectedErrors.length === 0;
await finish(browser, {
  pass,
  label: 'Connectivity indicator ignores a stale, out-of-order sync failure (backlog audit, follow-up to #545)',
  errors: unexpectedErrors,
});
