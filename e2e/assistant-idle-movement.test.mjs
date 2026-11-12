// #3449 (part of #3444): an assistant on shift is not a statue. The server places
// it at one spot; the client gives it a small seeded wander around that spot
// (src/shop/assistantIdle.js). A is an ordinary shopper at phone width; B stands
// in the same landlet and is made an assistant account (users.is_fleet plus a
// reserved agent name, set directly in the local D1: fleet-login itself needs a
// deployment secret). Sampled over time through __testShopOtherAvatarPoses: the
// wander (the offset the client adds to the placed spot) changes and never exceeds
// the wander radius, and the heading changes; the longest frame while it does so
// is reported. Then B's account stops reporting (its browser closes, presence
// goes stale after 10 s) and A sees it leave through fog: a departing state with
// the avatar still there, then gone. Setup is e2e/assistant-look.test.mjs's.
import { execSync } from 'node:child_process';
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL_A = 'Assistant Idle Builder A';
const LABEL_B = 'Assistant Idle Builder B';
const LANDLET_ID = 'assistant-idle-landlet';

const sessionA = await launchPage({ promptAnswer: LABEL_A, viewport: { width: 390, height: 800 } });
const sessionB = await launchPage({ promptAnswer: LABEL_B, viewport: { width: 390, height: 800 } });
const pageA = sessionA.page;
const pageB = sessionB.page;

// #1881: under concurrent-shard CI load, fetch() inside page.evaluate can
// throw "TypeError: Failed to fetch" outright (not an HTTP error status) --
// the local wrangler dev server dropping/refusing a connection, not a
// product bug. One retry after a short pause absorbs that transient
// network-level hiccup without masking a real, repeatable failure (a
// second genuine failure still throws).
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
    name: 'Assistant Idle Landlet',
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
// #2043: every fresh Shop-mode spawn actually starts already airborne —
// 'flying', descending from a real altitude as part of the spawn's own
// intro -- not 'grounded' as this test's own original comment ("freezes
// A's position") implied. So this tap (toggleShopFlight) starts a real
// *landing*, not a takeoff -- confirmed directly: shopFlightState is
// 'flying' (#shop-fly-btn.active/body.shop-flying both true) from the
// very first frame after spawn, before any click at all.
await pageA.click('#shop-fly-btn'); // freezes A's position (stops the orbit) and starts landing — see #1175 comment above
// docs/SPEC.md's "Flying avatars are invisible to other users" means GET
// /api/presence now withholds a flying builder's row from anyone else —
// wait past the landing animation's own fixed duration (same margin
// e2e/flight.test.mjs's own takeoff/landing test uses) so A is genuinely
// grounded before the presence checks below run, rather than the
// original 100ms (which left A still mid-descent, still flying, and
// thus invisible for the rest of this test). x/y never move during a
// vertical-only landing with no joystick input, so this doesn't disturb
// the "frozen position" this test actually needs.
await pageA.waitForTimeout(2500); // past SHOP_FLIGHT_LANDING_DURATION_S (2s) -- now 'grounded'

// reportOwnPresenceIfNeeded's own throttle always reports on its very
// first eligible tick regardless of movement (shopLastReportedPosition
// starts null) — just needs SHOP_PRESENCE_REPORT_INTERVAL_MS (1500) to
// have elapsed once in Shop mode.
await pageA.waitForTimeout(2500);

await chooseIdentity(pageB, { mode: 'build', label: LABEL_B, isNew: true });
const builderB = (await fetchJson(pageB, '/api/builders/me')).body.builder;

// #2269: GET /api/presence now derives the landlet to query from the
// caller's own last-reported presence row, not a client-supplied query
// param -- B needs a presence row of its own in this landlet before this
// GET can see anyone else in it at all, so this reports one directly (B
// hasn't entered Shop mode yet at this point in the test; the real report
// loop below is what keeps it current from here on).
await fetchJson(pageB, '/api/presence', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ x: 0, y: 0, z: 0, heading: 0, landletId: LANDLET_ID }),
});

// Confirms the real report loop actually wrote a real row — fetched as a
// genuinely different builder (B), since #1099's own GET excludes the
// caller's own row, so this couldn't accidentally be reading A's row back
// through A's own session instead. This is this test's own ground truth
// for A's (random, #1175) position, read directly rather than assumed.
const presenceBeforeBJoins = await fetchJson(pageB, '/api/presence');
console.log('presence row for builder A, fetched as builder B:', presenceBeforeBJoins.body);
const aRowSeenByB = presenceBeforeBJoins.body.avatars?.find((a) => a.builderId === builderA.builderId);

// Builder B enters Shop mode too — another random spawn (#1175), same
// lándlet, frozen the same way A's was above. Same reload-not-click
// reasoning as builder A above (B's own 'build' entry opened its own claim
// modal too, for its own still-unclaimed account).
await pageB.reload({ waitUntil: 'networkidle' });
await pageB.waitForSelector('#shop-fly-btn.visible', { timeout: 15000 });
await pageB.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });
await pageB.click('#shop-fly-btn'); // freezes B's position (stops the orbit) and starts landing — see #1175 comment above
// #2043: same reasoning as A's own freeze sequence above — B also spawns
// already flying, so this one tap lands it; wait past the fixed landing
// duration before B is genuinely grounded (and thus visible to A).
await pageB.waitForTimeout(2500); // past SHOP_FLIGHT_LANDING_DURATION_S (2s) -- now 'grounded'

// Give both sides' poll loops (SHOP_PRESENCE_POLL_INTERVAL_MS = 1000) a
// couple of cycles to actually pick each other up and update the
// window.__shopOtherAvatars diagnostic (refreshOtherShopAvatarsDiagnostic).
await pageA.waitForTimeout(3000);
await pageB.waitForTimeout(500); // B's own first poll already overlapped the wait above



const bUsername = (await fetchJson(pageB, '/api/auth/me')).body.user.username;
const ASSISTANT_NAME = 'Juniper';
execSync(
  `npx wrangler d1 execute higglehaven-db --local --command "UPDATE users SET is_fleet = 1, username = '${ASSISTANT_NAME}' WHERE username = '${bUsername.replace(/'/g, "''")}'"`,
  { cwd: new URL('..', import.meta.url).pathname, stdio: 'pipe' },
);
const IDLE_WANDER_RADIUS_M = 1.1; // src/shop/assistantIdle.js
await pageA.waitForFunction(
  () => (window.__testShopOtherAvatarPoses?.() || []).some((p) => p.assistantName),
  null,
  { timeout: 20000 },
);
await pageA.evaluate(() => window.__frameMonitor.reset());

const poseOfAssistant = () => pageA.evaluate(() => (window.__testShopOtherAvatarPoses() || []).find((p) => p.assistantName) || null);
let maxFromSpot = 0;
let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
const headings = new Set();
let samples = 0;
let wandered = false;
// A free assistant walks for a few seconds of each 11 s cycle and faces a new
// way each cycle; sample until it has been seen to move and to turn (at most a
// minute) so the check never depends on where in its cycle the run starts.
for (let ms = 0; ms < 60000 && !(wandered && headings.size > 1); ms += 250) {
  const pose = await poseOfAssistant();
  if (pose) {
    samples += 1;
    maxFromSpot = Math.max(maxFromSpot, Math.hypot(pose.offsetX, pose.offsetY));
    minX = Math.min(minX, pose.offsetX); maxX = Math.max(maxX, pose.offsetX);
    minY = Math.min(minY, pose.offsetY); maxY = Math.max(maxY, pose.offsetY);
    headings.add(pose.heading.toFixed(2));
    wandered = Math.hypot(maxX - minX, maxY - minY) > 0.3;
  }
  await pageA.waitForTimeout(250);
}
const longestFrameMs = await pageA.evaluate(() => Math.round(window.__frameMonitor.longestFrameGapMs()));
const spread = Math.hypot(maxX - minX, maxY - minY);
console.log(`assistant idle: ${samples} samples, moved ${spread.toFixed(2)} m end to end, furthest from its spot ${maxFromSpot.toFixed(2)} m (limit ${IDLE_WANDER_RADIUS_M}), ${headings.size} distinct headings, longest frame ${longestFrameMs} ms`);

// The assistant goes off shift (its account stops reporting: B's browser closes,
// and its presence row goes stale after 10 s). A sees it leave through fog: first
// a departing state with the avatar still there, then gone, never a pop.
await sessionB.browser.close();
let sawDeparting = false;
let gone = false;
for (let ms = 0; ms < 60000 && !gone; ms += 200) {
  const pose = await poseOfAssistant();
  if (pose?.departing) sawDeparting = true;
  gone = pose === null;
  await pageA.waitForTimeout(200);
}
console.log(`assistant departure: saw departing state ${sawDeparting}, avatar gone ${gone}`);

const pass = wandered
  && maxFromSpot <= IDLE_WANDER_RADIUS_M + 0.05
  && headings.size > 1
  && sawDeparting && gone
  && sessionA.errors.length === 0;
await finish(sessionA.browser, {
  pass,
  label: '#3449: an assistant on shift wanders a little around its spot, stays within the wander radius and turns as it goes, and leaves through fog when it goes off shift',
  errors: sessionA.errors,
});

