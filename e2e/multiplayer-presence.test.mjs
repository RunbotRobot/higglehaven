// #1100 (sub-issue of #1095, core multiplayer presence): the client-side
// report-loop (POST /api/presence, #1098) + poll-loop (GET /api/presence,
// #1099) + smoothing this issue adds on top of those two already-merged
// endpoints. Two independent browser pages stand in for two different
// builders, the same pattern e2e/friends.test.mjs/land-auctions.test.mjs
// already use, since multiplayer presence is inherently a two-party thing
// to actually observe.
//
// Before #1175, both builders' own Shop-mode avatar spawned at the exact
// same world point (shopAvatarPosition.set(0, 0, 0) in enterShopMode — true
// regardless of which lándlet either of them actually claimed), so rather
// than scripting precise joystick/camera movement to get two sessions
// standing in the same spot, this creates one lándlet directly at the
// default center (0,0) via POST /api/landlets (validateLandlet's own
// center.x/y default) with builder A as its owner — the same "skip the
// real claim-map flow, same invariants either way" shortcut other worker
// tests already use for landlet setup.
//
// #1175: every spawn now picks a random location and starts a hands-off
// orbit around the world center instead — still guaranteed inside this
// same single lándlet (its own area is this test's entire "world," so
// shopMaxRadiusM() never exceeds the lándlet's own bounds), but no longer
// at a known (0,0) point, and not even stationary until something stops
// the orbit. One tap of #shop-fly-btn (its handler calls
// stopShopSpawnRotation() before anything else) freezes each avatar in
// place the instant it's tapped, restoring "stationary at *a* point inside
// the lándlet" — just not literally (0,0) anymore. The checks below
// compare each avatar's position as read through two different pipelines
// (a direct GET /api/presence vs. the poll loop's rendered
// window.__shopOtherAvatars) against each other instead of against a
// hardcoded (0,0), which is actually a strictly stronger check of the
// report/poll/smoothing pipeline this issue's own header comment above
// describes, not a weaker stand-in for the old one.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL_A = 'Presence Suite Builder A';
const LABEL_B = 'Presence Suite Builder B';
const LANDLET_ID = 'presence-suite-landlet';

const sessionA = await launchPage({ promptAnswer: LABEL_A });
const sessionB = await launchPage({ promptAnswer: LABEL_B });
const errors = [...sessionA.errors, ...sessionB.errors];
const pageA = sessionA.page;
const pageB = sessionB.page;

async function fetchJson(page, path, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [path, options]);
}

await chooseIdentity(pageA, { mode: 'build', label: LABEL_A, isNew: true });
const builderA = (await fetchJson(pageA, '/api/builders/me')).body.builder;

const landletCreated = await fetchJson(pageA, '/api/landlets', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    landletId: LANDLET_ID,
    name: 'Presence Suite Landlet',
    areaM2: 1000,
    status: 'claimed',
    ownerBuilderId: builderA.builderId,
  }),
});
console.log('landlet created at the default (0,0) center (status should be 201):', landletCreated.status);

// Builder A enters Shop mode — spawns at a random point inside the
// lándlet just created (#1175), so updateShopLandletInfo resolves
// shopCurrentLandletEntry to it immediately without needing any movement.
// A plain reload rather than clicking the shop nav button: entering
// 'build' mode above (via chooseIdentity) already auto-opened the real
// claim-lándlet modal for this brand-new, still-unclaimed-through-the-UI
// builder (its own resolveLandletId gate, unrelated to the lándlet just
// created directly via the API above) and nothing has dismissed it — a
// reload re-runs bootstrap() fresh with no sessionStorage start-mode set,
// which defaults to Shop (see bootstrap's own comment), skipping that gate
// entirely rather than fighting the now-open modal for the click.
await pageA.reload({ waitUntil: 'networkidle' });
await pageA.waitForSelector('#shop-fly-btn.visible', { timeout: 15000 });
// #688/#1175: `#shop-fly-btn.visible` is set at the *start* of
// enterShopMode's post-gate world build, well before the random spawn
// location/orbit this test is about to freeze gets set at the very *end*
// of it (see e2e/flight.test.mjs's own identical comment) — wait for
// `#shop-status` losing `.visible` too, or the freeze tap below could
// race the spawn code and get silently undone the instant it finally runs.
await pageA.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });
await pageA.click('#shop-fly-btn'); // freezes A's position — see #1175 comment above
await pageA.waitForTimeout(100);

// reportOwnPresenceIfNeeded's own throttle always reports on its very
// first eligible tick regardless of movement (shopLastReportedPosition
// starts null) — just needs SHOP_PRESENCE_REPORT_INTERVAL_MS (1500) to
// have elapsed once in Shop mode.
await pageA.waitForTimeout(2500);

await chooseIdentity(pageB, { mode: 'build', label: LABEL_B, isNew: true });
const builderB = (await fetchJson(pageB, '/api/builders/me')).body.builder;

// Confirms the real report loop actually wrote a real row — fetched as a
// genuinely different builder (B), since #1099's own GET excludes the
// caller's own row, so this couldn't accidentally be reading A's row back
// through A's own session instead. This is this test's own ground truth
// for A's (random, #1175) position, read directly rather than assumed.
const presenceBeforeBJoins = await fetchJson(pageB, `/api/presence?landletId=${LANDLET_ID}`);
console.log('presence row for builder A, fetched as builder B:', presenceBeforeBJoins.body);
const aRowSeenByB = presenceBeforeBJoins.body.avatars?.find((a) => a.builderId === builderA.builderId);

// Builder B enters Shop mode too — another random spawn (#1175), same
// lándlet, frozen the same way A's was above. Same reload-not-click
// reasoning as builder A above (B's own 'build' entry opened its own claim
// modal too, for its own still-unclaimed account).
await pageB.reload({ waitUntil: 'networkidle' });
await pageB.waitForSelector('#shop-fly-btn.visible', { timeout: 15000 });
await pageB.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });
await pageB.click('#shop-fly-btn'); // freezes B's position — see #1175 comment above
await pageB.waitForTimeout(100);

// Give both sides' poll loops (SHOP_PRESENCE_POLL_INTERVAL_MS = 1000) a
// couple of cycles to actually pick each other up and update the
// window.__shopOtherAvatars diagnostic (refreshOtherShopAvatarsDiagnostic).
await pageA.waitForTimeout(3000);
await pageB.waitForTimeout(500); // B's own first poll already overlapped the wait above

// B's own ground-truth position, read directly the same way A's was above
// (now that B has reported at least once too) — fetched as A for the same
// "not your own row" reason.
const presenceAfterBJoins = await fetchJson(pageA, `/api/presence?landletId=${LANDLET_ID}`);
const bRowSeenByA = presenceAfterBJoins.body.avatars?.find((a) => a.builderId === builderB.builderId);

const bOthersSeenByA = await pageA.evaluate(() => window.__shopOtherAvatars);
const aOthersSeenByB = await pageB.evaluate(() => window.__shopOtherAvatars);
console.log('other avatars rendered in A\'s own scene (should include B, not A itself):', bOthersSeenByA);
console.log('other avatars rendered in B\'s own scene (should include A, not B itself):', aOthersSeenByB);

const bEntryInA = bOthersSeenByA?.find((a) => a.builderId === builderB.builderId);
const aEntryInB = aOthersSeenByB?.find((a) => a.builderId === builderA.builderId);
// #1175: compares each avatar's position across two independent pipelines
// (a direct GET vs. the poll loop's smoothed render) rather than against a
// hardcoded (0,0) — see this file's own header comment for why.
const near = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 0.5;

const pass =
  landletCreated.status === 201 &&
  !!aRowSeenByB && !!bRowSeenByA &&
  !bOthersSeenByA?.some((a) => a.builderId === builderA.builderId) && // never lists yourself
  !aOthersSeenByB?.some((a) => a.builderId === builderB.builderId) &&
  !!bEntryInA && near(bEntryInA.x, bRowSeenByA.x) && near(bEntryInA.y, bRowSeenByA.y) &&
  !!aEntryInB && near(aEntryInB.x, aRowSeenByB.x) && near(aEntryInB.y, aRowSeenByB.y) &&
  errors.length === 0;

await sessionB.browser.close();
await finish(sessionA.browser, {
  pass,
  label: 'Multiplayer presence: report loop + poll loop + render other avatars (#1100)',
  errors,
});
