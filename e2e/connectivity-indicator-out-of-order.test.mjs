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

const isPostInstances = (req) => req.url().includes('/api/instances') && req.method() === 'POST';

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

// #980: this used to gate both the second placement's issuance and the final
// assertion on flat page.waitForTimeout() margins (150ms / 2200ms) sized to
// comfortably clear the artificial 1500ms delay above -- under real CI
// runner-load contention those margins aren't actually guaranteed, making
// this test intermittently flaky for reasons that have nothing to do with
// the connectivity-indicator logic it's meant to verify. Waiting on the
// actual network events instead (the first request having been dispatched,
// then its failure and the second request's success having both actually
// landed) makes the test's timing follow real cause-and-effect rather than a
// guessed wall-clock margin, however loaded the runner is.
const firstRequestIssued = page.waitForRequest(isPostInstances, { timeout: 10000 });

await placeTreeAt(160, 400);
// Only the FIRST request needs to have reached the network layer before the
// second one is issued -- the second still lands and resolves well within
// the first's own 1500ms artificial delay either way.
await firstRequestIssued;

const firstRequestFailed = page.waitForEvent('requestfailed', { predicate: isPostInstances, timeout: 15000 });
const secondRequestSucceeded = page.waitForResponse(
  (response) => isPostInstances(response.request()),
  { timeout: 15000 },
);

await placeTreeAt(260, 400);

// Waits until both the slow request's failure and the fast request's success
// have actually reached the page -- not just "long enough that they probably
// have" -- exercising the exact out-of-order-resolution window this test
// targets regardless of how long either one actually took.
await Promise.all([firstRequestFailed, secondRequestSucceeded]);
// Small, fixed buffer for the page's own promise-rejection/resolution
// handlers (reportSyncResult, a plain synchronous microtask) to run after
// the network event above lands -- not a guess at how long the network
// operation itself takes, unlike the timeouts this replaces.
await page.waitForTimeout(200);

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
