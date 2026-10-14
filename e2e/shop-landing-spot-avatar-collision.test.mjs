// #2044: a flying avatar's landing spot now offsets to the nearest open
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

const LABEL_A = 'Landing Spot Collision Builder A';
const LABEL_B = 'Landing Spot Collision Builder B';
const LANDLET_ID = 'landing-spot-collision-landlet';

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
    name: 'Landing Spot Collision Landlet',
    areaM2: 1000,
    status: 'claimed',
    ownerBuilderId: builderA.builderId,
  }),
});
console.log('landlet created at the default (0,0) center (status should be 201):', landletCreated.status);

await pageA.reload({ waitUntil: 'networkidle' });
await pageA.waitForSelector('#shop-fly-btn.visible', { timeout: 15000 });
await pageA.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });
await pageA.click('#shop-fly-btn'); // freezes A's position (#1175)
await pageA.waitForTimeout(100);
await pageA.waitForTimeout(2500); // first presence report always fires on its first eligible tick

await chooseIdentity(pageB, { mode: 'build', label: LABEL_B, isNew: true });
const builderB = (await fetchJson(pageB, '/api/builders/me')).body.builder;

await pageB.reload({ waitUntil: 'networkidle' });
await pageB.waitForSelector('#shop-fly-btn.visible', { timeout: 15000 });
await pageB.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });
await pageB.click('#shop-fly-btn'); // freezes B's position (#1175)
await pageB.waitForTimeout(100);

// Give both poll loops (1000ms interval) a couple of cycles to pick each
// other up.
await pageA.waitForTimeout(3000);
await pageB.waitForTimeout(500);

const bOthersSeenByA = await pageA.evaluate(() => window.__shopOtherAvatars);
const bEntryInA = bOthersSeenByA?.find((a) => a.builderId === builderB.builderId);
console.log('B\'s position as rendered in A\'s own scene (should be a real {x, y, ...}):', bEntryInA);

// Case 1: ask for the nearest open spot starting exactly at B's own
// position -- should come back offset away from it, and the offset spot
// itself should no longer read as occupied.
const spotAtB = await pageA.evaluate(([x, y]) => window.__testNearestOpenLandingSpot(x, y), [bEntryInA.x, bEntryInA.y]);
const distanceFromB = Math.hypot(spotAtB.x - bEntryInA.x, spotAtB.y - bEntryInA.y);
console.log('nearest open spot starting exactly at B\'s position (should be offset away from B, roughly 0.5-5m):', spotAtB, 'distance from B:', distanceFromB);

// Case 2: starting well away from B shouldn't move anything at all --
// confirms this doesn't just always nudge the spot regardless of whether
// it's actually occupied.
const farX = bEntryInA.x + 50;
const farY = bEntryInA.y;
const spotFarFromB = await pageA.evaluate(([x, y]) => window.__testNearestOpenLandingSpot(x, y), [farX, farY]);
console.log('nearest open spot starting far from B (should be unchanged):', spotFarFromB, 'expected:', { x: farX, y: farY });

const pass =
  landletCreated.status === 201 &&
  !!bEntryInA &&
  distanceFromB > 0.2 && distanceFromB <= 5.5 &&
  spotFarFromB.x === farX && spotFarFromB.y === farY &&
  errors.length === 0;

await sessionB.browser.close();
await finish(sessionA.browser, {
  pass,
  label: '#2044: a landing spot occupied by another avatar offsets to the nearest open space',
  errors,
});
