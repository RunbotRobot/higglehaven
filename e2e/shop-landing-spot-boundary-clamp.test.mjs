// #2080: the #2044 landing-spot-avatar-collision nudge (nearestOpenLandingSpot,
// src/main.js) only checks clearance from other live avatars -- it never
// checks the result against the world boundary (shopAvatarMaxRadiusM) at
// all. The landing branch of updateShopFlight then writes that candidate
// straight into shopAvatarPosition.x/y unconditionally; the only place
// clampShopRadius is otherwise ever called for the avatar is inside
// updateShopMovement, gated on real joystick/WASD input. So a nudge taken
// near the world wall could leave the avatar sitting outside the boundary
// indefinitely, until the player's next move.
//
// Reproduces this via the real landing choreography (click #shop-fly-btn to
// start landing, same deterministic click-then-wait-past-duration pattern
// e2e/flight.test.mjs already uses), with __testTeleportShopAvatar pinning
// the exact landing spot right at the wall and a second, real browser
// session's avatar (driven via a direct POST /api/presence, same technique
// e2e/multiplayer-presence.test.mjs already establishes for precisely
// positioning the other party without racing its own real movement)
// occupying that exact spot -- forcing the nudge to search outward, in the
// one direction (+x, tried first by nearestOpenLandingSpot's own ring
// search) that pushes straight through the wall.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL_A = 'Landing Boundary Clamp Builder A';
const LABEL_B = 'Landing Boundary Clamp Builder B';
const LANDLET_ID = 'landing-boundary-clamp-landlet';

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
    name: 'Landing Boundary Clamp Landlet',
    areaM2: 1000,
    status: 'claimed',
    ownerBuilderId: builderA.builderId,
  }),
});
console.log('landlet created at the default (0,0) center (status should be 201):', landletCreated.status);

await pageA.reload({ waitUntil: 'networkidle' });
await pageA.waitForSelector('#shop-fly-btn.visible', { timeout: 15000 });
await pageA.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });

// shopWorldRadiusM is set once the world finishes loading, independent of
// flight state -- safe to read before A ever lands.
const maxRadiusM = await pageA.evaluate(() => window.__testShopAvatarMaxRadiusM());
console.log('avatar\'s own world-boundary radius (should be a positive number):', maxRadiusM);

// Half a meter inside the wall -- comfortably valid on its own, but close
// enough that the nudge's fixed 1m jump (see below) pushes well past it.
const nearRadiusM = maxRadiusM - 0.5;

// B only needs a real account to own a presence row -- never actually
// enters Shop mode, same "driven entirely via direct POST, not real
// movement" shortcut e2e/multiplayer-presence.test.mjs's own race-test half
// already uses. Positioned at the EXACT spot A is about to teleport its own
// landing to: landingSpotOccupiedByAvatar measures distance from this exact
// point in every direction, so every candidate at the search's first radius
// step (0.5m) ties at exactly that same distance and all come back blocked
// at once, guaranteeing the first candidate that clears clearance is at the
// next radius step (1.0m) in the ring search's own first-tried direction
// (+x, i=0) -- deterministic, not a race against B's own real movement.
await chooseIdentity(pageB, { mode: 'build', label: LABEL_B, isNew: true });
const presencePosted = await fetchJson(pageB, '/api/presence', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ x: nearRadiusM, y: 0, z: 0, heading: 0, landletId: LANDLET_ID }),
});
console.log('B\'s presence posted at A\'s intended landing spot (status should be 200):', presencePosted.status);

// Give A's own poll loop (SHOP_PRESENCE_POLL_INTERVAL_MS = 1000) a couple of
// cycles to pick B up into shopOtherAvatars before A's own landing (2s
// total) gets anywhere near its own final "landed" tick.
await pageA.waitForTimeout(2200);
const othersBeforeLanding = await pageA.evaluate(() => window.__shopOtherAvatars);
const bEntry = othersBeforeLanding?.find((a) => a.builderId !== builderA.builderId);
console.log('B\'s position as polled into A\'s own scene before landing (should match A\'s intended spot):', bEntry);

// Starts landing from A's current (random spawn-orbit) position -- #1175's
// own spawn-flying default means A is already 'flying' with no tap needed
// to get there, so this single tap (same toggleShopFlight mechanism
// e2e/flight.test.mjs exercises) is what actually starts the landing
// descent. toggleShopFlight's own tap handler also calls
// stopShopSpawnRotation() synchronously before anything else, so the
// teleport right after is never raced by the orbit's own per-frame update.
await pageA.click('#shop-fly-btn');
// Mid-landing, x/y are untouched by updateShopFlight's own landing branch
// until the final "landed" tick (only altitude ramps during the descent;
// see that branch's own code) -- safe to pin the exact spot here.
await pageA.evaluate((x) => window.__testTeleportShopAvatar(x, 0), nearRadiusM);

// Past SHOP_FLIGHT_LANDING_DURATION_S (2s) so the "landed" tick (and the
// nudge-and-clamp this issue is about) has actually run.
await pageA.waitForTimeout(2500);
const finalPosition = await pageA.evaluate(() => window.__testShopAvatarPosition());
const finalRadiusM = Math.hypot(finalPosition.x, finalPosition.y);
console.log('A\'s own final landed position (should be nudged away from B, never past the world wall):', finalPosition);
console.log('A\'s own final distance from world center vs. its boundary radius (should be <= boundary, with a small float-rounding allowance):', finalRadiusM, 'vs', maxRadiusM);

const pass =
  landletCreated.status === 201 &&
  presencePosted.status === 200 &&
  !!bEntry &&
  Math.abs(bEntry.x - nearRadiusM) < 0.5 && Math.abs(bEntry.y - 0) < 0.5 &&
  maxRadiusM > 1 && // sane sanity bound -- the nudge math below assumes real room to work with
  finalRadiusM <= maxRadiusM + 0.01 &&
  errors.length === 0;

await sessionB.browser.close();
await finish(sessionA.browser, {
  pass,
  label: '#2080: the landing-spot avatar-collision nudge never pushes the avatar past the world boundary',
  errors,
});
