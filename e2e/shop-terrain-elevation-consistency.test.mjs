// #2852: #2851 (migrations/0163) lifted Shop mode's own ground mesh by a
// landlet's real elevationM (src/shop/mode.js) but left every placed
// item's own mesh.position.z -- and the landing/collision code that reads
// it (shopPositionBlocked/shopLandingObstructionTopZ/
// findShopIdleInteractionTarget, plus a landing's own bare-ground resting
// height) -- at the old flat-baseline value. On any landlet with a real
// nonzero elevation, the ground would render at its real height while
// every item on it (and an avatar resting on bare ground) stayed stranded
// at the pre-#2851 flat baseline, floating above or sinking below the
// ground around them.
//
// Fixed by moving the elevation lift onto entry.group.position.z itself
// (so every child -- ground mesh, every placed item -- rides along with
// it) and adding that same term everywhere flightMovement.js had read
// mesh.position.z without it.
//
// #2853 update: shopLandingObstructionTopZ (itemTop below) is an absolute
// world z, unchanged by #2853, so it still tracks elevationM 1:1 exactly as
// this test originally asserted. bareGroundAltitudeM (groundFloor below) is
// not a world z, though -- it's the *altitude* a landing needs to reach to
// rest on bare ground, and #2853's own per-frame sync now adds a landlet's
// elevationM back in separately via shopTerrainHeightAtM when turning that
// altitude into a real z. bareGroundAltitudeM has to subtract that same
// term to avoid double-counting elevationM (see its own comment), so by
// design it now stays constant regardless of elevationM -- the ground's
// real z still rises by elevationM, just via that other route instead of
// through this helper's own return value. See
// e2e/shop-terrain-elevation-landing.test.mjs for the real-z-level check
// (a full takeoff/landing sequence) that this altitude-level helper no
// longer directly proves on its own.
//
// This directly exercises the real production functions via the e2e-only
// window.__testBareGroundAltitudeM/__testShopLandingObstructionTopZ hooks
// (same convention window.__testNearestOpenLandingSpot already
// established) rather than reproducing a full real-time flight landing --
// same reasoning e2e/shop-walk-after-landing-on-object.test.mjs's own
// header comment gives for why driving the exact boundary condition
// through a test hook beats choreographing imprecise real-time flight.
//
// A fresh/never-reclassified landlet (e.g. the real starter-landlet) has
// elevation_m = NULL (#2850's own nullability, before this leaf's own
// migration), which resolves to elevationM: 0 over the API -- making the
// "before" half of this test a real, unmodified zero-elevation baseline,
// not a fabrication. The "after" half writes a real nonzero elevation_m
// directly via `wrangler d1 execute --local` against the exact same
// `.wrangler/state` this test's own already-running `wrangler dev --local`
// reads from -- there is no other way to drive a real elevation value
// through this deployment, which never runs real USGS-backed generation
// for a test-claimed landlet.
import { execSync } from 'node:child_process';
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Shop Terrain Elevation Tester';
const TEST_ELEVATION_M = 7.5;

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

async function fetchJson(path, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [path, options]);
}

// Same placeholder-tree precedent e2e/shop-walk-after-landing-on-object.test.mjs
// uses (and the same reasoning: no modelUrl, so createMeshForInstance
// resolves synchronously via the plain-box fallback).
await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
await page.waitForTimeout(300);
await page.mouse.click(210, 400);
await page.waitForTimeout(800);

const { landlets } = (await fetchJson('/api/landlets?limit=100')).body;
const myLandlet = landlets.find((l) => l.ownerBuilderId);
const { instances } = (await fetchJson(`/api/instances?landletId=${myLandlet.landletId}`)).body;
const treeInstance = instances.find((i) => i.templateId === 'placeholder-tree');
const { template: treeTemplate } = (await fetchJson('/api/catalog/placeholder-tree')).body;
const treeWorldX = myLandlet.center.x + treeInstance.x;
const treeWorldY = myLandlet.center.y + treeInstance.y;

console.log('elevationM on the freshly-claimed, never-reclassified landlet (should be falsy/0 -- #2850 nullability):', myLandlet.elevationM);

async function enterShopAndForceLoad() {
  await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: false });
  await page.waitForSelector('#shop-fly-btn.visible', { timeout: 10000 });
  await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });
  await page.evaluate(([x, y]) => {
    window.__testTeleportShopAvatar(x, y);
    window.__testForceShopProximityCheck();
  }, [myLandlet.center.x, myLandlet.center.y]);
  await page.waitForTimeout(500);
}

await enterShopAndForceLoad();
const groundFloorBefore = await page.evaluate(
  ([x, y]) => window.__testBareGroundAltitudeM(x, y),
  [myLandlet.center.x, myLandlet.center.y],
);
const itemTopBefore = await page.evaluate(
  ([x, y]) => window.__testShopLandingObstructionTopZ(x, y),
  [treeWorldX, treeWorldY],
);
console.log('bare-ground floor / tree top, before setting a real elevation (should both reflect zero elevation):', { groundFloorBefore, itemTopBefore });

// The one real way to drive a nonzero elevation_m through this deployment
// for a test-claimed landlet -- see this file's own header comment.
execSync(
  `npx wrangler d1 execute higglehaven-db --local --command "UPDATE landlets SET elevation_m = ${TEST_ELEVATION_M} WHERE landlet_id = '${myLandlet.landletId}'"`,
  { cwd: new URL('..', import.meta.url).pathname, stdio: 'pipe' },
);

// A fresh page load re-fetches /api/landlets for real, picking up the
// elevation_m just written -- same "reload to pick up a server-side change
// with no client-side cache to bust" pattern e2e/friend-voice-channel.test.mjs's
// own enterShopGrounded helper already uses for a different field.
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1000);
await enterShopAndForceLoad();

const groundFloorAfter = await page.evaluate(
  ([x, y]) => window.__testBareGroundAltitudeM(x, y),
  [myLandlet.center.x, myLandlet.center.y],
);
const itemTopAfter = await page.evaluate(
  ([x, y]) => window.__testShopLandingObstructionTopZ(x, y),
  [treeWorldX, treeWorldY],
);
console.log(`bare-ground floor (altitude, should stay ~unchanged -- see #2853 update above) / tree top (world z, should have risen by exactly ${TEST_ELEVATION_M}), after setting elevation_m = ${TEST_ELEVATION_M}:`, { groundFloorAfter, itemTopAfter });

const groundDelta = groundFloorAfter - groundFloorBefore;
const itemDelta = itemTopAfter - itemTopBefore;
console.log('ground floor altitude delta (should be ~0 post-#2853 -- elevationM is handled elsewhere now) / item top world-z delta (should equal TEST_ELEVATION_M):', { groundDelta, itemDelta, TEST_ELEVATION_M });

const pass =
  !myLandlet.elevationM &&
  Math.abs(groundDelta) < 0.01 &&
  Math.abs(itemDelta - TEST_ELEVATION_M) < 0.01 &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: '#2852: a landlet\'s real elevation lifts its ground AND its placed items together, not just the ground',
  errors,
});
