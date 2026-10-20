// #2436: pollNearbyPresenceIfNeeded used to delete a shopOtherAvatars entry
// the instant a single GET /api/presence poll came back without it, with no
// debounce -- if that gap landed on exactly the frame a landing's own
// nearestOpenLandingSpot/landingSpotOccupiedByAvatar check ran (#2044), the
// collision-avoidance nudge was skipped outright rather than delayed.
// Confirmed as a real (non-forced) failure via #2457. Reproduces the
// underlying race with the same controlled method #2436's own investigation
// used -- forcing a real GET /api/presence response to come back empty --
// rather than racing real landing-flight timing against it, which is
// exactly what made the real failure a rare, hard-to-hit flake in the first
// place.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL_A = 'Missed Poll Builder A';
const LABEL_B = 'Missed Poll Builder B';
const LANDLET_ID = 'missed-poll-landlet';

const sessionA = await launchPage({ promptAnswer: LABEL_A });
const sessionB = await launchPage({ promptAnswer: LABEL_B });
const errors = [...sessionA.errors, ...sessionB.errors];
const pageA = sessionA.page;
const pageB = sessionB.page;

async function fetchJson(page, path, options) {
  return page.evaluate(async ([p, opts]) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(p, opts);
        return { status: res.status, body: await res.json() };
      } catch (err) {
        if (attempt > 0) throw err;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }, [path, options]);
}

await chooseIdentity(pageA, { mode: 'build', label: LABEL_A, isNew: true });
const builderA = (await fetchJson(pageA, '/api/builders/me')).body.builder;

const landletCreated = await fetchJson(pageA, '/api/landlets', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    landletId: LANDLET_ID,
    name: 'Missed Poll Landlet',
    areaM2: 1000,
    status: 'claimed',
    ownerBuilderId: builderA.builderId,
  }),
});
console.log('landlet created at the default (0,0) center (status should be 201):', landletCreated.status);

await pageA.reload({ waitUntil: 'networkidle' });
await pageA.waitForSelector('#shop-fly-btn.visible', { timeout: 15000 });
await pageA.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });
// #2043: every fresh Shop-mode spawn starts already airborne -- this tap
// starts a real landing, same discovery
// e2e/shop-landing-spot-avatar-collision.test.mjs's own comment documents.
await pageA.click('#shop-fly-btn');
await pageA.waitForTimeout(2500); // past SHOP_FLIGHT_LANDING_DURATION_S (2s) -- now 'grounded'

await chooseIdentity(pageB, { mode: 'build', label: LABEL_B, isNew: true });
const builderB = (await fetchJson(pageB, '/api/builders/me')).body.builder;

await pageB.reload({ waitUntil: 'networkidle' });
await pageB.waitForSelector('#shop-fly-btn.visible', { timeout: 15000 });
await pageB.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });
await pageB.click('#shop-fly-btn');
await pageB.waitForTimeout(2500); // past SHOP_FLIGHT_LANDING_DURATION_S (2s) -- now 'grounded'

// Give both poll loops (1000ms interval) a couple of cycles to pick each
// other up, same margin e2e/shop-landing-spot-avatar-collision.test.mjs uses.
await pageA.waitForTimeout(3000);
await pageB.waitForTimeout(500);

const seenBeforeMiss = await pageA.evaluate(() => window.__shopOtherAvatars);
const bEntryBeforeMiss = seenBeforeMiss?.find((a) => a.builderId === builderB.builderId);
console.log('B as seen by A before any forced miss (should be a real {x, y, ...}):', bEntryBeforeMiss);

// Force A's own GET /api/presence polls to come back empty for however many
// of A's own polls `missesToForce` currently allows -- never touches B's
// requests (this route is installed on pageA only).
let getPresenceCount = 0;
let missesToForce = 0;
await pageA.route('**/api/presence', async (route) => {
  if (route.request().method() !== 'GET') {
    await route.continue();
    return;
  }
  getPresenceCount++;
  if (getPresenceCount <= missesToForce) {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ avatars: [] }) });
    return;
  }
  await route.continue();
});

// Waits until the route handler above has actually observed `count` GET
// /api/presence requests from A, rather than guessing a wall-clock sleep
// long enough to cover that many poll ticks -- the poll loop's own interval
// (SHOP_PRESENCE_POLL_INTERVAL_MS) is a minimum gap between tick starts,
// not a guarantee of how many ticks land in a given wall-clock window under
// real (possibly CI-loaded) timing. Tying the wait to the actual observed
// count is exactly the fix this test is itself about: don't assume a fixed
// number of polls happened just because "enough time" seemingly passed.
async function waitForPresencePollCount(count, timeoutMs = 20000) {
  const start = Date.now();
  while (getPresenceCount < count) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${count} GET /api/presence poll(s) -- stuck at ${getPresenceCount}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // The route handler resolving the request (Node-side) is not the same
  // moment the client has fully received and processed that response into
  // shopOtherAvatars -- under heavy load both the network round-trip and
  // the client's own JS turn can be delayed well past a token buffer, so
  // this margin is deliberately generous rather than tuned to the
  // untroubled case.
  await pageA.waitForTimeout(2000);
}

// --- One forced-empty poll: B must survive it -- this is the actual fix. ---
missesToForce = 1;
getPresenceCount = 0;
await waitForPresencePollCount(1);
const seenAfterOneMiss = await pageA.evaluate(() => window.__shopOtherAvatars);
const bEntryAfterOneMiss = seenAfterOneMiss?.find((a) => a.builderId === builderB.builderId);
console.log('B as seen by A right after exactly one forced-empty poll (should SURVIVE):', bEntryAfterOneMiss);

// --- A real poll afterward recovers normally -- B stays correctly tracked,
// not left in some half-missed limbo state. Any poll past the first one is
// real (missesToForce is still 1), so waiting for a second observed poll
// guarantees at least one real recovery poll happened.
await waitForPresencePollCount(2);
const seenAfterRecovery = await pageA.evaluate(() => window.__shopOtherAvatars);
const bEntryAfterRecovery = seenAfterRecovery?.find((a) => a.builderId === builderB.builderId);
console.log('B as seen by A after a real poll recovers from the one miss:', bEntryAfterRecovery);

// --- Two consecutive forced-empty polls: B must now actually be removed --
// confirms the debounce doesn't become a permanent "never removes a
// genuinely departed avatar" leak. Keeps forcing empty responses well past
// the second miss (B never actually left in this simulation -- it's still
// really there and still really polling/reporting), rather than stopping at
// exactly 2 and hoping to read state before the very next real poll lands
// and legitimately re-adds B as a "new" avatar again. That race is real:
// the next real tick follows the forced ones by only about one poll
// interval, so a generous read-after margin here would otherwise just
// catch the resurrection, not the eviction.
missesToForce = 1000;
getPresenceCount = 0;
await waitForPresencePollCount(2);
const seenAfterTwoMisses = await pageA.evaluate(() => window.__shopOtherAvatars);
const bEntryAfterTwoMisses = seenAfterTwoMisses?.find((a) => a.builderId === builderB.builderId);
console.log('B as seen by A after two consecutive forced-empty polls (should be GONE):', bEntryAfterTwoMisses);

const pass =
  landletCreated.status === 201 &&
  !!bEntryBeforeMiss &&
  !!bEntryAfterOneMiss &&
  !!bEntryAfterRecovery &&
  !bEntryAfterTwoMisses &&
  errors.length === 0;

await sessionB.browser.close();
await finish(sessionA.browser, {
  pass,
  label: '#2436: a single missed presence poll does not drop a still-present avatar outright',
  errors,
});
