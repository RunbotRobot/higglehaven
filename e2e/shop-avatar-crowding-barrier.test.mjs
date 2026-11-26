// #4389 (docs/SPEC.md §2 crowding): walking straight at another person stops
// at the 0.6 m hard barrier instead of passing through, using the same real
// two-session presence setup as shop-landing-spot-avatar-collision.test.mjs.
// #2044 (header kept for the setup): a flying avatar's landing spot now offsets to the nearest open
// space when another avatar is already standing there, the multiplayer-
// presence-dependent half of the spec line #99/#1090 deferred ("occupied
// landing spots offset to nearest open space... nothing to occupy a spot
// with yet") until #1095's real presence existed to collide with.
//
// Reproducing the real descent-and-land choreography precisely enough to
// land exactly on top of a second, independently-moving live avatar would
// be too timing-fragile to be worth it (same reasoning
// e2e/shop-walk-after-landing-on-object.test.mjs's own header comment
// gives for the sibling #1090/#1829 case) -- instead this drives the real
// production search function directly via a dedicated test hook
// (window.__testNearestOpenLandingSpot, same "teleport + force the real
// per-frame logic" convention as that sibling test), against a REAL
// second browser session's own live-reported position (not a synthetic
// stand-in), using the exact two-session multiplayer-presence setup
// e2e/multiplayer-presence.test.mjs already established.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL_A = 'Crowding Builder A';
const LABEL_B = 'Crowding Builder B';
const LANDLET_ID = 'crowding-landlet';

const sessionA = await launchPage({ promptAnswer: LABEL_A });
const sessionB = await launchPage({ promptAnswer: LABEL_B });
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
    name: 'Crowding Landlet',
    areaM2: 1000,
    status: 'claimed',
    ownerBuilderId: builderA.builderId,
  }),
});
console.log('landlet created at the default (0,0) center (status should be 201):', landletCreated.status);

await pageA.reload({ waitUntil: 'networkidle' });
await pageA.waitForSelector('body.shop-ready', { timeout: 15000 });
await pageA.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });
// #2043: every fresh Shop-mode spawn starts already airborne, so this tap
// (toggleShopFlight) starts a real landing, not a no-op freeze -- same
// discovery e2e/multiplayer-presence.test.mjs's own comment documents.
// Flying avatars are withheld from GET /api/presence, so A must wait past
// the landing animation's own fixed duration before it's genuinely
// grounded, same margin that sibling test uses, rather than the original
// 100ms (which would leave A mid-descent).
await pageA.evaluate(() => window.__testToggleShopFlight()); // freezes A's position (#1175) once landed
await pageA.waitForTimeout(2500); // past SHOP_FLIGHT_LANDING_DURATION_S (2s) -- now 'grounded'

await chooseIdentity(pageB, { mode: 'build', label: LABEL_B, isNew: true });
const builderB = (await fetchJson(pageB, '/api/builders/me')).body.builder;

await pageB.reload({ waitUntil: 'networkidle' });
await pageB.waitForSelector('body.shop-ready', { timeout: 15000 });
await pageB.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });
// Same reasoning as A's own landing wait above -- B also spawns already
// flying, so B needs its own dedicated wait past the landing duration too,
// not just the later shared polling waits below (those cover the poll
// loop picking B up once grounded, not B's own landing completing).
await pageB.evaluate(() => window.__testToggleShopFlight()); // freezes B's position (#1175) once landed
await pageB.waitForTimeout(2500); // past SHOP_FLIGHT_LANDING_DURATION_S (2s) -- now 'grounded'

// Give both poll loops (1000ms interval) a couple of cycles to pick each
// other up.
await pageA.waitForTimeout(3000);
await pageB.waitForTimeout(500);

const bOthersSeenByA = await pageA.evaluate(() => window.__shopOtherAvatars);
const bEntryInA = bOthersSeenByA?.find((a) => a.builderId === builderB.builderId);
console.log('B\'s position as rendered in A\'s own scene (should be a real {x, y, ...}):', bEntryInA);


// Walk A straight at B in small real steps (the exact move the joystick makes).
const result = await pageA.evaluate(async ([bx, by]) => {
  const start = window.__testShopAvatarPosition();
  const startDist = Math.hypot(bx - start.x, by - start.y);
  // 0.05 m a step: enough steps to cross the whole landlet (the two avatars spawn at random places in it, 13 to 18 m apart
  // in a third of the runs, and 200 steps only walk 10 m, so the walk ended in the open and the file failed on the spawn).
  for (let i = 0; i < 1000; i++) {
    const p = window.__testShopAvatarPosition();
    const d = Math.hypot(bx - p.x, by - p.y);
    if (d < 1e-6) break;
    window.__testMoveShopAvatarWithCollision(((bx - p.x) / d) * 0.05, ((by - p.y) / d) * 0.05);
  }
  const end = window.__testShopAvatarPosition();
  return { startDist, endDist: Math.hypot(bx - end.x, by - end.y) };
}, [bEntryInA.x, bEntryInA.y]);
console.log('walked A at B:', result);

const errors = [...sessionA.errors, ...sessionB.errors];
const floor = Math.min(result.startDist, 0.6) - 0.02;
const pass = landletCreated.status === 201 && !!bEntryInA && result.endDist >= floor && result.endDist < 1.2 && errors.length === 0;

await sessionB.browser.close();
await finish(sessionA.browser, { pass, label: '#4389: walking at another avatar stops at the hard barrier', errors });
