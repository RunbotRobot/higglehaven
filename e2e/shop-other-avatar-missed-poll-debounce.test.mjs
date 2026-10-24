// #2436: pollNearbyPresenceIfNeeded used to despawn an other-avatar entry
// the instant a single GET /api/presence response came back without it --
// no debounce at all. That's the exact mechanism that can silently skip
// updateShopFlight's landing branch's own #2044 collision-avoidance nudge,
// if the one missed poll happens to land on the frame the nudge decision
// is made. This drives the same controlled reproduction the issue itself
// used (intercepting real GET /api/presence responses) rather than relying
// on the real-world trigger (still unconfirmed) actually firing in CI --
// same page.route technique e2e/multiplayer-presence.test.mjs's own #1911
// test uses for the sibling "stale response" race on this same poll loop.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL_A = 'Missed-Poll Debounce Builder A';
const LABEL_B = 'Missed-Poll Debounce Builder B';
const LANDLET_ID = 'missed-poll-debounce-landlet';

const sessionA = await launchPage({ promptAnswer: LABEL_A });
const sessionB = await launchPage({ promptAnswer: LABEL_B });
const errors = [...sessionA.errors, ...sessionB.errors];
const pageA = sessionA.page;
const pageB = sessionB.page;

// #1881: one retry absorbs a transient "Failed to fetch" under concurrent-
// shard CI load, same as e2e/multiplayer-presence.test.mjs's own helper.
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
    name: 'Missed-Poll Debounce Landlet',
    areaM2: 1000,
    status: 'claimed',
    ownerBuilderId: builderA.builderId,
  }),
});
console.log('landlet created (status should be 201):', landletCreated.status);

// Same reload-not-click / freeze-via-fly-button / wait-past-landing sequence
// as e2e/multiplayer-presence.test.mjs's own setup -- see that file's
// comments for why each step is needed.
await pageA.reload({ waitUntil: 'networkidle' });
await pageA.waitForSelector('#shop-fly-btn.visible', { timeout: 15000 });
await pageA.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });
await pageA.click('#shop-fly-btn');
await pageA.waitForTimeout(2500); // past SHOP_FLIGHT_LANDING_DURATION_S (2s) -- now grounded
await pageA.waitForTimeout(2500); // past SHOP_PRESENCE_REPORT_INTERVAL_MS (1500) once

await chooseIdentity(pageB, { mode: 'build', label: LABEL_B, isNew: true });
const builderB = (await fetchJson(pageB, '/api/builders/me')).body.builder;
// #2269: GET /api/presence derives the landlet to query from the caller's
// own last-reported presence row -- B needs one before A's poll can see it.
await fetchJson(pageB, '/api/presence', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ x: 0, y: 0, z: 0, heading: 0, landletId: LANDLET_ID }),
});

await pageB.reload({ waitUntil: 'networkidle' });
await pageB.waitForSelector('#shop-fly-btn.visible', { timeout: 15000 });
await pageB.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });
await pageB.click('#shop-fly-btn');
await pageB.waitForTimeout(2500);

// Give A's own poll loop (SHOP_PRESENCE_POLL_INTERVAL_MS = 1000) a chance to
// pick B up before touching anything. A fixed margin here was the same
// repeat-offender "too tight under CI load" shape #2567's own fix below
// already converted for the post-despawn snapshot -- polling for the real
// state instead of guessing at a margin, so a genuine failure to ever pick
// B up still surfaces in the diagnostic below rather than this just being a
// longer and longer fixed wait.
await pageA
  .waitForFunction(
    (builderId) => (window.__shopOtherAvatars ?? []).some((a) => a.builderId === builderId),
    builderB.builderId,
    { timeout: 10000 },
  )
  .catch(() => {});

const baseline = await pageA.evaluate(() => window.__shopOtherAvatars);
const bEntryBaseline = baseline?.find((a) => a.builderId === builderB.builderId);
console.log('B as seen by A before any missed poll (should be present):', bEntryBaseline);

// Intercepts exactly the next two consecutive real GET /api/presence calls
// A's own poll loop issues and serves each an empty `{ avatars: [] }` --
// simulating B genuinely missing from two polls in a row, the controlled
// reproduction #2436's own report used to confirm the despawn mechanism.
// missesToServe only ever decrements inside this handler, so no real
// (B-including) response can slip in between the two intercepted ones.
let missesToServe = 2;
let missesServed = 0;
await pageA.route('**/api/presence*', async (route) => {
  if (route.request().method() === 'GET' && missesToServe > 0) {
    missesToServe -= 1;
    missesServed += 1;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ avatars: [] }) });
    return;
  }
  await route.continue();
});

while (missesServed < 1) {
  await pageA.waitForTimeout(50);
}
// Margin for pollNearbyPresenceIfNeeded to actually process this single
// empty response before the next snapshot -- deliberately well under
// SHOP_PRESENCE_POLL_INTERVAL_MS (1000ms) so this check runs before the
// NEXT poll tick fires (which would otherwise consume the second
// intercepted miss before this snapshot ever saw the first one alone).
await pageA.waitForTimeout(400);
const afterOneMiss = await pageA.evaluate(() => window.__shopOtherAvatars);
const bEntryAfterOneMiss = afterOneMiss?.find((a) => a.builderId === builderB.builderId);
console.log('B as seen by A after exactly ONE missed poll (should still be present -- #2436 debounce):', bEntryAfterOneMiss);

while (missesServed < 2) {
  await pageA.waitForTimeout(50);
}
// #2567: a fixed 400ms margin here was too tight under CI load for
// pollNearbyPresenceIfNeeded to actually finish processing the second miss
// (the route handler fulfilling, the fetch resolving, the despawn loop
// running) before the snapshot below was taken -- polling for the real
// end state instead, same page.waitForFunction idiom
// e2e/upload-video-generation-entry-point.test.mjs uses for its own
// analogous race (#2521/#2524). Swallowing a timeout here rather than
// letting it throw: if the despawn genuinely never happens (a real product
// regression, not a timing issue), afterTwoMisses below still shows B
// present and the pass check below fails with that diagnostic, instead of
// an unhandled Playwright exception.
await pageA
  .waitForFunction(
    (builderId) => !(window.__shopOtherAvatars ?? []).some((a) => a.builderId === builderId),
    builderB.builderId,
    { timeout: 10000 },
  )
  .catch(() => {});
const afterTwoMisses = await pageA.evaluate(() => window.__shopOtherAvatars);
const bEntryAfterTwoMisses = afterTwoMisses?.find((a) => a.builderId === builderB.builderId);
console.log('B as seen by A after TWO CONSECUTIVE missed polls (should now be despawned):', bEntryAfterTwoMisses);

const pass =
  landletCreated.status === 201 &&
  !!bEntryBaseline &&
  !!bEntryAfterOneMiss &&
  !bEntryAfterTwoMisses;

await sessionB.browser.close();
await finish(sessionA.browser, {
  pass,
  label: 'pollNearbyPresenceIfNeeded debounces a despawn across SHOP_OTHER_AVATAR_MISSED_POLLS_BEFORE_DESPAWN consecutive missed polls (#2436)',
  errors,
});
